// Pi extension: quick slash command for model thinking/effort level.
//
// Pi already exposes the active/default thinking level through settings and the
// thinking selector. This extension adds a direct `/effort <level>` shortcut for
// the common case where the user wants to adjust reasoning effort without
// opening the settings UI.

export const EFFORT_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh"]);
export const EFFORT_USAGE = "Usage: /effort [status|off|minimal|low|medium|high|xhigh]";

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

export default function effortExtension(pi) {
  pi.registerCommand?.("effort", {
    description: "Show or set model thinking effort. Usage: /effort [off|minimal|low|medium|high|xhigh]",
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
}
