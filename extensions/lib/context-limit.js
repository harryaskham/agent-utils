// Per-session context limits: compact before Pi's own threshold.
//
// Pi compacts when the context nears the model's window (contextWindow - reserveTokens), so on a
// 1M-token model a long session sits at 400-900k tokens and every request re-reads all of it. A
// global lower threshold would cost the sessions that need the whole window. `/context 500k`
// sets a limit for one session; when the context passes it, the session compacts. The plugin
// does nothing until a limit is set, and it is not loaded unless listed:
// - TUI Pi: extensions/context-limit.js (compacts once the agent has settled: Pi's compact()
//   stops a running agent);
// - pi-daemon: extensions/durable/context-limit.mjs (Durable's background compaction, as soon as
//   a response passes the limit; the run goes on).

/** TUI Pi: the custom session entry holding a session's limit (`{ limit }`, null when off). */
export const CONTEXT_LIMIT_ENTRY = "agent-utils:context-limit";
/** pi-daemon: the module state key holding a session's limit. */
export const CONTEXT_LIMIT_KEY = "limit";
/** pi-daemon: the module's per-session state document (context-limit.mjs), as pi-client follows it. */
export const CONTEXT_LIMIT_DOC = Object.freeze({ kind: "pi-daemon.module-state", version: 1, scope: "session", key: "context-limit" });

/** TUI Pi: the limit recorded on a session's branch (its last context-limit entry), or null. */
export function branchContextLimit(entries) {
  for (let index = (entries?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === CONTEXT_LIMIT_ENTRY) return storedLimit(entry.data?.limit);
  }
  return null;
}

/** The smallest limit: below it a compaction's own summary and kept messages would not fit. */
export const MIN_CONTEXT_LIMIT = 20_000;
/** A limit that asked for compaction may ask again after this, if the context is still over it. */
export const RETRIGGER_MS = 10 * 60_000;

const UNITS = { "": 1, k: 1_000, m: 1_000_000 };

/**
 * `/context`'s argument: "" shows the limit; "off" (or none, 0) clears it; "500k", "1.2m" or
 * "300000" sets it.
 */
export function parseContextLimit(text) {
  const value = String(text ?? "").trim().toLowerCase();
  if (value === "") return { show: true };
  if (value === "off" || value === "none" || value === "0") return { limit: null };
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)(?:\s*tokens?)?$/.exec(value);
  if (!match) return { error: `Not a limit: ${text}. Use /context 500k, /context 1.2m, or /context off.` };
  const limit = Math.round(Number(match[1]) * UNITS[match[2]]);
  if (!Number.isFinite(limit) || limit < MIN_CONTEXT_LIMIT) {
    return { error: `A context limit must be at least ${formatTokens(MIN_CONTEXT_LIMIT)} tokens.` };
  }
  return { limit };
}

/** 500000 → "500k", 1200000 → "1.2M". */
export function formatTokens(tokens) {
  if (!Number.isFinite(tokens)) return "?";
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(2))}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

/**
 * The context after a response, from its usage: what was sent (input, cache read and write) and
 * what came back (output), which the next request carries. 0 when unknown.
 */
export function responseContext(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const n = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
  return n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite) + n(usage.output);
}

/**
 * A conversation's context from its transcript, as pi-daemon's footer measures it
 * (session-calls.ts contextUsage): the newest response's usage, skipping aborted and failed
 * responses, back to the last compaction or reset. Undefined when nothing measures it.
 */
export function transcriptContext(entries) {
  const list = Array.isArray(entries) ? entries : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const entry = list[index];
    if (entry?.kind === "pi.compaction" || entry?.kind === "pi.reset") return undefined;
    if (entry?.kind !== "pi.assistant") continue;
    const message = (Array.isArray(entry.model) ? entry.model : []).find((candidate) => candidate?.role === "assistant");
    if (message?.usage === undefined || message.stopReason === "aborted" || message.stopReason === "error") continue;
    const total = Number(message.usage.totalTokens);
    const tokens = Number.isFinite(total) && total > 0 ? total : responseContext(message.usage);
    return tokens > 0 ? tokens : undefined;
  }
  return undefined;
}

/** A valid stored limit, or null. */
export function storedLimit(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_CONTEXT_LIMIT ? value : null;
}

/** What `/context` says about a session; `compacting`: it is over the limit and compacts now. */
export function describeLimit(limit, tokens, { compacting = false } = {}) {
  const now = Number.isFinite(tokens) && tokens > 0 ? ` (now ${formatTokens(tokens)})` : "";
  if (limit === null) {
    return `No context limit for this session${now}: it compacts at the model's own threshold. Set one with /context 500k.`;
  }
  const action = compacting ? " It is over that now, so it is compacting in the background." : "";
  return `This session compacts when its context passes ${formatTokens(limit)} tokens${now}.${action} /context off removes the limit.`;
}
