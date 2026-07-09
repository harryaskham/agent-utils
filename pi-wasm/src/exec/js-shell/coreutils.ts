// pi-wasm js-shell — coreutils builtins (pi-wasm S10, bead bd-ef8f24).
//
// Each builtin is `(io: CommandIO) => Promise<CommandOutcome>` and operates over
// the shared ExecutionEnv via `io.fs` (absolute paths) + `io.cwd`. Builtins
// NEVER throw: filesystem failures become stderr + a nonzero exit code (the unix
// convention), which the backend surfaces as `ok:true` with exitCode≠0 — only
// genuine infra faults become an ExecutionError higher up.
//
// Scope is a correct, well-tested core (echo/pwd/cd/ls/cat/mkdir/rm/touch/head/
// tail/wc/grep/true/false) — enough to prove the exec-backend seam and cover the
// S10 acceptance (`ls -la /work && cat file`). More builtins can be added by
// registering here without touching the parser or runner.

import {
  type Builtin,
  type CommandIO,
  type CommandOutcome,
  fileErrorText,
  resolveArg,
} from "./types";

function outcome(stdout = "", stderr = "", exitCode = 0, newCwd?: string): CommandOutcome {
  return { stdout, stderr, exitCode, newCwd };
}

/** Split a "flags + operands" argv (argv[1..]) — combined short flags (-la) split. */
function splitFlags(args: string[], flagsTakingValue: ReadonlySet<string> = new Set()): {
  flags: Set<string>;
  values: Map<string, string>;
  operands: string[];
} {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: string[] = [];
  let sawDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (sawDoubleDash) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      sawDoubleDash = true;
      continue;
    }
    if (arg.length > 1 && arg.startsWith("-") && !/^-\d/.test(arg)) {
      // Combined short flags; a flag that takes a value consumes the rest of the
      // token (e.g. -n5) or the next token (e.g. -n 5).
      const chars = arg.slice(1).split("");
      for (let c = 0; c < chars.length; c += 1) {
        const f = `-${chars[c]}`;
        if (flagsTakingValue.has(f)) {
          const inline = chars.slice(c + 1).join("");
          if (inline.length > 0) {
            values.set(f, inline);
          } else if (i + 1 < args.length) {
            values.set(f, args[i + 1]);
            i += 1;
          }
          break;
        }
        flags.add(f);
      }
      continue;
    }
    operands.push(arg);
  }
  return { flags, values, operands };
}

/** Split file content into lines, dropping the empty element after a trailing "\n". */
function toLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Read the text sources for a file-or-stdin command; collects per-file errors. */
async function readSources(
  io: CommandIO,
  operands: string[],
  cmd: string,
): Promise<{ sources: Array<{ name: string; text: string }>; stderr: string; hadError: boolean }> {
  const sources: Array<{ name: string; text: string }> = [];
  let stderr = "";
  let hadError = false;
  if (operands.length === 0) {
    sources.push({ name: "-", text: io.stdin });
    return { sources, stderr, hadError };
  }
  for (const operand of operands) {
    if (operand === "-") {
      sources.push({ name: "-", text: io.stdin });
      continue;
    }
    const abs = resolveArg(io, operand);
    const r = await io.fs.readTextFile(abs);
    if (!r.ok) {
      stderr += `${cmd}: ${operand}: ${fileErrorText(r.error.code)}\n`;
      hadError = true;
      continue;
    }
    sources.push({ name: operand, text: r.value });
  }
  return { sources, stderr, hadError };
}

const echo: Builtin = async (io) => {
  let args = io.argv.slice(1);
  let trailingNewline = true;
  if (args[0] === "-n") {
    trailingNewline = false;
    args = args.slice(1);
  }
  return outcome(args.join(" ") + (trailingNewline ? "\n" : ""));
};

const pwd: Builtin = async (io) => outcome(io.cwd + "\n");

const cd: Builtin = async (io) => {
  const target = io.argv[1] ?? io.env.HOME ?? "/home";
  const abs = resolveArg(io, target);
  const info = await io.fs.fileInfo(abs);
  if (!info.ok) return outcome("", `cd: ${target}: ${fileErrorText(info.error.code)}\n`, 1);
  if (info.value.kind !== "directory") return outcome("", `cd: ${target}: Not a directory\n`, 1);
  return outcome("", "", 0, abs);
};

const trueCmd: Builtin = async () => outcome("", "", 0);
const falseCmd: Builtin = async () => outcome("", "", 1);

