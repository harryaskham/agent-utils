// Fork lanes (bd-fd98a3): a fork made by /clone or /git wt fork can be told what it is for and
// what it may do, so nobody types it by hand: `focus=TEXT` (its lane) and `mode=work|qa`
// (work: it may edit; qa: it answers questions and refuses edits). The fork gets a fixed role
// note, the original a short notice that a fork took that lane, and the fork's editor chip shows
// the lane. Hosts and commands live elsewhere (fork-lane-extension.js for TUI Pi, durable-git.js
// for pi-daemon, git-client.js and editor-chips for pi-client); this is the policy they share.

/** The lane modes. */
export const LANE_MODES = Object.freeze(["work", "qa"]);
/** TUI Pi: the fork's role note, a custom message whose `details` is its lane. */
export const LANE_ENTRY = "agent-utils.fork-lane";
/** TUI Pi: the original's notice that a fork took a lane, a custom message. */
export const LANE_NOTICE_ENTRY = "agent-utils.fork-notice";
/** pi-daemon: the key of the lane in pi-git's module state (pi-daemon.module-state, "git"). */
export const LANE_STATE_KEY = "lane";
/** Tools a qa fork does not have (pi-daemon) or is refused (TUI Pi). */
export const QA_BLOCKED_TOOLS = Object.freeze(["edit", "write"]);
/** Longest focus kept; longer text is cut. */
export const MAX_FOCUS_CHARS = 200;

const LANE_KEYS = new Set(["focus", "mode"]);

/**
 * A command's words, split at whitespace outside quotes: `focus="harbour-qs Q&A"` is one word,
 * `focus=harbour-qs Q&A` two. Quotes are removed; nothing is expanded.
 */
