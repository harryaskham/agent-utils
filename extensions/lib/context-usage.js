// Shared context-usage reader for Pi extensions (bd-78ac4f).
//
// Agents cannot otherwise see how full their own context is, so every
// compaction decision is a guess. Pi exposes the live figure to extensions via
// `ctx.getContextUsage()`, which returns `{ tokens, contextWindow, percent }`
// using the last assistant usage when available and estimating the trailing
// messages. `percent` can be null when there is not yet enough information.
//
// The accessor is resolved defensively: the shipped runtime has moved the name
// around across versions, and a hard dependency on one spelling would silently
// disable the usage surface after a Pi upgrade rather than fail loudly.

const ACCESSORS = ["getContextUsage", "n"];

/** Resolve and invoke whichever context-usage accessor this runtime exposes. */
export function readContextUsage(ctx) {
  if (!ctx) return null;
  for (const name of ACCESSORS) {
    const fn = ctx[name];
    if (typeof fn !== "function") continue;
    try {
      const usage = fn.call(ctx);
      if (usage && typeof usage === "object") return usage;
    } catch {
      // A throwing accessor must not take down the calling tool; try the next
      // spelling and fall through to "unavailable".
    }
  }
  return null;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize raw usage into a stable shape.
 *
 * `percent` is recomputed from tokens/contextWindow when the runtime does not
 * supply it, so callers get a usable figure whenever the raw numbers allow one.
 */
export function normalizeContextUsage(raw) {
  if (!raw) return { available: false, tokens: null, contextWindow: null, percent: null, remaining: null };
  const tokens = finiteOrNull(raw.tokens);
  const contextWindow = finiteOrNull(raw.contextWindow);
  let percent = finiteOrNull(raw.percent);
  if (percent === null && tokens !== null && contextWindow !== null && contextWindow > 0) {
    percent = (tokens / contextWindow) * 100;
  }
  const remaining = tokens !== null && contextWindow !== null ? Math.max(0, contextWindow - tokens) : null;
  return {
    available: tokens !== null || percent !== null,
    tokens,
    contextWindow,
    percent,
    remaining,
  };
}

/** Read and normalize in one step. */
export function getContextUsage(ctx) {
  return normalizeContextUsage(readContextUsage(ctx));
}

/** Compact human-readable summary, e.g. "62% used (124,000 / 200,000 tokens)". */
export function formatContextUsage(usage) {
  if (!usage || !usage.available) return "context usage unavailable in this runtime";
  const parts = [];
  if (usage.percent !== null) parts.push(`${usage.percent.toFixed(1)}% used`);
  if (usage.tokens !== null && usage.contextWindow !== null) {
    parts.push(`(${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens)`);
  } else if (usage.tokens !== null) {
    parts.push(`(${usage.tokens.toLocaleString()} tokens)`);
  }
  if (usage.remaining !== null) parts.push(`~${usage.remaining.toLocaleString()} remaining`);
  return parts.join(" ") || "context usage unavailable in this runtime";
}