function longMode(kind: string): string {
  if (kind === "directory") return "drwxr-xr-x";
  if (kind === "symlink") return "lrwxrwxrwx";
  return "-rw-r--r--";
}

const ls: Builtin = async (io) => {
  const { flags, operands } = splitFlags(io.argv.slice(1));
  const long = flags.has("-l");
  const all = flags.has("-a");
  const targets = operands.length > 0 ? operands : ["."];
  let stdout = "";
  let stderr = "";
  let exit = 0;
  const multi = targets.length > 1;

  for (let t = 0; t < targets.length; t += 1) {
    const operand = targets[t];
    const abs = resolveArg(io, operand);
    const info = await io.fs.fileInfo(abs);
    if (!info.ok) {
      stderr += `ls: cannot access '${operand}': ${fileErrorText(info.error.code)}\n`;
      exit = 2;
      continue;
    }
    if (info.value.kind !== "directory") {
      // A file operand: list the operand itself.
      stdout += long ? `${longMode(info.value.kind)} ${info.value.size} ${operand}\n` : `${operand}\n`;
      continue;
    }
    const listing = await io.fs.listDir(abs);
    if (!listing.ok) {
      stderr += `ls: cannot open directory '${operand}': ${fileErrorText(listing.error.code)}\n`;
      exit = 2;
      continue;
    }
    if (multi) stdout += `${operand}:\n`;
    const entries = listing.value
      .filter((e) => all || !e.name.startsWith("."))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const rows: string[] = [];
    if (all) {
      rows.push(long ? `${longMode("directory")} 0 .` : ".");
      rows.push(long ? `${longMode("directory")} 0 ..` : "..");
    }
    for (const e of entries) {
      rows.push(long ? `${longMode(e.kind)} ${e.size} ${e.name}` : e.name);
    }
    stdout += rows.length > 0 ? rows.join("\n") + "\n" : "";
    if (multi && t < targets.length - 1) stdout += "\n";
  }
  return outcome(stdout, stderr, exit);
};

const cat: Builtin = async (io) => {
  // No flags in this MVP; every operand is a file (or "-" for stdin).
  const { sources, stderr, hadError } = await readSources(io, io.argv.slice(1), "cat");
  const stdout = sources.map((s) => s.text).join("");
  return outcome(stdout, stderr, hadError ? 1 : 0);
};

const mkdir: Builtin = async (io) => {
  const { flags, operands } = splitFlags(io.argv.slice(1));
  const recursive = flags.has("-p");
  let stderr = "";
  let exit = 0;
  for (const operand of operands) {
    const abs = resolveArg(io, operand);
    const r = await io.fs.createDir(abs, { recursive });
    if (!r.ok) {
      stderr += `mkdir: cannot create directory '${operand}': ${fileErrorText(r.error.code)}\n`;
      exit = 1;
    }
  }
  if (operands.length === 0) return outcome("", "mkdir: missing operand\n", 1);
  return outcome("", stderr, exit);
};

const rm: Builtin = async (io) => {
  const { flags, operands } = splitFlags(io.argv.slice(1));
  const recursive = flags.has("-r") || flags.has("-R");
  const force = flags.has("-f");
  let stderr = "";
  let exit = 0;
  for (const operand of operands) {
    const abs = resolveArg(io, operand);
    const info = await io.fs.fileInfo(abs);
    if (!info.ok) {
      if (force && info.error.code === "not_found") continue;
      stderr += `rm: cannot remove '${operand}': ${fileErrorText(info.error.code)}\n`;
      exit = 1;
      continue;
    }
    if (info.value.kind === "directory" && !recursive) {
      stderr += `rm: cannot remove '${operand}': Is a directory\n`;
      exit = 1;
      continue;
    }
    const r = await io.fs.remove(abs, { recursive, force });
    if (!r.ok) {
      stderr += `rm: cannot remove '${operand}': ${fileErrorText(r.error.code)}\n`;
      exit = 1;
    }
  }
  if (operands.length === 0 && !force) return outcome("", "rm: missing operand\n", 1);
  return outcome("", stderr, exit);
};

