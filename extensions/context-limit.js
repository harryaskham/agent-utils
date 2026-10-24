// Pi extension: a per-session context limit (/context 500k). See lib/context-limit.js.
//
// Not in agent-utils' package manifest: list it in settings.json's `extensions` to use it. It does
// nothing until /context sets a limit for a session. The limit is a custom session entry, so it
// follows the session (and its branches) across restarts.
//
// When the context passes the limit, the session compacts once the agent has settled: Pi's
// compact() stops a running agent, so as self-compact.js does it waits for agent_settled, leaves
// the event dispatcher, and compacts only if Pi is idle with nothing pending. RPC and Paratenic's
// AHP bridge are left alone (compact() would abort their own request).
import {
  CONTEXT_LIMIT_ENTRY,
  describeLimit,
  formatTokens,
  parseContextLimit,
  responseContext,
  storedLimit,
} from "./lib/context-limit.js";

const STATUS_KEY = "context-limit";

/** The limit recorded on the session's branch (its last context-limit entry), or null. */
export function branchLimit(entries) {
  for (let index = (entries?.length ?? 0) - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "custom" && entry.customType === CONTEXT_LIMIT_ENTRY) return storedLimit(entry.data?.limit);
  }
  return null;
}

/** The session's context now: Pi's own measure, else the last response's usage. */
function contextTokens(ctx) {
  const usage = ctx?.getContextUsage?.();
  if (usage && Number.isFinite(usage.tokens) && usage.tokens > 0) return usage.tokens;
  const entries = ctx?.sessionManager?.getBranch?.() ?? [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message;
    if (message?.role === "assistant" && message.usage) return responseContext(message.usage);
  }
  return 0;
}

function supported(ctx) {
  return ctx?.mode !== "rpc" && !globalThis[Symbol.for("paratenic.pi.ahp-bridge.v1")]?.enabled;
}

export default function contextLimitExtension(pi, { defer = (fn) => setTimeout(fn, 0) } = {}) {
  if (typeof pi?.registerCommand !== "function" || typeof pi?.on !== "function") return;
  let limit = null;
  let compacting = false;

  const showStatus = (ctx) => ctx?.ui?.setStatus?.(STATUS_KEY, limit === null ? undefined : `ctx≤${formatTokens(limit)}`);
  const restore = (_event, ctx) => {
    limit = branchLimit(ctx?.sessionManager?.getBranch?.() ?? ctx?.sessionManager?.getEntries?.() ?? []);
    compacting = false;
    showStatus(ctx);
  };
  for (const event of ["session_start", "session_tree"]) pi.on(event, restore);

  pi.registerCommand("context", {
    description: "Limit this session's context: /context 500k compacts it past 500k tokens; /context off; /context shows it",
    handler: async (args, ctx) => {
      const parsed = parseContextLimit(args);
      if (parsed.error) {
        ctx?.ui?.notify?.(parsed.error, "error");
        return;
      }
      if (!parsed.show) {
        limit = parsed.limit;
        pi.appendEntry?.(CONTEXT_LIMIT_ENTRY, { limit });
        showStatus(ctx);
      }
      const tokens = contextTokens(ctx);
      ctx?.ui?.notify?.(describeLimit(limit, tokens), "info");
      // Already over a new limit and idle: compact now.
      if (!parsed.show && limit !== null && tokens > limit && ctx?.isIdle?.() === true) compactIfOver(ctx);
    },
  });

  const compactIfOver = (ctx) => {
    if (limit === null || compacting || !supported(ctx) || typeof ctx?.compact !== "function") return;
    const tokens = contextTokens(ctx);
    if (!(tokens > limit)) return;
    // Leave the event dispatcher before compact() -> abort() waits for it.
    defer(() => {
      if (compacting || limit === null || ctx?.isIdle?.() !== true || ctx?.hasPendingMessages?.()) return;
      compacting = true;
      ctx?.ui?.notify?.(`Context ${formatTokens(tokens)} is past this session's limit of ${formatTokens(limit)}: compacting.`, "info");
      const done = (error) => {
        compacting = false;
        if (error) ctx?.ui?.notify?.(`Compaction for the context limit failed: ${error?.message || error}`, "error");
      };
      try {
        ctx.compact({ onComplete: () => done(), onError: done });
      } catch (error) {
        done(error);
      }
    });
  };
  pi.on("agent_settled", (_event, ctx) => compactIfOver(ctx));
}
