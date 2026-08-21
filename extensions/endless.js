// Runtime-only /endless mode: resume an otherwise settled agent after a delay.
// Durable settings define the default message and delay; enabling/disabling the
// loop is deliberately session-local.

import { expandEnvReferences, parseEnvStyleArgs } from "./lib/env-args.js";
import { agentSettingsPath, readAgentSettings } from "./pi-graphics/agent-io.js";

export const DEFAULT_ENDLESS_MESSAGE = "You are in endless mode; stopping is disabled";
export const DEFAULT_ENDLESS_DELAY_SECONDS = 60;

function boolValue(value, name) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

export function resolveEndlessSettings({ env = process.env, persisted = {} } = {}) {
  const delayRaw = env.PI_ENDLESS_DELAY ?? persisted.delay ?? DEFAULT_ENDLESS_DELAY_SECONDS;
  const delay = Number(delayRaw);
  return {
    defaultMessage: expandEnvReferences(
      env.PI_ENDLESS_DEFAULT_MESSAGE ?? persisted.defaultMessage ?? DEFAULT_ENDLESS_MESSAGE,
      env,
      "/endless defaultMessage",
    ),
    delay: Number.isFinite(delay) && delay >= 0 && delay <= 86400 ? delay : DEFAULT_ENDLESS_DELAY_SECONDS,
  };
}

export function parseEndlessArgs(input, { env = process.env, defaults = resolveEndlessSettings({ env }) } = {}) {
  const parsed = parseEnvStyleArgs(input);
  let delay = defaults.delay;
  let compact = false;
  const messageTokens = [];
  for (const token of parsed.tokens) {
    const equals = token.indexOf("=");
    const key = equals > 0 ? token.slice(0, equals).toLowerCase() : "";
    const value = equals > 0 ? token.slice(equals + 1) : "";
    if (key === "delay") {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 86400) throw new Error("/endless: delay must be 0..86400 seconds");
      delay = number;
    } else if (key === "compact") compact = boolValue(value, "/endless compact");
    else messageTokens.push(token);
  }
  const rawMessage = messageTokens.join(" ").trim();
  const action = rawMessage.toLowerCase();
  if (["off", "stop", "disable"].includes(action)) return { action: "off", delay, compact, message: "" };
  if (action === "status") return { action: "status", delay, compact, message: "" };
  const message = !rawMessage || action === "on" || action === "start" || action === "enable"
    ? defaults.defaultMessage
    : expandEnvReferences(rawMessage, env, "/endless message");
  return { action: "on", delay, compact, message };
}

export function createEndlessExtension({
  env = process.env,
  settingsPath,
  persistedSettings,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  return function endlessExtension(pi) {
    const persisted = persistedSettings ?? readAgentSettings(settingsPath ?? agentSettingsPath())?.agentUtils?.endless ?? {};
    const defaults = resolveEndlessSettings({ env, persisted });
    let enabled = false;
    let message = defaults.defaultMessage;
    let delay = defaults.delay;
    let compact = false;
    let timer = null;
    let compacting = false;
    let generation = 0;

    const updateStatus = (ctx) => {
      try {
        if (!enabled) ctx?.ui?.setStatus?.("agent-utils-endless", undefined);
        else ctx?.ui?.setStatus?.("agent-utils-endless", `endless · ${delay}s${compact ? " · compact" : ""}${timer ? " · scheduled" : compacting ? " · compacting" : ""}`);
      } catch {}
    };

    const cancelTimer = () => {
      if (timer) clearTimer(timer);
      timer = null;
    };

    const deliver = (ctx, expectedGeneration) => {
      if (!enabled || generation !== expectedGeneration) return;
      compacting = false;
      updateStatus(ctx);
      try { pi.sendUserMessage(message); }
      catch (error) {
        try { ctx?.ui?.notify?.(`endless resume failed: ${error?.message || String(error)}`, "warning"); } catch {}
      }
    };

    const afterDelay = (ctx, expectedGeneration) => {
      timer = null;
      if (!enabled || generation !== expectedGeneration) return;
      if (!compact) { deliver(ctx, expectedGeneration); return; }
      compacting = true;
      updateStatus(ctx);
      const fallback = (error) => {
        if (!enabled || generation !== expectedGeneration) return;
        try { ctx?.ui?.notify?.(`endless compaction failed; resuming without it: ${error?.message || String(error)}`, "warning"); } catch {}
        deliver(ctx, expectedGeneration);
      };
      if (typeof ctx?.compact !== "function") { fallback(new Error("compaction API unavailable")); return; }
      try {
        ctx.compact({
          customInstructions: "Preserve current goals, active work, validation state, blockers, and the endless resume instruction.",
          onComplete: () => deliver(ctx, expectedGeneration),
          onError: fallback,
        });
      } catch (error) { fallback(error); }
    };

    const schedule = (ctx) => {
      if (!enabled || timer || compacting) return false;
      const expectedGeneration = generation;
      timer = setTimer(() => afterDelay(ctx, expectedGeneration), delay * 1000);
      updateStatus(ctx);
      return true;
    };

    pi.registerCommand("endless", {
      description: "Resume the agent whenever it fully settles. Usage: /endless [off|status|delay=60 compact=true] [message text]",
      handler: async (args, ctx) => {
        let parsed;
        try { parsed = parseEndlessArgs(args, { env, defaults }); }
        catch (error) { ctx.ui.notify(error?.message || String(error), "warning"); return; }
        if (parsed.action === "status") {
          ctx.ui.notify(`endless:${enabled ? "on" : "off"} · delay=${delay}s · compact=${compact} · ${timer ? "scheduled" : compacting ? "compacting" : "idle"}`, "info");
          return;
        }
        generation += 1;
        cancelTimer();
        compacting = false;
        if (parsed.action === "off") {
          enabled = false;
          updateStatus(ctx);
          ctx.ui.notify("endless:off (runtime; startup defaults unchanged)", "info");
          return;
        }
        enabled = true;
        message = parsed.message;
        delay = parsed.delay;
        compact = parsed.compact;
        schedule(ctx);
        ctx.ui.notify(`endless:on · delay=${delay}s · compact=${compact} · resume scheduled`, "info");
      },
    });

    // agent_end is too early: Pi may still retry, compact, or process a queued
    // follow-up. agent_settled is the documented "will actually stop" signal.
    pi.on("agent_settled", (_event, ctx) => { schedule(ctx); });
    pi.on("session_shutdown", (_event, ctx) => {
      generation += 1;
      enabled = false;
      compacting = false;
      cancelTimer();
      updateStatus(ctx);
    });
  };
}

export default createEndlessExtension();
