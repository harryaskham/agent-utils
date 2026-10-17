// Offline real-Pi fixture. Loaded only by the isolated integration test.
import { appendFileSync } from "node:fs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import compactNext from "../../extensions/compact-next.js";

export default function fixture(pi) {
  compactNext(pi);
  const trace = data => appendFileSync(process.env.COMPACT_NEXT_TRACE, `${JSON.stringify(data)}\n`);
  const waiting = new Map();
  let turn = 0;
  const finalBoundary = process.env.COMPACT_NEXT_FINAL === "1";
  const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  pi.registerProvider("compact-next-fixture", {
    api: "compact-next-fixture", apiKey: "offline-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "fixture", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const summary = context.messages.some(m => JSON.stringify(m.content).includes("<conversation>"));
      trace({ event: summary ? "summary" : "model", roles: context.messages.map(m => m.role), messages: context.messages.filter(m => m.role !== "system") });
      const content = summary ? [{ type: "text", text: "## Goal\nComplete fixture work. Both tool results are retained.\n## Next Steps\nFinish the task." }]
        : ++turn === 1 && !finalBoundary ? [
          { type: "toolCall", id: "call-one", name: "fixture_work", arguments: { name: "one" } },
          { type: "toolCall", id: "call-two", name: "fixture_work", arguments: { name: "two" } },
        ] : [{ type: "text", text: "Fixture completed after compaction." }];
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: content[0].type === "toolCall" ? "toolUse" : "stop", usage, timestamp: Date.now() };
      const emit = () => {
        if (options.signal?.aborted) {
          trace({ event: "provider-aborted" });
          message.stopReason = "aborted";
          message.errorMessage = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end();
      };
      if (!summary && turn === 1 && finalBoundary) waiting.set("response", emit);
      else queueMicrotask(emit);
      return stream;
    },
  });
  pi.registerTool({
    name: "fixture_work", label: "Fixture work", description: "Offline gated test work",
    parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    async execute(_id, args, signal) {
      trace({ event: "tool-start", name: args.name });
      await new Promise(resolve => {
        waiting.set(args.name, resolve);
        signal?.addEventListener("abort", resolve, { once: true });
      });
      trace({ event: "tool-end", name: args.name, aborted: signal?.aborted ?? false });
      return { content: [{ type: "text", text: `Completed ${args.name}` }], details: {} };
    },
  });
  pi.registerCommand("cn-release", {
    handler: async (name) => { waiting.get(name)?.(); waiting.delete(name); },
  });
  pi.on("session_start", () => trace({ event: "ready" }));
  pi.on("agent_start", () => trace({ event: "agent_start" }));
  pi.on("agent_settled", event => trace({ ...event, event: "agent_settled" }));
}
