// pi-daemon module: a per-session context limit (/context 500k). See ../lib/context-limit.js.
//
// List it in a profile's extensions to use it; it does nothing until /context sets a limit for a
// session (kept in the module's per-session state).
//
// On Pi 1.5.2 and later the limit is written as the conversation's own compaction setting
// (Durable's configure({ compaction }): an override for its model whose reserveTokens is the
// window less the limit). Durable then keeps every request under the limit, starting a
// background compaction shortly before, and the setting holds over the profile's threshold for
// that model: a limit above the profile's raises it for this session. Forks and sub-agents
// inherit it.
//
// On earlier hosts, and for a model the limit was not written for (the session changed model),
// the observer asks for Durable's background compaction when a response's context passes the
// limit (pi-daemon's info.compact, 1.14 and later): the run goes on and the summary is placed at
// the next boundary. It asks once, and again only if the context is still over the limit after
// RETRIGGER_MS. That can only compact earlier than the profile's threshold, never later.
//
// /context measures an idle session from its transcript (as the footer does), and a limit set
// below the current size compacts at once, through the command's conversation, as pi-daemon's
// /compact does (bd-da24a9).
import {
  CONTEXT_LIMIT_KEY,
  CONTEXT_NATIVE_KEY,
  RETRIGGER_MS,
  compactionWithLimit,
  describeLimit,
  formatTokens,
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

/**
 * Write `limit` (null: none) as the conversation's own compaction setting for its model.
 * Resolves to `{ model }` when Durable holds it (read back: an earlier Durable ignores the
 * field), `{ error }` when the limit cannot be one for this model, and `{}` when the host or
 * the model does not allow it (the observer then keeps the limit).
 */
async function writeNative(conversation, ctx, limit, previous) {
  if (typeof conversation?.agent !== "function" || typeof conversation.configure !== "function") return {};
  const agent = await conversation.agent(ctx.context);
  const ref = agent?.model;
  if (typeof ref?.provider !== "string" || typeof ref?.modelId !== "string") return {};
  const model = `${ref.provider}/${ref.modelId}`;
  let current = agent.compaction;
  // The limit written for another model (the session changed model since) goes with it.
  if (typeof previous === "string" && previous !== model) current = compactionWithLimit(current, previous, 0, null);
  if (limit === null) {
    await conversation.configure({ compaction: compactionWithLimit(current, model, 0, null) }, ctx.context);
    return {};
  }
  const window = ctx.modelRegistry?.find?.(ref.provider, ref.modelId)?.contextWindow;
  if (!(Number.isSafeInteger(window) && window > 0)) return {};
  if (limit >= window) return { error: `A context limit for ${ref.modelId} must be under its window of ${formatTokens(window)} tokens.` };
  await conversation.configure({ compaction: compactionWithLimit(current, model, window, limit) }, ctx.context);
  const held = (await conversation.agent(ctx.context))?.compaction?.modelOverrides?.[model]?.reserveTokens === window - limit;
  return held ? { model } : {};
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
      let conversation;
      const open = async () => (conversation ??= await commandConversation(ctx).catch(() => undefined));
      if (!parsed.show) {
        // First as the conversation's own compaction setting, where the host has them.
        let written = {};
        try {
          written = await writeNative(await open(), ctx, parsed.limit, await ctx.state.get(CONTEXT_NATIVE_KEY));
        } catch {
          written = {};
        }
        if (written.error) {
          ctx.notify(written.error);
          return;
        }
        await ctx.state.set(CONTEXT_LIMIT_KEY, parsed.limit === null ? undefined : parsed.limit);
        await ctx.state.set(CONTEXT_NATIVE_KEY, written.model);
      }
      const limit = storedLimit(await ctx.state.get(CONTEXT_LIMIT_KEY));
      const native = limit !== null && typeof (await ctx.state.get(CONTEXT_NATIVE_KEY)) === "string";
      const key = `${ctx.sessionId}\u0000${ctx.conversationId}`;
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
      ctx.notify(describeLimit(limit, tokens, { compacting, native }));
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
  // Durable keeps the limit itself for the model it was written for.
  const native = await info.state.get(CONTEXT_NATIVE_KEY);
  if (typeof native === "string" && native === `${response.provider}/${response.model}`) {
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
