// Pi extension: preprocess interactively submitted user text through an arbitrary
// shell pipeline before it reaches the model.
//
//   /pipe cmd="tr '[:lower:]' '[:upper:]'" mode=on
//   /pipe cmd=fix mode=auto
//   /fix on|off|auto
//
// `on` previews the transformed stdout and asks whether to send it, send the
// raw input, or cancel. `auto` sends stdout immediately. The original text is
// restored to the editor on cancellation or command failure.
//
// This extension must load before read-aloud.js. Pi chains input transforms in
// extension order, so /read's on-send hook then speaks the final text selected
// here (transformed for "send", original for "send raw", and nothing on cancel).

import { parseEnvStyleArgs } from "./lib/env-args.js";
import { runBoundedSubprocess } from "./lib/bounded-exec.js";

export const PIPE_MODES = Object.freeze(["on", "off", "auto"]);
export const DEFAULT_PIPE_TIMEOUT_MS = 120_000;
export const PIPE_USAGE =
  'Usage: /pipe cmd=<command> mode=<on|off|auto> (quote commands containing spaces, e.g. cmd="sed \'s/a/b/g\'").';
export const FIX_USAGE = "Usage: /fix <on|off|auto>";

const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

export function normalizePipeMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  return PIPE_MODES.includes(mode) ? mode : undefined;
}

