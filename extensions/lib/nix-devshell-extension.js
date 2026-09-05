// On-demand Nix dev shells without direnv startup or persistent project GC roots.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToolSchema as Type } from "./tool-schema.js";
import {
  DEVSHELL_FAILURE_HINT,
  flakeDeclaresDevShell,
  normalizeDevShellName,
  parseNullEnvironment,
  runNixDevelop,
  sanitizeDevShellEnvironment,
  wrapCommandForDevShell,
} from "./nix-devshell.js";

const text = (value) => [{ type: "text", text: String(value) }];
const label = (name) => name ? `.#${name}` : "default devshell";
const warnedSessions = globalThis[Symbol.for("agent-utils.nix-devshell.warned-sessions.v1")] ??= new Set();

function appendTextContent(content, message) {
  if (typeof content === "string") return `${content}\n${message}`;
  return [...(Array.isArray(content) ? content : []), { type: "text", text: message }];
}

export function createNixDevshellExtension({ run = runNixDevelop, localBashOperations, createBashToolFactory } = {}) {
  if (typeof createBashToolFactory !== "function") throw new Error("createNixDevshellExtension requires createBashToolFactory");
  return function nixDevshellExtension(pi) {
    const state = { enabled: false, name: null, cwd: null, environment: null, sessionKey: null };

    async function enable(name, ctx) {
      const normalized = normalizeDevShellName(name);
      const started = Date.now();
      const result = await run({ name: normalized, cwd: ctx.cwd, signal: ctx.signal, command: ["env", "-0"], maxOutputBytes: 1024 * 1024 });
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `nix develop exited ${result.exitCode}`);
      const environment = sanitizeDevShellEnvironment(parseNullEnvironment(result.stdout));
      if (!environment.PATH) throw new Error("nix develop returned no PATH");
      state.enabled = true;
      state.name = normalized;
      state.cwd = ctx.cwd;
      state.environment = environment;
      return { enabled: true, name: state.name, cwd: state.cwd, initializationMs: Date.now() - started };
    }

    function disable() {
      const previous = { enabled: state.enabled, name: state.name, cwd: state.cwd };
      state.enabled = false;
      state.name = null;
      state.cwd = null;
      state.environment = null;
      return previous;
    }

    pi.on("session_start", async (_event, ctx) => {
      state.sessionKey = ctx.sessionManager?.getSessionId?.() || ctx.sessionManager?.getSessionFile?.() || `runtime:${Date.now()}:${Math.random()}`;
      const bash = createBashToolFactory(ctx.cwd, {
        spawnHook({ command, cwd, env }) {
          return { command, cwd, env: state.enabled ? { ...env, ...state.environment } : env };
        },
      });
      pi.registerTool(bash);
    });

    pi.on("tool_result", (event, ctx) => {
      if (event.toolName !== "bash" || !event.isError || state.enabled || process.env.IN_NIX_SHELL || warnedSessions.has(state.sessionKey)) return;
      let declares = false;
      try { declares = flakeDeclaresDevShell(readFileSync(join(ctx.cwd, "flake.nix"), "utf8")); } catch {}
      if (!declares) return;
      warnedSessions.add(state.sessionKey);
      if (warnedSessions.size > 256) warnedSessions.delete(warnedSessions.values().next().value);
      return { content: appendTextContent(event.content, DEVSHELL_FAILURE_HINT) };
    });

    pi.on("user_bash", async () => {
      if (!state.enabled) return;
      const factory = localBashOperations || (await import("@earendil-works/pi-coding-agent")).createLocalBashOperations;
      const local = factory();
      return {
        operations: {
          exec(command, cwd, options) {
            return local.exec(wrapCommandForDevShell(command, state.name), cwd, options);
          },
        },
      };
    });

    pi.registerCommand("nix", {
      description: "Enable, disable, or inspect on-demand Nix devshell routing",
      async handler(raw, ctx) {
        const parts = String(raw || "").trim().split(/\s+/).filter(Boolean);
        if (parts[0] !== "devshell") {
          ctx.ui.notify("Usage: /nix devshell [NAME|off|status]", "warning");
          return;
        }
        const action = parts[1] || "default";
        if (action === "off") {
          const previous = disable();
          ctx.ui.setStatus?.("nix-devshell", undefined);
          ctx.ui.notify(previous.enabled ? `Nix ${label(previous.name)} disabled; Bash is back to the regular environment.` : "Nix devshell was already disabled.", "info");
          return;
        }
        if (action === "status") {
          ctx.ui.notify(state.enabled ? `Nix ${label(state.name)} enabled from ${state.cwd}.` : "Nix devshell disabled.", "info");
          return;
        }
        try {
          const active = await enable(action, ctx);
          ctx.ui.setStatus?.("nix-devshell", `nix:${active.name || "default"}`);
          ctx.ui.notify(`Nix ${label(active.name)} ready in ${active.initializationMs}ms. Future agent Bash and user ! commands run through nix develop; disable with /nix devshell off.`, "info");
        } catch (error) {
          ctx.ui.notify(`Nix devshell failed: ${error.message}`, "error");
        }
      },
    });

    pi.registerTool({
      name: "nix_devshell_enable",
      label: "Enable Nix Devshell",
      description: "Synchronously initialize and enable a Nix flake devshell for all subsequent agent Bash commands in this Pi session. Use when repository commands need tools or environment supplied by flake.nix.",
      promptSnippet: "Enable the current flake's devshell when repository Bash commands need dependencies that are unavailable in the regular environment.",
      parameters: Type.object({
        devshell: Type.optional(Type.string({ description: "Named flake devshell, such as ci for .#ci. Omit for the default devshell." })),
      }),
      async execute(_id, params, signal, _update, ctx) {
        try {
          const active = await enable(params.devshell, { cwd: ctx.cwd, signal });
          ctx.ui.setStatus?.("nix-devshell", `nix:${active.name || "default"}`);
          return { content: text(`Enabled Nix ${label(active.name)} from ${active.cwd} in ${active.initializationMs}ms. Subsequent Bash commands are automatically wrapped; do not prepend nix develop.`), details: active };
        } catch (error) {
          return { content: text(`Failed to enable Nix devshell: ${error.message}`), details: { enabled: false, error: error.message }, isError: true };
        }
      },
    });

    pi.registerTool({
      name: "nix_devshell_disable",
      label: "Disable Nix Devshell",
      description: "Disable session-wide Nix devshell routing so subsequent Bash commands use the regular environment inherited when Pi started.",
      promptSnippet: "Disable the active on-demand Nix devshell when repository work no longer needs it.",
      parameters: Type.object({}),
      async execute(_id, _params, _signal, _update, ctx) {
        const previous = disable();
        ctx.ui.setStatus?.("nix-devshell", undefined);
        return { content: text(previous.enabled ? "Disabled Nix devshell routing. Subsequent Bash commands use the regular environment." : "Nix devshell routing was already disabled."), details: { enabled: false, previous } };
      },
    });

    pi.registerTool({
      name: "bash_devshell",
      label: "Bash in Nix Devshell",
      description: "Run one Bash command in a Nix flake devshell without changing session-wide Bash routing. Use for isolated hermetic repository commands; cached Nix evaluations/store paths make later calls faster.",
      promptSnippet: "Use for one hermetic command in the current flake without enabling the devshell for later Bash calls.",
      parameters: Type.object({
        command: Type.string({ description: "Bash command to execute inside the devshell." }),
        devshell: Type.optional(Type.string({ description: "Named flake devshell, such as ci for .#ci. Omit for the default devshell." })),
        timeoutMs: Type.optional(Type.number({ description: "Timeout in milliseconds. Defaults to 120000." })),
      }),
      async execute(_id, params, signal, _update, ctx) {
        try {
          const result = await run({ name: params.devshell, cwd: ctx.cwd, signal, timeoutMs: params.timeoutMs, command: ["bash", "-c", params.command] });
          const output = [result.stdout, result.stderr].filter(Boolean).join(result.stdout && result.stderr ? "\n" : "");
          return {
            content: text(output || `(command exited ${result.exitCode} with no output)`),
            details: { ...result, devshell: normalizeDevShellName(params.devshell), cwd: ctx.cwd },
            isError: result.exitCode !== 0,
          };
        } catch (error) {
          return { content: text(`bash_devshell failed: ${error.message}`), details: { error: error.message }, isError: true };
        }
      },
    });
  };
}
