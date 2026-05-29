// Pi extension: quick slash command for model thinking/effort level.
//
// Pi already exposes the active/default thinking level through settings and the
// thinking selector. This extension adds a direct `/effort <level>` shortcut for
// the common case where the user wants to adjust reasoning effort without
// opening the settings UI.

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

export function supportsAdaptiveThinkingModel(model) {
  const id = String(model?.id || "").toLowerCase();
  return /(?:opus|sonnet)[-.]4[-.]6|(?:opus|sonnet)[-.]4[-.]7/.test(id);
}

function effortForLevel(level, model) {
  const mapped = level ? model?.thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === "string") return mapped;
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium") return "medium";
  if (level === "high") return "high";
  if (level === "xhigh") return model?.id?.includes?.("4.6") ? "max" : "xhigh";
  return undefined;
}

export function patchAdaptiveThinkingPayload(payload, { model, level, adaptive = false, fast = false } = {}) {
  if (!payload || typeof payload !== "object" || !supportsAdaptiveThinkingModel(model)) return payload;
  const next = { ...payload };
  const thinking = next.thinking && typeof next.thinking === "object" ? next.thinking : null;
  const wantsAdaptive = adaptive || fast || (thinking && thinking.type === "enabled");
  if (!wantsAdaptive) return payload;
  const display = thinking?.display ?? "summarized";
  next.thinking = { type: "adaptive", ...(display !== undefined ? { display } : {}) };
  const effort = fast ? "low" : effortForLevel(level, model);
  if (effort) next.output_config = { ...(next.output_config || {}), effort };
  return next;
}

export default function effortExtension(pi) {
  let adaptiveMode = false;
  let fastMode = false;

  pi.on?.("before_provider_request", (event, ctx) => patchAdaptiveThinkingPayload(event.payload, {
    model: ctx?.model,
    level: getThinkingLevel(pi, ctx),
    adaptive: adaptiveMode,
    fast: fastMode,
  }));

  pi.on?.("model_select", (_event, ctx) => {
    if (fastMode && !supportsAdaptiveThinkingModel(ctx?.model)) fastMode = false;
  });

  pi.registerCommand?.("effort", {
    description: "Show or set model thinking effort. Usage: /effort [off|minimal|low|medium|high|xhigh|adaptive]",
    handler: async (args, ctx) => {
      const token = firstToken(args);
      if (!token || token === "status" || token === "help") {
        const current = adaptiveMode ? `adaptive${fastMode ? "+fast" : ""}` : getThinkingLevel(pi, ctx);
        notify(ctx, formatEffortStatus({
          current,
          supportsThinking: supportsThinking(pi, ctx),
        }), "info");
        return;
      }

      const requested = normalizeEffortLevel(token);
      if (!requested) {
        notify(ctx, `Unsupported effort level: ${token}. Accepted values: ${EFFORT_LEVELS.join(", ")}. ${EFFORT_USAGE}`, "warning");
        return;
      }

      if (requested === "adaptive") {
        adaptiveMode = true;
        notify(ctx, `Effort: adaptive${fastMode ? " + fast" : ""}. Adaptive-capable Anthropic/Copilot models will use thinking.type=adaptive with output_config.effort when applicable.`, "info");
        return;
      }

      adaptiveMode = false;
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
    description: "Toggle fast adaptive thinking mode for models that support output_config.effort.",
    handler: async (args, ctx) => {
      const token = firstToken(args);
      const supported = supportsAdaptiveThinkingModel(ctx?.model ?? pi?.model);
      if (!supported && token !== "off") {
        notify(ctx, "Fast mode is only available for adaptive-thinking models such as Claude Opus/Sonnet 4.6+.", "warning");
        return;
      }
      const next = token === "on" ? true : token === "off" ? false : !fastMode;
      fastMode = next;
      if (fastMode) adaptiveMode = true;
      notify(ctx, `Fast mode ${fastMode ? "on" : "off"}${fastMode ? " (adaptive thinking effort=low)" : ""}.`, "info");
    },
  });
}
