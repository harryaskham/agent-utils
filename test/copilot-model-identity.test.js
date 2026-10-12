import test from "node:test";
import assert from "node:assert/strict";
import extension, { canonicalCopilotReply } from "../extensions/copilot-model-identity.js";
const selected = { provider: "github-copilot", id: "claude-opus-5.5" };
const reply = () => ({ role: "assistant", provider: "github-copilot", model: "claude-opus-5-5", api: "anthropic-messages", responseId: "fixture-response", content: [{ type: "thinking", thinking: "fixture", thinkingSignature: "unchanged-signature" }, { type: "text", text: "fixture" }], usage: { input: 1, output: 2 }, stopReason: "stop", timestamp: 1 });

test("new Copilot Opus reply keeps the selectable identity and every other field", () => {
  const source = reply(), result = canonicalCopilotReply(source, selected);
  assert.equal(result.model, selected.id); assert.equal(source.model, "claude-opus-5-5");
  assert.equal(result.content, source.content);assert.equal(result.usage, source.usage);
  assert.deepEqual({ ...result, model: source.model }, source);
  for (const [message, model] of [
    [{ ...source, provider: "anthropic" }, selected],
    [source, { provider: "anthropic", id: selected.id }],
    [source, { ...selected, id: "gpt-6-astra" }],
    [{ ...source, model: "claude-sonnet-4-6" }, selected],
    [{ ...source, model: selected.id }, selected],
    [{ role: "user", content: "fixture" }, selected],
    [source, undefined],
  ]) assert.equal(canonicalCopilotReply(message, model), undefined);
});

test("actual Pi message_end runner and session projection round-trip to the Copilot catalogue id", async () => {
  const { SessionManager, ExtensionRunner, createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
  const session = SessionManager.inMemory();session.appendModelChange(selected.provider, selected.id);
  session.appendMessage(reply());
  // Reproduce the upstream restore failure using metadata-only synthetic data.
  assert.deepEqual(session.buildSessionContext().model, { provider: selected.provider, modelId: "claude-opus-5-5" });
  const handlers = new Map();extension({ on: (name, handler) => handlers.set(name, [handler]) });
  const runner = new ExtensionRunner([{ path: "fixture", resolvedPath: "fixture", handlers }], createExtensionRuntime(), "/tmp", session, {});
  runner.bindCore({}, { getModel: () => selected });
  const output = await runner.emitMessageEnd({ type: "message_end", message: reply() });
  assert.equal(output.model, selected.id);
  session.appendMessage(output);
  assert.deepEqual(session.buildSessionContext().model, { provider: selected.provider, modelId: selected.id });
});
