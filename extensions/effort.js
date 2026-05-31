// Pi extension: quick slash command for model thinking/effort level.
//
// Pi core owns thinking/adaptive-thinking request semantics and model metadata.
// This extension is intentionally only a UI shortcut: `/effort <level>` delegates
// to Pi's thinking-level API exactly as-is and never rewrites provider payloads.

export const EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"]);
export const EFFORT_USAGE = "Usage: /effort [status|off|minimal|low|medium|high|xhigh|adaptive]";

export function normalizeEffortLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  return EFFORT_LEVELS.includes(level) ? level : undefined;
}

export function formatEffortStatus({ current, supportsThinking } = {}) {
  const support = supportsThinking === false ? "current model does not support thinking; effective effort is off" : "current model supports thinking or support is unknown";
  return [
    `Current effort: ${current || "unknown"}`,
    `Model support: ${support}`,
    `Accepted values: ${EFFORT_LEVELS.join(", ")}`,
    EFFORT_USAGE,
  ].join("\n");
}

function firstToken(args) {
  return String(args || "").trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() || "";
}

function notify(ctx, message, level = "info") {
  ctx?.ui?.notify?.(message, level);
}

function getThinkingLevel(pi, ctx) {
  if (typeof pi.getThinkingLevel === "function") return pi.getThinkingLevel();
  if (typeof ctx?.getThinkingLevel === "function") return ctx.getThinkingLevel();
  return undefined;
}

function setThinkingLevel(pi, ctx, level) {
  if (typeof pi.setThinkingLevel === "function") {
    pi.setThinkingLevel(level);
    return true;
  }
  if (typeof ctx?.setThinkingLevel === "function") {
    ctx.setThinkingLevel(level);
    return true;
  }
  return false;
}

function supportsThinking(pi, ctx) {
  if (typeof pi.supportsThinking === "function") return pi.supportsThinking();
  if (typeof ctx?.supportsThinking === "function") return ctx.supportsThinking();
  return undefined;
}

function currentModel(ctx, pi) {
  return ctx?.model ?? pi?.model ?? null;
}

function fastCounterpartId(id, force) {
  const modelId = String(id || "").trim();
  if (!modelId) return undefined;
  const isFast = modelId.endsWith("-fast");
  if (force === true) return isFast ? modelId : `${modelId}-fast`;
  if (force === false) return isFast ? modelId.slice(0, -5) : modelId;
  return isFast ? modelId.slice(0, -5) : `${modelId}-fast`;
}

function findFastCounterpart(ctx, model, force) {
  const provider = model?.provider;
  const targetId = fastCounterpartId(model?.id, force);
  if (!provider || !targetId) return null;
  return ctx?.modelRegistry?.find?.(provider, targetId) || null;
}

export default function effortExtension(pi) {
  pi.agentUtilsEffort = {
    getLevel(ctx) { return getThinkingLevel(pi, ctx); },
    isAdaptive(ctx) { return getThinkingLevel(pi, ctx) === "adaptive"; },
  };

  pi.registerCommand?.("effort", {
    description: "Show or set model thinking effort. Usage: /effort [off|minimal|low|medium|high|xhigh|adaptive]",
    handler: async (args, ctx) => {
      const token = firstToken(args);
      if (!token || token === "status" || token === "help") {
        notify(ctx, formatEffortStatus({
          current: getThinkingLevel(pi, ctx),
          supportsThinking: supportsThinking(pi, ctx),
        }), "info");
        return;
      }

      const requested = normalizeEffortLevel(token);
      if (!requested) {
        notify(ctx, `Unsupported effort level: ${token}. Accepted values: ${EFFORT_LEVELS.join(", ")}. ${EFFORT_USAGE}`, "warning");
        return;
      }

      const before = getThinkingLevel(pi, ctx);
      if (!setThinkingLevel(pi, ctx, requested)) {
        notify(ctx, "This Pi runtime does not expose thinking-level controls; update Pi or use /settings.", "error");
        return;
      }
      const after = getThinkingLevel(pi, ctx) || requested;
      const clamped = after !== requested ? ` (requested ${requested}; clamped by the current model)` : "";
      const unchanged = before === after ? " unchanged" : "";
      notify(ctx, `Effort${unchanged}: ${after}${clamped}.`, "info");
    },
  });

  pi.registerCommand?.("fast", {
    description: "Toggle between the current model and its -fast counterpart when both are configured.",
    handler: async (args, ctx) => {
      const token = firstToken(args);
      const force = token === "on" ? true : token === "off" ? false : token ? undefined : null;
      if (token && force === undefined) {
        notify(ctx, "Unsupported fast mode argument. Use /fast, /fast on, or /fast off.", "warning");
        return;
      }
      const model = currentModel(ctx, pi);
      const target = findFastCounterpart(ctx, model, force ?? undefined);
      if (!target) {
        notify(ctx, `Fast mode unavailable: no ${fastCounterpartId(model?.id, force ?? undefined) || "-fast"} counterpart is configured for the current model.`, "warning");
        return;
      }
      if (typeof pi.setModel !== "function") {
        notify(ctx, "This Pi runtime does not expose model switching controls; update Pi or use /model.", "error");
        return;
      }
      const ok = await pi.setModel(target);
      if (!ok) {
        notify(ctx, `Fast mode switch failed: could not select ${target.provider}/${target.id}.`, "error");
        return;
      }
      notify(ctx, `Fast mode ${target.id.endsWith("-fast") ? "on" : "off"}: selected ${target.provider}/${target.id}.`, "info");
    },
  });
}
