// pi-wasm js-shell — command-line parser (pi-wasm S10, bead bd-ef8f24).
//
// A tiny, browser-clean (zero node builtins) parser for the subset of POSIX
// shell grammar the js-shell reference ExecBackend supports: word splitting with
// single/double quotes + backslash escapes, pipelines (`|`), sequence/AND/OR
// connectors (`;` `&&` `||`), and stdout redirects (`>` `>>`). It intentionally
// does NOT implement subshells, globbing, variable expansion, here-docs, or
// stderr redirects — those are follow-ups; the goal is a correct, well-tested
// core that proves the exec-backend seam.
//
// Parsing NEVER throws: a malformed line yields `{ ok: false, error }` which the
// shell surfaces as a nonzero-exit stderr message (not an infra ExecutionError).

export type ConnectOp = ";" | "&&" | "||";

export interface Redirect {
  readonly op: ">" | ">>";
  readonly target: string;
}

export interface SimpleCommand {
  /** argv[0] is the command name; [] for an empty command (e.g. a lone redirect). */
  readonly argv: string[];
  readonly redirects: Redirect[];
}

export interface Pipeline {
  /** One or more commands joined by `|`. */
  readonly commands: SimpleCommand[];
}

export interface CommandLine {
  readonly first: Pipeline;
  readonly rest: ReadonlyArray<{ op: ConnectOp; pipeline: Pipeline }>;
}

export type ParseResult =
  | { ok: true; value: CommandLine }
  | { ok: false; error: string };

type Token =
  | { kind: "word"; value: string }
  | { kind: "op"; value: ConnectOp | "|" | ">" | ">>" };

const OPERATOR_TOKENS: ReadonlyArray<ConnectOp | "|" | ">" | ">>"> = ["&&", "||", ";", "|", ">>", ">"];

/**
 * Tokenize a command line into words + operators. Handles '…' (literal),
 * "…" (literal; no expansion in this MVP), and \x escapes outside single quotes.
 * Returns an error string on an unterminated quote.
 */
export function tokenize(line: string): { ok: true; value: Token[] } | { ok: false; error: string } {
  const tokens: Token[] = [];
  let i = 0;
  const n = line.length;

  // Accumulator for the current word + whether the current run has produced any
  // word characters at all (so `""` becomes an empty-string word, not nothing).
  let word = "";
  let wordActive = false;

  const flushWord = () => {
    if (wordActive) {
      tokens.push({ kind: "word", value: word });
      word = "";
      wordActive = false;
    }
  };

  while (i < n) {
    const c = line[i];

    // Whitespace ends a word.
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      flushWord();
      i += 1;
      continue;
    }

    // Operators (longest match first) — only recognized outside quotes.
    let matchedOp: (ConnectOp | "|" | ">" | ">>") | undefined;
    for (const op of OPERATOR_TOKENS) {
      if (line.startsWith(op, i)) {
        matchedOp = op;
        break;
      }
    }
    if (matchedOp) {
      flushWord();
      tokens.push({ kind: "op", value: matchedOp });
      i += matchedOp.length;
      continue;
    }

    // Single quotes: everything literal until the next single quote.
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) return { ok: false, error: "syntax error: unterminated single quote" };
      word += line.slice(i + 1, end);
      wordActive = true;
      i = end + 1;
      continue;
    }

    // Double quotes: literal (no expansion in this MVP) but honor \" and \\.
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      let closed = false;
      while (j < n) {
        const cj = line[j];
        if (cj === "\\" && j + 1 < n && (line[j + 1] === '"' || line[j + 1] === "\\")) {
          buf += line[j + 1];
          j += 2;
          continue;
        }
        if (cj === '"') {
          closed = true;
          break;
        }
        buf += cj;
        j += 1;
      }
      if (!closed) return { ok: false, error: "syntax error: unterminated double quote" };
      word += buf;
      wordActive = true;
      i = j + 1;
      continue;
    }

    // Backslash escape outside quotes: next char is literal.
    if (c === "\\" && i + 1 < n) {
      word += line[i + 1];
      wordActive = true;
      i += 2;
      continue;
    }

    // Ordinary word character.
    word += c;
    wordActive = true;
    i += 1;
  }
  flushWord();
  return { ok: true, value: tokens };
}

/** Parse a tokenized line into a CommandLine AST. */
function parseTokens(tokens: Token[]): ParseResult {
  // Split the token stream on the connectors ; && || into pipeline-token runs.
  const segments: Array<{ op: ConnectOp | "start"; tokens: Token[] }> = [{ op: "start", tokens: [] }];
  for (const tok of tokens) {
    if (tok.kind === "op" && (tok.value === ";" || tok.value === "&&" || tok.value === "||")) {
      segments.push({ op: tok.value, tokens: [] });
    } else {
      segments[segments.length - 1].tokens.push(tok);
    }
  }

  const pipelines: Array<{ op: ConnectOp | "start"; pipeline: Pipeline }> = [];
  for (const seg of segments) {
    // A trailing connector (e.g. `a ;`) yields a final empty segment — allowed,
    // treated as a no-op (skipped) rather than an error, matching lenient shells.
    if (seg.tokens.length === 0) {
      if (seg.op === "start") continue; // leading empty (e.g. whitespace-only line)
      continue;
    }
    const pipeline = parsePipeline(seg.tokens);
    if (!pipeline.ok) return pipeline;
    pipelines.push({ op: seg.op, pipeline: pipeline.value });
  }

  if (pipelines.length === 0) {
    return { ok: true, value: { first: { commands: [] }, rest: [] } };
  }
  const [head, ...tail] = pipelines;
  return {
    ok: true,
    value: {
      first: head.pipeline,
      rest: tail.map((p) => ({ op: p.op as ConnectOp, pipeline: p.pipeline })),
    },
  };
}

function parsePipeline(tokens: Token[]): { ok: true; value: Pipeline } | { ok: false; error: string } {
  const commands: SimpleCommand[] = [];
  let argv: string[] = [];
  let redirects: Redirect[] = [];
  let pendingRedirect: ">" | ">>" | undefined;

  const flushCommand = () => {
    commands.push({ argv, redirects });
    argv = [];
    redirects = [];
  };

  for (const tok of tokens) {
    if (tok.kind === "op" && tok.value === "|") {
      if (pendingRedirect) return { ok: false, error: "syntax error near `|`: expected redirect target" };
      if (argv.length === 0 && redirects.length === 0) {
        return { ok: false, error: "syntax error near `|`: empty command" };
      }
      flushCommand();
      continue;
    }
    if (tok.kind === "op" && (tok.value === ">" || tok.value === ">>")) {
      if (pendingRedirect) return { ok: false, error: "syntax error: expected redirect target" };
      pendingRedirect = tok.value;
      continue;
    }
    // A word.
    if (pendingRedirect) {
      redirects.push({ op: pendingRedirect, target: tok.value });
      pendingRedirect = undefined;
      continue;
    }
    argv.push(tok.value);
  }
  if (pendingRedirect) return { ok: false, error: "syntax error: expected redirect target" };
  if (argv.length === 0 && redirects.length === 0) {
    return { ok: false, error: "syntax error: empty command in pipeline" };
  }
  flushCommand();
  return { ok: true, value: { commands } };
}

/** Parse a command line. Never throws. */
export function parse(line: string): ParseResult {
  const toks = tokenize(line);
  if (!toks.ok) return toks;
  return parseTokens(toks.value);
}
