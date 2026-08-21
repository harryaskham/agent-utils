// Finger One ring input adapter for generic Agent Utils choices (bd-8b3005).
//
// The ring daemon is already external/daemonised. While one or more choice
// sessions are active, this adapter maintains at most one bounded `ring get`
// smart client per Pi process, multiplexes sessions in memory, maps configured
// ring events to generic input actions, and emits them on pi.events. It never
// scans, pairs, connects, enables, or starts a ring daemon.

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
import { readPersistedChoiceSettings, readPersistedRingInputSettings } from "./lib/tts-settings.js";
import { OMNI_INPUT_STATUS_EVENT } from "./lib/omni-input.js";

function envEnabled(env = process.env, persisted = {}) {
  const raw = env.PI_RING_CHOICE_ENABLED ?? persisted.enabled;
  if (raw == null || String(raw).trim() === "") return true;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

export function createRingInputExtension({
  spawnImpl = spawn,
  env = process.env,
  settingsPath,
  persistedSettings,
  terminateGraceMs = 1_000,
} = {}) {
  return function ringInputExtension(pi) {
    const ringConfig = { ...(persistedSettings?.ringInput ?? readPersistedRingInputSettings(settingsPath)) };
    const choiceConfig = persistedSettings?.choice ?? readPersistedChoiceSettings(settingsPath);
    const inputSource = String(env.PI_CHOICE_INPUT_SOURCE ?? choiceConfig.inputSource ?? "auto").trim().toLowerCase();
    let omniState = "idle";
    let current = null;
    const activeSessions = new Map();
    let lastStatus = { state: "idle", error: null, event: null, connectionCount: 0, sessionCount: 0 };

    const emitStatus = (status) => {
      lastStatus = {
        ...lastStatus,
        ...status,
        connectionCount: current ? 1 : 0,
        sessionCount: activeSessions.size,
      };
      try { pi.events?.emit?.("agent-utils:ring-input-status", { ...lastStatus }); } catch {}
    };

    const directInputWanted = () =>
      inputSource !== "omni" &&
      !(inputSource === "auto" && omniState === "listening") &&
      envEnabled(env, ringConfig) &&
      activeSessions.size > 0;

    // Idempotent two-stage teardown. A child that ignores SIGTERM gets a short
    // grace period, then SIGKILL. The stale record is detached immediately so
    // its stdout and renewal callback cannot route events into a later choice.
    const stop = (reason = "stopped", state = "idle") => {
      const record = current;
      if (!record) {
        emitStatus({ state, reason });
        return false;
      }
      current = null;
      if (record.stopped) return false;
      record.stopped = true;
      try { record.proc?.kill?.("SIGTERM"); } catch {}
      const grace = Math.max(0, Number(terminateGraceMs) || 0);
      record.killTimer = setTimeout(() => {
        if (record.exited) return;
        try { record.proc?.kill?.("SIGKILL"); } catch {}
      }, grace);
      record.killTimer?.unref?.();
      emitStatus({ state, reason });
      return true;
    };

    // One transport per Pi process, independent of choice count. Session/ring
    // filtering happens in memory below; starting a second simultaneous choice
    // merely adds a route and never spawns another child.
    const ensureConnection = () => {
      if (current) return true;
      if (!directInputWanted()) {
        const disabled = !envEnabled(env, ringConfig);
        emitStatus({
          state: disabled ? "disabled" : activeSessions.size ? "standby" : "idle",
          reason: disabled ? "disabled" : activeSessions.size ? "omni-primary" : "no-sessions",
          error: null,
        });
        return false;
      }
      const eventMap = resolveRingInputEventMap(ringConfig, env);
      const command = env.PI_RING_COMMAND || ringConfig.command || "ring";
      let proc;
      try {
        // Transport lifetime is process/session driven, not tied to one choice's
        // UI timeout. The bounded client renews while any routed choice remains.
        proc = spawnImpl(command, buildRingInputArgs({ eventMap, timeoutMs: 0 }), {
          stdio: ["ignore", "pipe", "pipe"],
          env,
        });
      } catch (error) {
        emitStatus({ state: "error", error: error?.message || String(error) });
        return false;
      }
      const record = {
        proc,
        eventMap,
        stdout: "",
        stderr: "",
        stopped: false,
        exited: false,
        killTimer: null,
      };
      current = record;
      emitStatus({ state: "listening", error: null, reason: "connected" });

      const handleLine = (line) => {
        if (record.stopped || current !== record) return;
        const parsed = parseRingInputLine(line);
        if (!parsed) return;
        const input = ringEventToInputAction(parsed, eventMap);
        if (!input) return;
        for (const session of activeSessions.values()) {
          const ring = session.ring || env.PI_RING_CHOICE_RING || ringConfig.ring || null;
          if (ring && parsed.ring && String(parsed.ring) !== String(ring)) continue;
          emitStatus({ state: "listening", event: parsed.event, sessionId: session.sessionId });
          try { pi.events?.emit?.(INPUT_ACTION_EVENT, { ...input, sessionId: session.sessionId }); } catch {}
        }
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
        record.stopped = true;
        emitStatus({ state: "error", error: error?.message || String(error) });
      });
      proc.on?.("exit", (code, signal) => {
        record.exited = true;
        if (record.killTimer) clearTimeout(record.killTimer);
        if (record.stdout.trim()) handleLine(record.stdout);
        if (current !== record || record.stopped) return;
        current = null;
        const detail = record.stderr.trim();
        if (/timed out waiting/i.test(detail) && directInputWanted()) {
          emitStatus({ state: "restarting", reason: "bounded-client-timeout", error: null });
          queueMicrotask(() => {
            if (!current && directInputWanted()) ensureConnection();
          });
        } else if (code === 0) {
          emitStatus({ state: "idle", reason: "ended", error: null });
        } else {
          emitStatus({ state: "error", error: `ring get exited ${code ?? "?"}${signal ? `/${signal}` : ""}${detail ? `: ${detail}` : ""}` });
        }
      });
      return true;
    };

    const choiceSessionHandler = (session = {}) => {
      const id = session.sessionId;
      if (!id) return;
      if (session.status === "started") {
        activeSessions.set(id, session);
        ensureConnection();
      } else if (session.status === "ended") {
        activeSessions.delete(id);
        if (activeSessions.size === 0) stop("choice-ended");
        else emitStatus({ state: current ? "listening" : "standby", reason: "choice-ended" });
      }
    };
    pi.events?.on?.(CHOICE_SESSION_EVENT, choiceSessionHandler);
    const omniStatusHandler = (status = {}) => {
      omniState = status.state || "idle";
      if (inputSource !== "auto" || activeSessions.size === 0) return;
      if (omniState === "listening") stop("omni-primary", "standby");
      else if (["error", "disabled", "idle"].includes(omniState) && !current) ensureConnection();
    };
    pi.events?.on?.(OMNI_INPUT_STATUS_EVENT, omniStatusHandler);

    pi.registerCommand("ring-input", {
      description: "Inspect/configure the ring choice-input adapter. Usage: /ring-input status|mappings|on|off|settings key=value",
      handler: async (args, ctx) => {
        const raw = String(args || "status").trim() || "status";
        const action = raw.toLowerCase();
        if (action === "status") {
          ctx.ui.notify(`ring input: ${lastStatus.state} source=${inputSource} omni=${omniState} enabled=${envEnabled(env, ringConfig)} connections=${current ? 1 : 0} sessions=${activeSessions.size} ring=${env.PI_RING_CHOICE_RING || ringConfig.ring || "any"} command=${env.PI_RING_COMMAND || ringConfig.command || "ring"}${lastStatus.sessionId ? ` last-session=${lastStatus.sessionId}` : ""}${lastStatus.event ? ` event=${lastStatus.event}` : ""}${lastStatus.error ? ` error=${lastStatus.error}` : ""}`, lastStatus.state === "error" ? "warning" : "info");
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
          stop("disabled");
          ctx.ui.notify("ring choice input disabled for this session; startup settings unchanged", "info");
          return;
        }
        if (action === "on") {
          env.PI_RING_CHOICE_ENABLED = "1";
          ringConfig.enabled = true;
          if (activeSessions.size) ensureConnection();
          ctx.ui.notify("ring choice input enabled for this session; startup settings unchanged", "info");
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
            }
            ctx.ui.notify("ring input settings updated for this session; startup settings unchanged", "info");
          } catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); }
          return;
        }
        ctx.ui.notify("Usage: /ring-input status|mappings|on|off|settings key=value", "warning");
      },
    });

    pi.on("session_shutdown", () => {
      activeSessions.clear();
      stop("shutdown");
      try { pi.events?.off?.(CHOICE_SESSION_EVENT, choiceSessionHandler); } catch {}
      try { pi.events?.off?.(OMNI_INPUT_STATUS_EVENT, omniStatusHandler); } catch {}
    });
  };
}

export default createRingInputExtension();