export function splitWords(text) {
  const words = [];
  let word = "";
  let quote = null;
  let started = false;
  for (const char of String(text ?? "")) {
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}

/** A word splitWords reads back as itself: quoted when it has spaces or quotes (a `"` becomes `'`). */
export function quoteWord(text) {
  const word = String(text ?? "");
  return /^[^\s"']+$/.test(word) ? word : `"${word.replace(/"/g, "'")}"`;
}

const oneLine = (text) => String(text ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Take `focus=…` and `mode=…` out of a command's words: `{ words, lane }`, `lane` undefined when
 * neither is there, or `{ words, error }`. A focus without a mode is a work lane.
 */
export function takeLane(words) {
  const rest = [];
  const found = {};
  for (const word of words) {
    const match = /^([a-z]+)=([\s\S]*)$/.exec(word);
    if (!match || !LANE_KEYS.has(match[1])) {
      rest.push(word);
      continue;
    }
    const [, key, value] = match;
    if (key in found) return { words, error: `${key}= is given twice` };
    found[key] = value;
  }
  if (!("focus" in found) && !("mode" in found)) return { words: rest };
  const mode = "mode" in found ? found.mode.trim().toLowerCase() : "work";
  if (!LANE_MODES.includes(mode)) return { words, error: `mode= is work or qa, not ${JSON.stringify(found.mode)}` };
  const focus = "focus" in found ? oneLine(found.focus).slice(0, MAX_FOCUS_CHARS) : "";
  if ("focus" in found && focus === "") return { words, error: "focus= needs text (quote it when it has spaces: focus=\"a b\")" };
  return { words: rest, lane: { mode, ...(focus ? { focus } : {}) } };
}

/** A lane as it travels and is kept: mode, focus, where it came from and when; anything else dropped. */
export function normalizeLane(value) {
  if (!value || typeof value !== "object" || !LANE_MODES.includes(value.mode)) return undefined;
  const text = (item, max = 4096) => (typeof item === "string" && oneLine(item) ? oneLine(item).slice(0, max) : undefined);
  const lane = { mode: value.mode };
  const focus = text(value.focus, MAX_FOCUS_CHARS);
  if (focus) lane.focus = focus;
  const from = value.from && typeof value.from === "object" ? value.from : undefined;
  if (from) {
    const kept = {};
    for (const key of ["sessionId", "title", "cwd", "host"]) {
      const item = text(from[key]);
      if (item) kept[key] = item;
    }
    if (Object.keys(kept).length > 0) lane.from = kept;
  }
  for (const key of ["cwd", "branch", "host"]) {
    const item = text(value[key]);
    if (item) lane[key] = item;
  }
  if (value.shared === true) lane.shared = true;
  if (value.restricted === true) lane.restricted = true;
  if (Number.isFinite(Number(value.at)) && Number(value.at) > 0) lane.at = Number(value.at);
  return lane;
}

/** How a lane is said in one line: `qa · harbour-qs`, `work`. */
export function laneSummary(lane) {
  if (!lane) return "";
  return lane.focus ? `${lane.mode} · ${lane.focus}` : lane.mode;
}

const quoted = (text) => `"${String(text).replace(/"/g, "'")}"`;

/**
 * The fork's role note, a fixed text: what it is, that the original goes on with its own task,
 * its lane, and what it may change. `lane` is normalizeLane's: `from` the original (title, cwd),
 * `cwd` the fork's directory, `branch` its worktree's branch, `shared` when it shares the
 * original's directory, `restricted` when its host took its edit tools away.
 */
export function forkRoleNote(lane) {
  const from = lane.from?.title ? ` ${quoted(lane.from.title)}` : "";
  const lines = [
    `[Fork lane: mode=${lane.mode}${lane.focus ? ` · focus: ${lane.focus}` : ""}]`,
    `You are a fork of the session${from}: this conversation was copied into a new session for its own lane. The original session carries on with its own task; do not continue that task here.`,
    lane.focus ? `Your lane: ${lane.focus}.` : lane.mode === "qa" ? "Your lane: answer the user's questions." : "Your lane: what the user asks of you here, not the original's task.",
  ];
  const where = lane.shared
    ? `You share the working directory${lane.cwd ? ` ${lane.cwd}` : ""} with the original session, which is still working in it.`
    : lane.cwd
      ? `You work in ${lane.cwd}${lane.branch ? ` on branch ${lane.branch}` : ""}${lane.from?.cwd && lane.from.cwd !== lane.cwd ? `; the original stays in ${lane.from.cwd}` : ""}.`
      : "";
  if (lane.mode === "qa") {
    lines.push(
      [
        "You are read-only (mode=qa): do not edit, write, move or delete files, and do not change git state (no commits, checkouts, stashes, resets, merges or pushes).",
        where,
        "Reading files and running read-only commands is fine. If asked to change something, say what you would change and leave it to the original session or a work fork.",
        lane.restricted ? "The edit and write tools are not available in this session." : "Edits are refused in this session.",
      ].filter(Boolean).join(" "),
    );
  } else {
    lines.push(
      [
        "You may edit files (mode=work).",
        where,
        lane.shared ? "Change only what your lane needs, leave the original's changes alone, and commit only your own." : "",
      ].filter(Boolean).join(" "),
    );
  }
  return lines.join("\n");
}

/** The original's notice: a fork took this lane, so it carries on with its own task. */
export function originalNotice(lane, fork = {}) {
  const name = fork.title ? ` as session ${quoted(fork.title)}` : "";
  const place = lane.shared ? " in this same directory" : fork.cwd ? ` in ${fork.cwd}${fork.host ? ` on ${fork.host}` : ""}` : "";
  const what = lane.mode === "qa" ? "read-only, for questions" : "it may edit";
  const lines = [
    `[Forked: a copy of this conversation continues${name}${place}, in its own lane: mode=${lane.mode} (${what})${lane.focus ? ` · focus: ${lane.focus}` : ""}. The fork takes only that lane; carry on with your own task here.]`,
  ];
  if (lane.mode === "work" && lane.shared) lines.push("It may change files in this directory too: leave its lane's changes to it.");
  return lines.join(" ");
}

/** The latest lane on a TUI Pi session's branch (its LANE_ENTRY messages), or undefined. */
export function laneFromEntries(entries) {
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom_message" && entry.customType === LANE_ENTRY) return normalizeLane(entry.details);
  }
  return undefined;
}

// ---- qa: refusing edits ----

const READ_ONLY_TARGET = /^(?:\/dev\/|\/tmp\/|\/private\/tmp\/|\$TMPDIR\/|\$\{TMPDIR\}\/)/;
const WRITING_COMMANDS = new Set(["rm", "rmdir", "mv", "cp", "touch", "mkdir", "truncate", "ln", "chmod", "chown", "patch", "install", "dd", "unlink", "shred", "rsync"]);
const GIT_WRITES = new Set([
  "add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm", "switch", "worktree",
]);
const WRAPPERS = new Set(["sudo", "env", "command", "nice", "nohup", "time", "exec", "xargs"]);

/** A shell command with its quoted strings and heredoc bodies left out (what remains is the shape). */
function shellShape(command) {
  const lines = String(command ?? "").split("\n");
  const kept = [];
  let heredoc = null;
  for (const line of lines) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    kept.push(line);
    const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
    if (match) heredoc = match[2];
  }
  return kept.join("\n").replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Why a qa fork refuses this bash command, or undefined. Best effort, for commands that plainly
 * change files or git state outside /tmp: output redirected to a file, `tee FILE`, `sed -i`,
 * `perl -i`, rm/mv/cp/touch/mkdir/… on paths outside /tmp, and git commands that change the
 * work tree, index or refs. Builds, tests and reads pass.
 */
export function qaBashRefusal(command) {
  const shape = shellShape(command);
  for (const match of shape.matchAll(/(?:^|[^<>&\d])\d?>>?\|?\s*(?!&)([^\s;&|<>()]+)/g)) {
    if (!READ_ONLY_TARGET.test(match[1])) return `it writes to ${match[1]}`;
  }
  for (const segment of shape.split(/\|\||&&|[;|&\n()`]|\$\(/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || WRAPPERS.has(words[0]))) words.shift();
    const [name = "", ...args] = words;
    const program = name.split("/").pop();
    const paths = args.filter((arg) => !arg.startsWith("-"));
    if (program === "git") {
      const sub = args.find((arg, index) => !arg.startsWith("-") && !["-C", "-c"].includes(args[index - 1]));
      if (sub === "stash" && !["list", "show"].includes(args[args.indexOf(sub) + 1])) return "git stash changes the work tree";
      if (sub === "branch" && args.some((arg) => /^-(?:[dDmMcC]|-delete|-move|-copy|-force)/.test(arg))) return "git branch changes refs";
      if (sub === "tag" && paths.length > 1 && !args.some((arg) => /^-(?:l|-list|v|-verify)$/.test(arg))) return "git tag changes refs";
      if (GIT_WRITES.has(sub)) return `git ${sub} changes the work tree, index or refs`;
      continue;
    }
    if (program === "sed" && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return "sed -i edits files";
    if (program === "perl" && args.some((arg) => /^-[a-zA-Z]*i/.test(arg))) return "perl -i edits files";
    if (program === "tee" && paths.some((path) => !READ_ONLY_TARGET.test(path))) return `tee writes to ${paths.find((path) => !READ_ONLY_TARGET.test(path))}`;
    if (WRITING_COMMANDS.has(program) && (paths.length === 0 || paths.some((path) => !READ_ONLY_TARGET.test(path)))) return `${program} changes files`;
  }
  return undefined;
}

/** Why a qa fork refuses this tool call, or undefined: edit and write always, bash when qaBashRefusal says so. */
export function qaToolRefusal(toolName, input, lane) {
  const where = lane?.from?.title ? `the original session (${lane.from.title})` : "the original session";
  const tail = `This is a qa fork (mode=qa): it answers questions and makes no edits. Say what you would change and leave it to ${where} or a work fork.`;
  if (QA_BLOCKED_TOOLS.includes(toolName)) return `Refused: ${toolName} edits files. ${tail}`;
  if (toolName === "bash") {
    const why = qaBashRefusal(input?.command);
    if (why) return `Refused: ${why}. ${tail}`;
  }
  return undefined;
}

/**
 * The built-in tools a qa fork keeps, by a pi-daemon agent's resolved extensions (its
 * `builtin-tools`, and `codemode` when it has it): undefined when they cannot be told, so the
 * session is made with its profile's tools.
 */
export function qaToolNames(agent) {
  const extensions = Array.isArray(agent?.extensions) ? agent.extensions : undefined;
  const builtin = extensions?.find((extension) => extension?.name === "builtin-tools");
  if (!Array.isArray(builtin?.tools)) return undefined;
  const names = builtin.tools.map((tool) => tool?.name).filter((name) => typeof name === "string" && !QA_BLOCKED_TOOLS.includes(name));
  if (extensions.some((extension) => extension?.name === "codemode")) names.push("codemode");
  return [...new Set(names)];
}
