// Omni relay subscriber adapter for Agent Utils choices. It starts only the
// `omni listen` smart client while a choice is open; it never starts or owns an
// Omni/ring daemon or listener.

import { spawn } from "node:child_process";
import { CHOICE_SESSION_EVENT } from "./lib/choice.js";
import { INPUT_ACTION_EVENT } from "./lib/input-actions.js";
import { OMNI_INPUT_STATUS_EVENT, parseOmniChoiceLine, resolveOmniInputConfig } from "./lib/omni-input.js";
import { readPersistedChoiceSettings, readPersistedOmniInputSettings } from "./lib/tts-settings.js";

export { OMNI_INPUT_STATUS_EVENT } from "./lib/omni-input.js";

export function createOmniInputExtension({ spawnImpl = spawn, env = process.env, settingsPath, persistedSettings } = {}) {
  return function omniInputExtension(pi) {
    const choiceSettings = persistedSettings?.choice ?? readPersistedChoiceSettings(settingsPath);
    const omniSettings = persistedSettings?.omniInput ?? readPersistedOmniInputSettings(settingsPath);
    const config = resolveOmniInputConfig(env, choiceSettings, omniSettings);
    let activeSession = null;
    let current = null;
    let lastStatus = { state: config.enabled ? "idle" : "disabled", error: null };

    const emitStatus = (status) => {
      lastStatus = { ...lastStatus, ...status, source: config.source };
      try { pi.events?.emit?.(OMNI_INPUT_STATUS_EVENT, { ...lastStatus }); } catch {}
    };
    const stop = (reason = "stopped") => {
      const record = current;
      current = null;
      if (!record) return false;
      record.stopped = true;
      try { record.proc?.kill?.("SIGTERM"); } catch {}
      emitStatus({ state: config.enabled ? "idle" : "disabled", reason });
      return true;
    };
    const start = (session) => {
      stop("replaced");
      if (!config.enabled) { emitStatus({ state: "disabled", sessionId: session.sessionId }); return false; }
      let proc;
      try { proc = spawnImpl(config.command, config.args, { stdio: ["ignore", "pipe", "pipe"], env }); }
      catch (error) { emitStatus({ state: "error", error: error?.message || String(error), sessionId: session.sessionId }); return false; }
      const record = { proc, sessionId: session.sessionId, stdout: "", stderr: "", stopped: false };
      current = record;
      emitStatus({ state: "listening", error: null, sessionId: record.sessionId, daemon: config.daemon });
      const handleLine = (line) => {
        const input = parseOmniChoiceLine(line);
        if (!input) return;
        emitStatus({ state: "listening", event: input.event, device: input.device, sessionId: record.sessionId });
        try { pi.events?.emit?.(INPUT_ACTION_EVENT, { ...input, sessionId: record.sessionId }); } catch {}
      };
      proc.stdout?.on?.("data", (chunk) => {
        record.stdout += String(chunk);
        const lines = record.stdout.split(/\r?\n/);
        record.stdout = lines.pop() || "";
        for (const line of lines) handleLine(line);
      });
      proc.stderr?.on?.("data", (chunk) => { record.stderr = `${record.stderr}${String(chunk)}`.slice(-1000); });
      proc.on?.("error", (error) => {
        if (current !== record || record.stopped) return;
        current = null;
        emitStatus({ state: "error", error: error?.message || String(error), sessionId: record.sessionId });
      });
      proc.on?.("exit", (code, signal) => {
        if (record.stdout.trim()) handleLine(record.stdout);
        if (current !== record || record.stopped) return;
        current = null;
        emitStatus({ state: code === 0 ? "idle" : "error", error: code === 0 ? null : `omni listen exited ${code ?? "?"}${signal ? `/${signal}` : ""}${record.stderr.trim() ? `: ${record.stderr.trim()}` : ""}`, sessionId: record.sessionId });
      });
      return true;
    };
    const choiceSessionHandler = (session = {}) => {
      if (session.status === "started") { activeSession = session; start(session); }
      else if (session.status === "ended" && activeSession?.sessionId === session.sessionId) { activeSession = null; stop("choice-ended"); }
    };
    pi.events?.on?.(CHOICE_SESSION_EVENT, choiceSessionHandler);
    pi.registerCommand("omni-input", {
      description: "Inspect the Omni relay choice-input subscriber. Usage: /omni-input status",
      handler: async (_args, ctx) => ctx.ui.notify(`omni input: ${lastStatus.state} source=${config.source} command=${config.command} ${config.args.join(" ")}${lastStatus.event ? ` event=${lastStatus.event}` : ""}${lastStatus.error ? ` error=${lastStatus.error}` : ""}`, lastStatus.state === "error" ? "warning" : "info"),
    });
    pi.on("session_shutdown", () => {
      activeSession = null;
      stop("shutdown");
      try { pi.events?.off?.(CHOICE_SESSION_EVENT, choiceSessionHandler); } catch {}
    });
  };
}

export default createOmniInputExtension();
