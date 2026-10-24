// pi-daemon module: a per-session context limit (/context 500k). See ../lib/context-limit.js.
//
// List it in a profile's extensions to use it; it does nothing until /context sets a limit for a
// session (kept in the module's per-session state). When a response's context passes the limit,
// its observer asks for Durable's background compaction (pi-daemon's info.compact, 1.14 and
// later): the run goes on and the summary is placed at the next boundary. It asks once, and again
// only if the context is still over the limit after RETRIGGER_MS.
import {
  CONTEXT_LIMIT_KEY,
  RETRIGGER_MS,
  describeLimit,
  parseContextLimit,
  responseContext,
  storedLimit,
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
      const tokens = latest.get(`${ctx.sessionId}\u0000${ctx.conversationId}`);
      ctx.notify(describeLimit(limit, tokens));
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