export function resolvePipeTimeoutMs(env = process.env) {
  const value = Number.parseInt(env?.PI_PIPE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_PIPE_TIMEOUT_MS;
}

export function stripPipeOutputTerminator(value) {
  const text = String(value ?? "");
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

function boundedDiagnostic(value, maxChars = 2000) {
  const text = stripPipeOutputTerminator(value).trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…`;
}

/**
 * Run one shell command with the submitted text on stdin. Text is passed through
 * a pipe, never interpolated into the command string; only the operator-provided
 * `cmd=` value is interpreted by the shell.
 */
export async function runPipeCommand(
  command,
  input,
  {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = resolvePipeTimeoutMs(env),
    runSubprocess = runBoundedSubprocess,
  } = {},
) {
  const shellCommand = String(command ?? "").trim();
  if (!shellCommand) throw new Error("no pipe command is configured");

  const submitted = String(input ?? "");
  const stdinText = submitted.endsWith("\n") ? submitted : `${submitted}\n`;
  const result = await runSubprocess({
    command: shellCommand,
    args: [],
    stdio: ["pipe", "pipe", "pipe"],
    spawnOptions: { cwd, env, shell: true },
    timeoutMs,
    label: "/pipe command",
    onSpawn(proc) {
      if (!proc?.stdin?.end) throw new Error("/pipe command stdin is unavailable");
      // A filter may intentionally exit before consuming all input. Ignore a
      // late EPIPE after end(); close/error on the child still determines the
      // command result.
      proc.stdin.on?.("error", () => {});
      proc.stdin.end(stdinText);
    },
  });

  const stdout = result?.stdout?.toString?.("utf8") ?? String(result?.stdout ?? "");
  const stderr = result?.stderr?.toString?.("utf8") ?? String(result?.stderr ?? "");
  if (result?.code !== 0) {
    const diagnostic = boundedDiagnostic(stderr) || boundedDiagnostic(stdout);
    const code = result?.code == null ? "without an exit code" : `with exit code ${result.code}`;
    throw new Error(`command exited ${code}${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return stripPipeOutputTerminator(stdout);
}

/** Parse `/pipe` arguments into either a status request or a partial update. */
export function parsePipeArguments(args) {
  const parsed = parseEnvStyleArgs(String(args ?? ""));
  const unknown = Object.keys(parsed.values).filter((key) => key !== "cmd" && key !== "mode");
  if (unknown.length > 0) throw new Error(`/pipe: unknown setting '${unknown[0]}'. ${PIPE_USAGE}`);

  if (parsed.positionals.length > 0) {
    if (
      parsed.positionals.length === 1 &&
      ["status", "help"].includes(parsed.positionals[0].toLowerCase()) &&
      Object.keys(parsed.values).length === 0
    ) {
      return { kind: "status" };
    }
    if (
      parsed.positionals.length === 1 &&
      normalizePipeMode(parsed.positionals[0]) &&
      !own(parsed.values, "mode")
    ) {
      parsed.values.mode = parsed.positionals[0];
    } else {
      throw new Error(`/pipe: quote cmd values containing spaces. ${PIPE_USAGE}`);
    }
  }

  if (!own(parsed.values, "cmd") && !own(parsed.values, "mode")) return { kind: "status" };

  const update = { kind: "update" };
  if (own(parsed.values, "cmd")) update.command = String(parsed.values.cmd ?? "").trim();
  if (own(parsed.values, "mode")) {
    const mode = normalizePipeMode(parsed.values.mode);
    if (!mode) throw new Error(`/pipe: mode must be on, off, or auto. ${PIPE_USAGE}`);
    update.mode = mode;
  }
  return update;
}

export function applyPipeUpdate(current, update) {
  const next = {
    command: own(update, "command") ? String(update.command ?? "").trim() : String(current?.command ?? ""),
    mode: own(update, "mode") ? normalizePipeMode(update.mode) : normalizePipeMode(current?.mode) || "off",
  };
  if (!next.mode) throw new Error(`/pipe: mode must be on, off, or auto. ${PIPE_USAGE}`);
  if (next.mode !== "off" && !next.command) {
    throw new Error(`/pipe: cmd is required before mode=${next.mode}. ${PIPE_USAGE}`);
  }
  return next;
}

export function formatPipeStatus(config) {
  const mode = normalizePipeMode(config?.mode) || "off";
  const command = String(config?.command ?? "");
  return `pipe:${mode} · cmd:${command || "(none)"}`;
}

function notify(ctx, message, level = "info") {
  try { ctx?.ui?.notify?.(message, level); } catch {}
}

function restoreEditor(ctx, text) {
  try { ctx?.ui?.setEditorText?.(String(text ?? "")); } catch {}
}

function setPipeStatus(ctx, config, running = false) {
  try {
    if (running) {
      ctx?.ui?.setStatus?.("pipe", `/pipe · running ${config.command}`);
    } else if (config.mode === "off") {
      ctx?.ui?.setStatus?.("pipe", undefined);
    } else {
      ctx?.ui?.setStatus?.("pipe", `/pipe · ${config.mode} · ${config.command}`);
    }
  } catch {}
}

/**
 * Apply the active pipe configuration to one Pi input event. Exported so the
 * transform/send-raw/cancel contracts can be tested without a live TUI.
 */
export async function handlePipeInput(config, event, ctx, { runCommand = runPipeCommand } = {}) {
  if (config?.mode === "off") return { action: "continue" };
  if (event?.source && event.source !== "interactive") return { action: "continue" };

  const raw = String(event?.text ?? "");
  if (!raw.trim() || /^\s*\//.test(raw)) return { action: "continue" };

  if (!config?.command) {
    restoreEditor(ctx, raw);
    notify(ctx, "/pipe has no command configured; original text restored.", "warning");
    return { action: "handled" };
  }

  let output;
  setPipeStatus(ctx, config, true);
  try {
    output = String(await runCommand(config.command, raw, {
      cwd: ctx?.cwd || process.cwd(),
      env: process.env,
      timeoutMs: resolvePipeTimeoutMs(process.env),
    }));
  } catch (error) {
    restoreEditor(ctx, raw);
    notify(ctx, `/pipe failed: ${error?.message || String(error)}. Original text restored.`, "warning");
    return { action: "handled" };
  } finally {
    setPipeStatus(ctx, config, false);
  }

  if (!output) {
    restoreEditor(ctx, raw);
    notify(ctx, "/pipe command produced no output; original text restored.", "warning");
    return { action: "handled" };
  }

  if (config.mode === "auto") {
    return { action: "transform", text: output, images: event?.images };
  }

  if (typeof ctx?.ui?.select !== "function") {
    notify(ctx, "/pipe mode=on requires an interactive selection UI; sending raw text.", "warning");
    return { action: "continue" };
  }

  const choice = await ctx.ui.select(
    `/pipe output (${config.command})\n\n${output}`,
    ["send", "send raw", "cancel"],
  );
  if (choice === "send") {
    return { action: "transform", text: output, images: event?.images };
  }
  if (choice === "send raw") return { action: "continue" };

  restoreEditor(ctx, raw);
  notify(ctx, "/pipe cancelled; original text restored.", "info");
  return { action: "handled" };
}

function modeCompletions(prefix, { assignment = false } = {}) {
  const raw = String(prefix ?? "").trim().toLowerCase();
  const needle = assignment && raw.startsWith("mode=") ? raw.slice(5) : raw;
  return PIPE_MODES
    .filter((mode) => mode.startsWith(needle))
    .map((mode) => {
      const value = assignment ? `mode=${mode}` : mode;
      return { value, label: value };
    });
}

export default function pipeExtension(pi, options = {}) {
  let config = { command: "", mode: "off" };
  const runCommand = typeof options.runCommand === "function" ? options.runCommand : runPipeCommand;

  const update = (partial, ctx) => {
    config = applyPipeUpdate(config, partial);
    setPipeStatus(ctx, config, false);
    notify(ctx, formatPipeStatus(config), "info");
    return { ...config };
  };

  pi.on?.("session_start", (_event, ctx) => setPipeStatus(ctx, config, false));

  // Keep this handler before read-aloud's input handler in package.json. Pi
  // passes our transformed result to later input handlers, so /read speaks the
  // exact text that will be sent to the model.
  pi.on?.("input", async (event, ctx) => handlePipeInput(config, event, ctx, { runCommand }));

  pi.registerCommand?.("pipe", {
    description: `${PIPE_USAGE} mode=on previews send/send raw/cancel; mode=auto sends transformed output directly.`,
    getArgumentCompletions: (prefix) => {
      const raw = String(prefix ?? "").trim().toLowerCase();
      const items = raw.startsWith("mode=")
        ? modeCompletions(raw, { assignment: true })
        : [
            { value: "cmd=", label: "cmd=" },
            ...modeCompletions("", { assignment: true }),
          ].filter((item) => item.value.startsWith(raw));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const parsed = parsePipeArguments(args);
        if (parsed.kind === "status") {
          notify(ctx, `${formatPipeStatus(config)}. ${PIPE_USAGE}`, "info");
          return;
        }
        update(parsed, ctx);
      } catch (error) {
        notify(ctx, error?.message || String(error), "warning");
      }
    },
  });

  pi.registerCommand?.("fix", {
    description: `${FIX_USAGE} — alias for /pipe cmd=fix mode=<mode>.`,
    getArgumentCompletions: (prefix) => {
      const items = modeCompletions(prefix);
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
      const mode = tokens.length === 1 ? normalizePipeMode(tokens[0]) : undefined;
      if (!mode) {
        notify(ctx, FIX_USAGE, "warning");
        return;
      }
      try {
        update({ command: "fix", mode }, ctx);
      } catch (error) {
        notify(ctx, error?.message || String(error), "warning");
      }
    },
  });

  try {
    pi.agentUtilsPipe = {
      getConfig: () => ({ ...config }),
      configure: (partial, ctx) => update(partial, ctx),
    };
  } catch {}
}