const touch: Builtin = async (io) => {
  const { operands } = splitFlags(io.argv.slice(1));
  let stderr = "";
  let exit = 0;
  for (const operand of operands) {
    const abs = resolveArg(io, operand);
    const existing = await io.fs.exists(abs);
    if (!existing.ok) {
      stderr += `touch: ${operand}: ${fileErrorText(existing.error.code)}\n`;
      exit = 1;
      continue;
    }
    if (!existing.value) {
      const w = await io.fs.writeFile(abs, "");
      if (!w.ok) {
        stderr += `touch: cannot touch '${operand}': ${fileErrorText(w.error.code)}\n`;
        exit = 1;
      }
    }
  }
  if (operands.length === 0) return outcome("", "touch: missing file operand\n", 1);
  return outcome("", stderr, exit);
};

function makeHeadTail(kind: "head" | "tail"): Builtin {
  return async (io) => {
    const { values, operands } = splitFlags(io.argv.slice(1), new Set(["-n"]));
    const nRaw = values.get("-n");
    const count = nRaw !== undefined && /^\d+$/.test(nRaw) ? Number(nRaw) : 10;
    const { sources, stderr, hadError } = await readSources(io, operands, kind);
    const multi = sources.length > 1;
    let stdout = "";
    for (let s = 0; s < sources.length; s += 1) {
      const src = sources[s];
      const lines = toLines(src.text);
      const picked = kind === "head" ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count));
      if (multi) stdout += `${s > 0 ? "\n" : ""}==> ${src.name} <==\n`;
      if (picked.length > 0) stdout += picked.join("\n") + "\n";
    }
    return outcome(stdout, stderr, hadError ? 1 : 0);
  };
}

const wc: Builtin = async (io) => {
  const { flags, operands } = splitFlags(io.argv.slice(1));
  const wantLines = flags.has("-l");
  const wantWords = flags.has("-w");
  const wantChars = flags.has("-c");
  const none = !wantLines && !wantWords && !wantChars;
  const { sources, stderr, hadError } = await readSources(io, operands, "wc");
  let stdout = "";
  let totalL = 0;
  let totalW = 0;
  let totalC = 0;
  const fmt = (l: number, w: number, c: number, name: string): string => {
    const parts: string[] = [];
    if (none || wantLines) parts.push(String(l));
    if (none || wantWords) parts.push(String(w));
    if (none || wantChars) parts.push(String(c));
    return parts.join(" ") + (name && name !== "-" ? ` ${name}` : "");
  };
  for (const src of sources) {
    const lineCount = (src.text.match(/\n/g) || []).length;
    const wordCount = src.text.split(/\s+/).filter((w) => w.length > 0).length;
    const charCount = src.text.length;
    totalL += lineCount;
    totalW += wordCount;
    totalC += charCount;
    stdout += fmt(lineCount, wordCount, charCount, src.name) + "\n";
  }
  if (sources.length > 1) stdout += fmt(totalL, totalW, totalC, "total") + "\n";
  return outcome(stdout, stderr, hadError ? 1 : 0);
};

const grep: Builtin = async (io) => {
  const { flags, operands } = splitFlags(io.argv.slice(1));
  const ignoreCase = flags.has("-i");
  const invert = flags.has("-v");
  const showLineNo = flags.has("-n");
  if (operands.length === 0) return outcome("", "grep: missing pattern\n", 2);
  const pattern = operands[0];
  const fileOperands = operands.slice(1);
  let matcher: (line: string) => boolean;
  try {
    const re = new RegExp(pattern, ignoreCase ? "i" : "");
    matcher = (line) => re.test(line);
  } catch {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    matcher = (line) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const { sources, stderr, hadError } = await readSources(io, fileOperands, "grep");
  const multi = sources.length > 1;
  let stdout = "";
  let matched = false;
  for (const src of sources) {
    const lines = toLines(src.text);
    for (let i = 0; i < lines.length; i += 1) {
      const isMatch = matcher(lines[i]);
      if (isMatch === invert) continue;
      matched = true;
      let prefix = "";
      if (multi) prefix += `${src.name}:`;
      if (showLineNo) prefix += `${i + 1}:`;
      stdout += prefix + lines[i] + "\n";
    }
  }
  const exit = hadError ? 2 : matched ? 0 : 1;
  return outcome(stdout, stderr, exit);
};

/** The builtin command table. Unknown commands → 127 (handled by the runner). */
export const BUILTINS: Readonly<Record<string, Builtin>> = {
  echo,
  pwd,
  cd,
  true: trueCmd,
  false: falseCmd,
  ls,
  cat,
  mkdir,
  rm,
  touch,
  head: makeHeadTail("head"),
  tail: makeHeadTail("tail"),
  wc,
  grep,
  ":": trueCmd,
};
