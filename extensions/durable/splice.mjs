// /splice for pi-daemon sessions (pi-client, the web view, Culture, AHP clients): copy turns
// of another agent session into this conversation. See docs/session-splice.md.
//
// List this file in a pi-daemon profile's `extensions:`. It runs on the session's host:
// sources are read over `/chord` (this host's pi-daemon from PI_DAEMON_URL and
// PI_DAEMON_TOKEN_FILE, other hosts from Pi's settings.json `client.hosts`) or from this host's
// TUI Pi session files. The spliced messages are written as ordinary user, assistant and
// tool-result entries, as pi-daemon's own import writes them, so every client shows them;
// each carries its provenance in `data.splice`. While the conversation works the writes queue
// and land, in order, at its next boundary. The command takes arguments only (no pickers):
// /splice list and /splice show SRC help choose them. Needs only Node built-ins.

import {
  SPLICE_USAGE,
  buildSplice,
  describeTurns,
  parseSpliceArgs,
  resolveRange,
  segmentTurns,
  selectTurns,
  summaryRequest,
} from "../lib/session-splice.js";
import { listSources, loadSource } from "../lib/session-splice-sources.js";
import { runPiTextTurn } from "../lib/pi-inference.js";

/** The Durable entry of one spliced message: pi-daemon's own kinds, with the splice's provenance. */
export function spliceEntry(message, provenance) {
  switch (message.role) {
    case "user":
      return { kind: "pi.user", model: [message], data: { splice: provenance } };
    case "assistant":
      return { kind: "pi.assistant", model: [message], data: { splice: provenance } };
    default:
      return { kind: "pi.tool-result", model: [message], data: { diagnostics: [], splice: provenance } };
  }
}

async function summarizeWith(ctx, conversation, request) {
  const agent = await conversation.agent(ctx.context);
  const ref = agent?.model;
  const model = ref && ctx.modelRegistry?.find?.(ref.provider, ref.modelId ?? ref.id);
  if (!model) throw new Error("method=summary needs this session's model, which this host does not give modules");
  return (await runPiTextTurn({ modelRegistry: ctx.modelRegistry }, { model, ...request, maxTokens: 4_000 })).text;
}

/** /splice, with its I/O injectable for tests. */
export function createSpliceCommand({ load = loadSource, list = listSources, summarize = summarizeWith, env = process.env } = {}) {
  return {
    description: "Copy turns of another session into this one: /splice list, /splice show SRC, /splice SRC last=2 method=summary",
    getArgumentCompletions(prefix) {
      const words = ["list", "show", "help", "last=", "turns=", "method=text", "method=summary", "method=verbatim", "tools=collapse", "tools=keep", "tools=drop", "thinking=keep", "guard=off", "focus=", "max=", "host="];
      const text = String(prefix ?? "");
      const last = text.split(/\s+/).pop() ?? "";
      const head = text.slice(0, text.length - last.length);
      const matches = words.filter((word) => word.startsWith(last)).map((word) => ({ value: `${head}${word}`, label: word }));
      return matches.length ? matches : null;
    },
    async run(args, ctx) {
      let options;
      try {
        options = parseSpliceArgs(args);
      } catch (error) {
        ctx.notify(`/splice: ${error.message}\n\n${SPLICE_USAGE}`);
        return;
      }
      try {
        if (options.action === "help") {
          ctx.notify(SPLICE_USAGE);
          return;
        }
        if (options.action === "list" || options.src === undefined) {
          const listed = await list({ host: options.host, env });
          const lines = listed.sources.map((source) => `${source.src}\n    ${source.label}`);
          const intro = options.action === "list" ? `Sessions on ${listed.host}:` : `/splice: give a source session.\n\n${SPLICE_USAGE}\n\nSessions on ${listed.host}:`;
          ctx.notify([intro, ...lines, ...listed.errors].join("\n"));
          return;
        }
        const source = await load(options.src, { conversation: options.conversation, env });
        const turns = segmentTurns(source.messages);
        const count = turns.filter((turn) => turn.index > 0).length;
        if (options.action === "show") {
          ctx.notify(`${source.host}/${source.sessionId} (${source.title}): ${count} turns\n${describeTurns(turns)}`);
          return;
        }
        if (ctx.conversationId === undefined || typeof ctx.harness?.conversation !== "function") {
          ctx.notify("/splice needs a pi-daemon that gives module commands its harness (1.10 or later).");
          return;
        }
        const conversation = await ctx.harness.conversation(ctx.conversationId, ctx.context);
        if (!conversation) throw new Error("this conversation is gone");
        const range = resolveRange(options.range, count);
        const selected = selectTurns(turns, range);
        const summaryText = options.method === "summary" ? await summarize(ctx, conversation, summaryRequest(selected, { focus: options.focus })) : undefined;
        const splice = buildSplice({ source, turns: selected, range, turnCount: count, options, summaryText });
        const id = `agent-utils.splice:${splice.provenance.host}/${splice.provenance.session}:${splice.provenance.turns}:${splice.provenance.at}`;
        let queued = 0;
        for (const [index, message] of splice.messages.entries()) {
          const submission = await conversation.submit({ type: "write", requestId: `${id}:${index}`, entry: spliceEntry(message, splice.provenance) }, ctx.context);
          if (submission && typeof submission.status === "function") {
            const record = await submission.status(ctx.context).catch(() => undefined);
            if (record && record.status !== "done") queued += 1;
          }
        }
        const when = queued ? " They land when the current turn ends." : "";
        ctx.notify(`Spliced ${splice.label}: ${splice.messages.length} message(s), ${splice.chars} characters.${when}`);
      } catch (error) {
        ctx.notify(`/splice: ${error.message}`);
      }
    },
  };
}

export const commands = { splice: createSpliceCommand() };
