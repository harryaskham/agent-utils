// pi-daemon module: a per-session context limit (/context 500k). See ../lib/context-limit.js.
//
// List it in a profile's extensions to use it; it does nothing until /context sets a limit for a
// session (kept in the module's per-session state). When a response's context passes the limit,
// its observer asks for Durable's background compaction (pi-daemon's info.compact, 1.14 and
// later): the run goes on and the summary is placed at the next boundary. It asks once, and again
// only if the context is still over the limit after RETRIGGER_MS. /context measures an idle
// session from its transcript (as the footer does), and a limit set below the current size
// compacts at once, through the command's conversation, as pi-daemon's /compact does (bd-da24a9).
import {
  CONTEXT_LIMIT_KEY,
  RETRIGGER_MS,
  describeLimit,
  parseContextLimit,
  responseContext,
  storedLimit,
  transcriptContext,
} from "../lib/context-limit.js";

/** Per session and conversation: when the limit last asked for a compaction. */
const asked = new Map();
/** Per session and conversation: the context after the latest response. */
const latest = new Map();
const MAX_TRACKED = 1024;

function remember(map, key, value) {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value);
}

/**
 * The conversation a module command runs in (pi-daemon's harness), or undefined on hosts that do
 * not give commands the harness.
 */
async function commandConversation(ctx) {
  if (ctx.conversationId === undefined || typeof ctx.harness?.conversation !== "function") return undefined;
  return ctx.harness.conversation(ctx.conversationId, ctx.context);
}

export const commands = {
  context: {
    description: "Limit this session's context: /context 500k compacts it past 500k tokens; /context off; /context shows it",
    async run(args, ctx) {
      const parsed = parseContextLimit(args);
      if (parsed.error) {
        ctx.notify(parsed.error);
        return;
      }
      if (!parsed.show) await ctx.state.set(CONTEXT_LIMIT_KEY, parsed.limit === null ? undefined : parsed.limit);
      const limit = storedLimit(await ctx.state.get(CONTEXT_LIMIT_KEY));
      const key = `${ctx.sessionId}\u0000${ctx.conversationId}`;
      let conversation;
      const open = async () => (conversation ??= await commandConversation(ctx).catch(() => undefined));
      // The conversation's transcript measures it, as the footer does: also with no response
      // since this worker started (an idle session, or after a restart), and right after a
      // compaction (nothing measures it until the next response). Hosts without the harness
      // fall back to the last response seen.
      let tokens = latest.get(key);
      try {
        const view = await (await open())?.context?.(ctx.context);
        if (view !== undefined) {
          tokens = transcriptContext(view.entries);
          if (tokens === undefined) latest.delete(key);
          else remember(latest, key, tokens);
        }
      } catch {
        // Unmeasured here: the last response's size, if any.
      }
      // A new limit below the current size compacts now (Durable compacts in the background),
      // rather than waiting for a response that an idle session may never get.
      let compacting = false;
      if (!parsed.show && limit !== null && tokens !== undefined && tokens > limit) {
        const last = asked.get(key);
        if (last === undefined || Date.now() - last >= RETRIGGER_MS) {
          try {
            const target = await open();
            if (typeof target?.compact === "function") {
              await target.compact(undefined, ctx.context);
              remember(asked, key, Date.now());
              compacting = true;
            }
          } catch {
            // The next response over the limit asks again.
          }
        }
      }
      ctx.notify(describeLimit(limit, tokens, { compacting }));
    },
  },
};

/** The response a message_end reports: Durable's committed entry, or a coding-agent message. */
function responseOf(event) {
  if (event?.type !== "message_end") return undefined;
  const messages = Array.isArray(event.entry?.model) ? event.entry.model : [event.message];
  return messages.find((message) => message?.role === "assistant");
}

export async function observe(event, info) {
  const response = responseOf(event);
  if (response === undefined) return;
  const tokens = responseContext(response.usage);
  if (tokens <= 0) return;
  const key = `${info.sessionId}\u0000${info.conversationId}`;
  remember(latest, key, tokens);
  const limit = storedLimit(await info.state.get(CONTEXT_LIMIT_KEY));
  if (limit === null || tokens <= limit) {
    asked.delete(key);
    return;
  }
  const last = asked.get(key);
  if (last !== undefined && Date.now() - last < RETRIGGER_MS) return;
  if (typeof info.compact !== "function") return;
  remember(asked, key, Date.now());
  try {
    await info.compact();
  } catch {
    // The next response over the limit asks again after RETRIGGER_MS.
  }
}
