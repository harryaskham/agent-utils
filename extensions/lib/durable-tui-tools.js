// Durable adapter for TUI tool extensions (bd-74502e).
//
// Runs a TUI Pi extension against a capturing `pi` and exposes the tools it
// registers as Durable tools for pi-daemon sessions, so one implementation serves
// both runtimes. A tool's `execute(toolCallId, params, signal, onUpdate, ctx)` is
// called with pi-daemon's call id, the session's abort signal and a headless
// `ctx` in the session's directory: its UI notifies nowhere, confirmations
// decline and selections choose nothing, since no terminal is attached. `pi.exec`
// runs in the calling session's directory. Commands, event hooks, renderers and
// shortcuts are TUI behaviour and are ignored.

import { spawn } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";

const MAX_EXEC_OUTPUT = 4 * 1024 * 1024;

/** Run a command for a tool's `pi.exec`, as TUI Pi does: `{ stdout, stderr, code, killed }`. */
export function runExec(command, args = [], { cwd, timeout, signal, env } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    let child;
    try {
      child = spawn(command, [...args].map(String), {
        cwd,
        env: env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      resolve({ stdout: "", stderr: String(error?.message ?? error), code: 127, killed: false });
      return;
    }
    const timer = Number(timeout) > 0 ? setTimeout(() => { killed = true; child.kill("SIGTERM"); }, Number(timeout)) : undefined;
    timer?.unref?.();
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk).slice(0, MAX_EXEC_OUTPUT); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(0, MAX_EXEC_OUTPUT); });
    let spawnFailed = false;
    child.on("error", (error) => { spawnFailed = true; stderr ||= String(error?.message ?? error); });
    child.on("close", (code, killSignal) => {
      if (timer) clearTimeout(timer);
      // A command that could not start is the shell's 127, not Node's errno.
      const exit = spawnFailed && !(code > 0) ? 127 : code ?? (killSignal ? 1 : 0);
      resolve({ stdout, stderr, code: exit, killed: killed || killSignal !== null });
    });
  });
}

/**
 * `pi.exec` through the session's own execution environment (pi-daemon's: its directory, profile
 * env files and per-session variables), as TUI Pi's runs in the session's shell. Pi's timeout is
 * in milliseconds, Durable's in seconds.
 */
export async function execInSession(execEnv, context, command, args = [], { cwd, timeout } = {}) {
  let stdout = "";
  let stderr = "";
  const seconds = Number(timeout) > 0 ? Math.max(1, Math.ceil(Number(timeout) / 1000)) : undefined;
  const result = await execEnv.exec(
    [String(command), ...[...args].map(String)],
    {
      ...(cwd ? { cwd } : {}),
      ...(seconds ? { timeout: seconds } : {}),
      onOutput: (text, _context, info) => {
        if (info?.stream === "stderr") stderr = (stderr + text).slice(-MAX_EXEC_OUTPUT);
        else stdout = (stdout + text).slice(-MAX_EXEC_OUTPUT);
      },
    },
    context,
  );
  if (!result?.ok) {
    const error = result?.error;
    return { stdout, stderr: stderr || String(error?.message ?? error ?? "exec failed"), code: 1, killed: error?.code === "timeout" || error?.kind === "timeout" };
  }
  return { stdout, stderr, code: result.value.exitCode, killed: false };
}

/** A headless TUI `ctx` for one tool call. */
function headlessContext({ cwd, signal, env, sessionId }) {
  const nothing = () => undefined;
  const ui = {
    notify: nothing,
    setStatus: nothing,
    setWidget: nothing,
    setTitle: nothing,
    setFooter: nothing,
    setEditorText: nothing,
    getEditorText: () => "",
    requestRender: nothing,
    confirm: async () => false,
    select: async () => undefined,
    input: async () => undefined,
    custom: async () => undefined,
    theme: undefined,
  };
  return {
    cwd,
    signal,
    hasUI: false,
    mode: "headless",
    ui,
    env,
    isIdle: () => false,
    abort: nothing,
    hasPendingMessages: () => false,
    getContextUsage: () => undefined,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionName: () => undefined,
      getEntries: () => [],
      getBranch: () => [],
      getCwd: () => cwd,
    },
  };
}

