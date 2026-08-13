import test from "node:test";
import assert from "node:assert/strict";

import {
  assistantReplyText,
  pickLastAssistantReply,
  thinkingSummaryText,
  boundThinkingForSpeech,
  synthesizeAzureSpeechDirect,
} from "../extensions/lib/realtime-tts-batch.js";

// The historical import path remains a compatibility surface while synthesis
// itself lives in extensions/lib/tts.js.
test("realtime TTS compatibility module re-exports native Azure synthesis", () => {
  assert.equal(typeof synthesizeAzureSpeechDirect, "function");
});

test("assistantReplyText extracts text from string + array content", () => {
  assert.equal(assistantReplyText({ role: "assistant", content: "  hi there " }), "hi there");
  assert.equal(
    assistantReplyText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", text: "secret" }, { type: "text", text: "b" }] }),
    "ab",
  );
  assert.equal(assistantReplyText({ role: "user", content: "nope" }), "");
  assert.equal(assistantReplyText({ role: "assistant", content: [{ type: "tool_call" }] }), "");
});

test("pickLastAssistantReply returns the most recent reply and dedupe key", () => {
  const messages = [
    { role: "assistant", content: "old", timestamp: 1 },
    { role: "user", content: "q" },
    { role: "assistant", content: [{ type: "text", text: "new reply" }], timestamp: 2 },
  ];
  assert.deepEqual(pickLastAssistantReply(messages), { text: "new reply", key: "2:new reply" });
  assert.deepEqual(pickLastAssistantReply([{ role: "user", content: "x" }]), { text: "", key: "" });
});

test("thinkingSummaryText handles Pi thinking shapes", () => {
  assert.equal(
    thinkingSummaryText({ role: "assistant", content: [{ type: "thinking", thinking: "reasoning trace" }, { type: "text", text: "answer" }] }),
    "reasoning trace",
  );
  assert.equal(thinkingSummaryText({ role: "assistant", reasoning: "top-level" }), "top-level");
  assert.equal(thinkingSummaryText({ role: "user", content: "x" }), "");
});

test("boundThinkingForSpeech keeps short text and bounds long text", () => {
  assert.equal(boundThinkingForSpeech("  first thought.  second.  "), "first thought. second.");
  const gist = boundThinkingForSpeech("First sentence. " + "word ".repeat(100), 60);
  assert.ok(gist.length <= 61);
  assert.ok(gist.endsWith("…"));
});
