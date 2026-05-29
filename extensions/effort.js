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
  return model?.reasoning === true;
}

function normalizeEffortValue(value) {
  const effort = String(value || "").trim().toLowerCase();
  return effort || undefined;
}

function modelSupportedEfforts(model) {
  const modelId = String(model?.id || "").toLowerCase();
  const provider = String(model?.provider || "").toLowerCase();
  const baseModelId = modelId.endsWith("-fast") ? modelId.slice(0, -5) : modelId;
  if (provider === "github-copilot" && baseModelId === "claude-opus-4.8") return ["medium"];

  const candidates = [
    model?.supportedOutputConfigEfforts,
    model?.outputConfigEfforts,
    model?.output_config_efforts,
    model?.supportedEfforts,
    model?.effortValues,
    model?.outputConfig?.efforts,
    model?.output_config?.efforts,
  ];
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    const values = candidate.map(normalizeEffortValue).filter(Boolean);
    if (values.length > 0) return [...new Set(values)];
  }
  return undefined;
}

function clampEffortToModel(candidate, model) {
  const effort = normalizeEffortValue(candidate);
  if (!effort) return undefined;
  const supported = modelSupportedEfforts(model);
  if (!supported?.length) return effort;
  if (supported.includes(effort)) return effort;
  if (supported.includes("medium")) return "medium";
  return supported[0];
}

function modelRequiresAdaptiveThinkingFormat(model) {
  const compat = model?.compat || {};
  const format = String(
    model?.thinkingFormat ??
    model?.thinking_format ??
    model?.thinking?.format ??
    compat.thinkingFormat ??
    compat.thinking_format ??
    compat.thinking?.format ??
    "",
  ).trim().toLowerCase();
  if (["adaptive", "anthropic-adaptive", "output-config", "output_config"].includes(format)) return true;
  if (model?.adaptiveThinking === true || model?.adaptive_thinking === true || model?.requiresAdaptiveThinking === true) return true;
  if (compat.adaptiveThinking === true || compat.adaptive_thinking === true || compat.requiresAdaptiveThinking === true) return true;
  return false;
}

function effortForLevel(level, model) {
  const mapped = level ? model?.thinkingLevelMap?.[level] : undefined;
  if (typeof mapped === "string") return clampEffortToModel(mapped, model);
  if (level === "minimal" || level === "low") return clampEffortToModel("low", model);
  if (level === "medium") return clampEffortToModel("medium", model);
  if (level === "high") return clampEffortToModel("high", model);
  if (level === "xhigh") return clampEffortToModel("xhigh", model);
  if (level === "adaptive") return clampEffortToModel("medium", model);
  return undefined;
}

export function patchAdaptiveThinkingPayload(payload, { model, level, adaptive = false } = {}) {
  if (!payload || typeof payload !== "object" || !supportsAdaptiveThinkingModel(model)) return payload;
  const next = { ...payload };
  const thinking = next.thinking && typeof next.thinking === "object" ? next.thinking : null;
  const wantsAdaptive = adaptive || (thinking?.type === "enabled" && modelRequiresAdaptiveThinkingFormat(model));
  if (!wantsAdaptive) return payload;
  const display = thinking?.display ?? "summarized";
  next.thinking = { type: "adaptive", ...(display !== undefined ? { display } : {}) };
  const effort = effortForLevel(level || "medium", model);
  if (effort) next.output_config = { ...(next.output_config || {}), effort };
  return next;
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
  let adaptiveMode = false;

  pi.on?.("before_provider_request", (event, ctx) => patchAdaptiveThinkingPayload(event.payload, {
    model: ctx?.model,
    level: getThinkingLevel(pi, ctx),
    adaptive: adaptiveMode,
  }));

  pi.registerCommand?.("effort", {
    description: "Show or set model thinking effort. Usage: /effort [off|minimal|low|medium|high|xhigh|adaptive]",
    handler: async (args, ctx) => {
      const token = firstToken(args);
      if (!token || token === "status" || token === "help") {
        const current = adaptiveMode ? "adaptive" : getThinkingLevel(pi, ctx);
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
        notify(ctx, "Effort: adaptive. Reasoning-capable models will use thinking.type=adaptive with output_config.effort according to model settings.", "info");
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
