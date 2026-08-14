// Finger One ring input adapter for generic Agent Utils choices (bd-8b3005).
//
// The ring daemon is already external/daemonised. On choice-session start this
// adapter launches only `ring get`, a bounded smart client over the daemon-owned
// event log, maps configured ring events to generic input actions, and emits them
// on pi.events. It never scans, pairs, connects, enables, or starts a ring daemon.

import { spawn } from "node:child_process";
import { parseEnvStyleArgs } from "./lib/env-args.js";
import { CHOICE_SESSION_EVENT } from "./lib/choice.js";
import { INPUT_ACTION_EVENT } from "./lib/input-actions.js";
import {
  buildRingInputArgs,
  parseRingInputLine,
  resolveRingInputEventMap,
  ringEventToInputAction,
} from "./lib/ring-input.js";
import { persistRingInputSetting, readPersistedRingInputSettings } from "./lib/tts-settings.js";

function envEnabled(env = process.env, persisted = {}) {
  const raw = env.PI_RING_CHOICE_ENABLED ?? persisted.enabled;
  if (raw == null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

export function createRingInputExtension({ spawnImpl = spawn, env = process.env, settingsPath, persistedSettings } = {}) {
  return function ringInputExtension(pi) {
    const ringConfig = { ...(persistedSettings?.ringInput ?? readPersistedRingInputSettings(settingsPath)) };
    let current = null;
    let activeSession = null;
    let lastStatus = { state: "idle", error: null, event: null };

    const emitStatus = (status) => {
      lastStatus = { ...lastStatus, ...status };
      try { pi.events?.emit?.("agent-utils:ring-input-status", { ...lastStatus }); } catch {}
    };

    const stop = (reason = "stopped") => {
      const record = current;
      if (!record) return false;
      current = null;
      record.stopped = true;
      try { record.proc?.kill?.("SIGTERM"); } catch {}
      emitStatus({ state: "idle", reason });
      return true;
    };

    const start = (session) => {
      stop("replaced");
      if (!envEnabled(env, ringConfig)) {
        emitStatus({ state: "disabled", error: null, sessionId: session.sessionId });
        return false;
      }
      const eventMap = resolveRingInputEventMap(ringConfig, env);
      const command = env.PI_RING_COMMAND || ringConfig.command || "ring";
      let proc;
      try {
        proc = spawnImpl(command, buildRingInputArgs({ eventMap, timeoutMs: session.timeoutMs }), {
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
      } catch (error) {
        emitStatus({ state: "error", error: error?.message || String(error), sessionId: session.sessionId });
        return false;
      }
      const record = { proc, session, sessionId: session.sessionId, ring: session.ring || env.PI_RING_CHOICE_RING || ringConfig.ring || null, stdout: "", stderr: "", stopped: false };
      current = record;
      emitStatus({ state: "listening", error: null, sessionId: record.sessionId, ring: record.ring });

      const handleLine = (line) => {
        const parsed = parseRingInputLine(line);
        if (!parsed || (record.ring && parsed.ring && String(parsed.ring) !== String(record.ring))) return;
        const input = ringEventToInputAction(parsed, eventMap);
        if (!input) return;
        emitStatus({ state: "listening", event: parsed.event, sessionId: record.sessionId });
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
        const detail = record.stderr.trim();
        if (/timed out waiting/i.test(detail)) {
          if (Number(record.session.timeoutMs) === 0 && activeSession?.sessionId === record.sessionId) {
            emitStatus({ state: "restarting", reason: "bounded-client-timeout", error: null, sessionId: record.sessionId });
            queueMicrotask(() => {
              if (activeSession?.sessionId === record.sessionId && !current) start(activeSession);
            });
          } else emitStatus({ state: "idle", reason: "timeout", error: null, sessionId: record.sessionId });
        } else if (code === 0) emitStatus({ state: "idle", reason: "ended", error: null, sessionId: record.sessionId });
        else emitStatus({ state: "error", error: `ring get exited ${code ?? "?"}${signal ? `/${signal}` : ""}${detail ? `: ${detail}` : ""}`, sessionId: record.sessionId });
      });
      return true;
    };

    const choiceSessionHandler = (session = {}) => {
      if (session.status === "started") {
        activeSession = session;
        start(session);
      } else if (session.status === "ended" && activeSession?.sessionId === session.sessionId) {
        activeSession = null;
        stop("choice-ended");
      }
    };
    pi.events?.on?.(CHOICE_SESSION_EVENT, choiceSessionHandler);

    pi.registerCommand("ring-input", {
      description: "Inspect/configure the ring choice-input adapter. Usage: /ring-input status|mappings|on|off|settings key=value",
      handler: async (args, ctx) => {
        const raw = String(args || "status").trim() || "status";
        const action = raw.toLowerCase();
        if (action === "status") {
          ctx.ui.notify(`ring input: ${lastStatus.state} enabled=${envEnabled(env, ringConfig)} ring=${env.PI_RING_CHOICE_RING || ringConfig.ring || "any"} command=${env.PI_RING_COMMAND || ringConfig.command || "ring"}${lastStatus.sessionId ? ` session=${lastStatus.sessionId}` : ""}${lastStatus.event ? ` event=${lastStatus.event}` : ""}${lastStatus.error ? ` error=${lastStatus.error}` : ""}`, lastStatus.state === "error" ? "warning" : "info");
          return;
        }
        if (action === "mappings") {
          const map = resolveRingInputEventMap(ringConfig, env);
          ctx.ui.notify(Object.entries(map).map(([semantic, events]) => `${semantic}: ${events.join(",")}`).join("\n"), "info");
          return;
        }
        if (action === "off") {
          env.PI_RING_CHOICE_ENABLED = "0";
          ringConfig.enabled = false;
          persistRingInputSetting("enabled", false, settingsPath);
          stop("disabled");
          ctx.ui.notify("ring choice input disabled and persisted", "info");
          return;
        }
        if (action === "on") {
          env.PI_RING_CHOICE_ENABLED = "1";
          ringConfig.enabled = true;
          persistRingInputSetting("enabled", true, settingsPath);
          ctx.ui.notify("ring choice input enabled and persisted; it will attach to the next choice session", "info");
          return;
        }
        if (/^settings(?:\s|$)/i.test(raw)) {
          try {
            const parsed = parseEnvStyleArgs(raw.replace(/^settings\s*/i, ""));
            if (parsed.positionals.length) throw new Error(`/ring-input settings: unexpected '${parsed.positionals[0]}'`);
            const aliases = {
              enabled: "enabled", ring: "ring", command: "command",
              previous: "previousEvents", previous_events: "previousEvents",
              next: "nextEvents", next_events: "nextEvents",
              select: "selectEvents", select_events: "selectEvents",
              cancel: "cancelEvents", cancel_events: "cancelEvents",
            };
            for (const [key, value] of Object.entries(parsed.values)) {
              const field = aliases[key];
              if (!field) throw new Error(`/ring-input settings: unknown '${key}'`);
              let resolved = String(value).trim();
              if (field === "enabled") {
                const normalized = resolved.toLowerCase();
                if (!["1", "true", "yes", "on", "0", "false", "no", "off"].includes(normalized)) throw new Error("/ring-input settings: enabled must be true or false");
                resolved = ["1", "true", "yes", "on"].includes(normalized);
              } else if (field.endsWith("Events")) {
                resolved = resolved.split(",").map((item) => item.trim()).filter(Boolean);
              }
              ringConfig[field] = resolved;
              persistRingInputSetting(field, resolved, settingsPath);
            }
            ctx.ui.notify("ring input settings persisted; use /ring-input mappings or status", "info");
          } catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); }
          return;
        }
        ctx.ui.notify("Usage: /ring-input status|mappings|on|off|settings key=value", "warning");
      },
    });

    pi.on("session_shutdown", () => {
      activeSession = null;
      stop("shutdown");
      try { pi.events?.off?.(CHOICE_SESSION_EVENT, choiceSessionHandler); } catch {}
    });
  };
}

export default createRingInputExtension();