/** A tool's model-facing description: its description, prompt snippet and guidelines. */
function describe(definition) {
  const parts = [String(definition.description ?? "").trim()];
  if (definition.promptSnippet && !parts[0].includes(String(definition.promptSnippet).trim())) parts.push(String(definition.promptSnippet).trim());
  const guidelines = Array.isArray(definition.promptGuidelines) ? definition.promptGuidelines.map((line) => `- ${String(line).trim()}`) : [];
  if (guidelines.length) parts.push(guidelines.join("\n"));
  return parts.filter(Boolean).join("\n\n");
}

/**
 * A TUI tool result as a Durable one; a thrown error stays an error. Its text is `output` for
 * pi-durable 1.2 and later (which renamed `content`) and `content` for earlier hosts.
 */
function durableResult(result) {
  const both = (output) => ({ output, content: output });
  if (result === undefined || result === null) return both([{ type: "text", text: "" }]);
  if (typeof result === "string") return both([{ type: "text", text: result }]);
  const content = Array.isArray(result.content) ? result.content : [{ type: "text", text: JSON.stringify(result) }];
  return {
    ...both(content),
    ...(result.details === undefined ? {} : { details: result.details }),
    ...(result.isError === true ? { isError: true } : {}),
  };
}

/**
 * The tools a TUI extension `factory` registers, as Durable tool definitions.
 * `options.env` is the environment the extension sees at load and its `pi.exec`
 * runs with; `options.only` keeps just those tool names.
 */
export async function adaptTuiToolExtension(factory, { env = process.env, only } = {}) {
  const calls = new AsyncLocalStorage();
  const registered = [];
  const ignored = () => undefined;
  const supported = {
    registerTool: (definition) => {
      if (definition && typeof definition.name === "string" && typeof definition.execute === "function") registered.push(definition);
    },
    exec: (command, args = [], options = {}) => {
      const call = calls.getStore();
      if (call?.execEnv && typeof call.execEnv.exec === "function" && call.context !== undefined) {
        return execInSession(call.execEnv, call.context, command, args, { cwd: options.cwd, timeout: options.timeout });
      }
      return runExec(command, args, {
        cwd: options.cwd ?? call?.cwd ?? process.cwd(),
        timeout: options.timeout,
        signal: options.signal ?? call?.signal,
        env,
      });
    },
    on: ignored,
    events: { on: () => ignored, emit: ignored },
    getThinkingLevel: () => undefined,
    getActiveTools: () => registered.map((definition) => definition.name),
    getAllTools: () => registered.map((definition) => ({ name: definition.name, description: definition.description })),
  };
  // Anything else (commands, shortcuts, renderers, flags, providers) is TUI behaviour: accepted, unused.
  const pi = new Proxy(supported, { get: (target, key) => (key in target ? target[key] : ignored) });
  await factory(pi);
  const keep = only ? new Set(only) : undefined;
  return registered
    .filter((definition) => !keep || keep.has(definition.name))
    .map((definition) => ({
      name: definition.name,
      description: describe(definition),
      parameters: definition.parameters ?? { type: "object", properties: {} },
      async execute(params = {}, api = {}, context = {}) {
        const cwd = api.env?.cwd || process.cwd();
        const signal = context.abortSignal;
        const sessionId = String(api.conversationId ?? "pi-daemon");
        const ctx = headlessContext({ cwd, signal, env, sessionId });
        const result = await calls.run({ cwd, signal, execEnv: api.env, context }, () =>
          definition.execute(String(api.callId ?? ""), params ?? {}, signal, () => undefined, ctx),
        );
        return durableResult(result);
      },
    }));
}
