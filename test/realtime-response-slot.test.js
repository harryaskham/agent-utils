// Response-slot + phase behavior of the realtime provider turn.
//
// The realtime server allows exactly ONE open response per conversation. A
// barge-in (speak over the assistant) commits new mic audio while the previous
// response is still closing, so the next response.create can be rejected with
// "Conversation already has an active response in progress". Treating that as a
// turn error used to:
//   * end the pending provider stream with an error banner,
//   * null session.current, so the STILL-STREAMING response's transcript deltas
//     were dropped (audio played, nothing printed), and
//   * leave the audio-turn latch set, so VAD looked dead afterwards.
//
// These tests pin the recovery: serialize behind the open response, retry the
// turn, keep the transcript, and never drop a committed utterance.

import test from "node:test";
import assert from "node:assert/strict";

import {
  __RealtimeSessionForTest,
  setRealtimeWebSocketConstructor,
} from "../extensions/realtime-agent.js";
import { makeInitialConfig } from "../extensions/lib/realtime-config.js";

class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
  }
  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  once(event, handler) { this.on(event, handler); }
  off() {}
  emit(event, ...args) { for (const h of this.handlers.get(event) || []) h(...args); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit("close"); }
}

setRealtimeWebSocketConstructor(FakeWebSocket);

const MODEL = { provider: "openai-realtime", id: "gpt-realtime-2", contextWindow: 256_000 };

function makeSession(overrides = {}) {
  const sentMessages = [];
  const pi = {
    sendMessage(message, options) { sentMessages.push({ message, options }); },
    sendUserMessage() {},
    on() {},
  };
  const config = { ...makeInitialConfig({ persisted: {}, persistedStt: {} }), ...overrides };
  const session = new __RealtimeSessionForTest(pi, config);
  const ws = new FakeWebSocket();
  session.ws = ws;
  session.connected = true;
  // No status widget/ctx in this harness.
  session.updateStatus = () => {};
  session.notify = () => {};
  const creates = () => ws.sent.filter((m) => m.type === "response.create");
  const cancels = () => ws.sent.filter((m) => m.type === "response.cancel");
  const deliver = (event) => session.handleEvent(event);
  return { session, config, ws, pi, sentMessages, creates, cancels, deliver };
}

function startTurn(session, { signal } = {}) {
  return session.streamSimple(MODEL, { systemPrompt: "", tools: [], messages: [] }, { signal });
}

async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setTimeout(r, 0));
}

test("a busy response slot retries the turn instead of failing it", async () => {
  const { session, ws, creates, cancels, deliver } = makeSession();
  const stream = startTurn(session);
  await settle();
  assert.equal(creates().length, 1, "turn issues one response.create");

  // Server rejects it: the previous response is still open.
  deliver({
    type: "error",
    error: { message: "Conversation already has an active response in progress: resp_old" },
  });
  await settle();

  assert.equal(cancels().length, 1, "the stale response is cancelled");
  assert.ok(session.current, "the pending turn survives the busy error");

  // The stale response closes; our create is re-issued and the turn streams.
  deliver({ type: "response.done", response: { id: "resp_old" } });
  await settle();
  assert.equal(creates().length, 2, "response.create is re-issued once the slot frees");

  deliver({ type: "response.created", response: { id: "resp_new" } });
  deliver({ type: "response.output_item.added", item: { id: "item-1", type: "message", phase: "final_answer" } });
  deliver({ type: "response.audio_transcript.delta", item_id: "item-1", delta: "hello there" });
  deliver({ type: "response.done", response: { id: "resp_new" } });

  const result = await stream.result();
  assert.equal(result.stopReason, "stop", "the retried turn completes normally");
  assert.equal(result.content.find((c) => c.type === "text")?.text, "hello there", "transcript is preserved");
  assert.equal(session.responseInFlight, false);
  assert.equal(ws.sent.filter((m) => m.type === "response.create").length, 2);
});

test("a repeatedly busy slot eventually fails the turn instead of retrying forever", async () => {
  const { session, deliver, creates } = makeSession();
  const stream = startTurn(session);
  await settle();

  for (let i = 0; i < 4; i += 1) {
    deliver({ type: "error", error: { message: "Conversation already has an active response in progress: resp_old" } });
    await settle();
    deliver({ type: "response.done", response: { id: "resp_old" } });
    await settle();
  }

  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage, /active response in progress/);
  // Bounded by PI_RT_RESPONSE_BUSY_MAX_RETRIES (default 2): 1 initial + 2 retries.
  assert.equal(creates().length, 3);
});

test("a new turn cancels and waits for the open response, retiring the superseded one", async () => {
  const { session, creates, cancels, deliver } = makeSession();
  const first = startTurn(session);
  await settle();
  deliver({ type: "response.created", response: { id: "resp_1" } });
  deliver({ type: "response.output_item.added", item: { id: "item-1", type: "message" } });
  deliver({ type: "response.audio_transcript.delta", item_id: "item-1", delta: "first answer" });
  assert.equal(session.responseInFlight, true);

  // Barge-in: Pi starts a new turn while resp_1 is still open.
  const second = startTurn(session);
  await settle();
  assert.equal(cancels().length, 1, "the open response is cancelled, not raced");
  assert.equal(creates().length, 1, "the second create waits for the slot");

  const firstResult = await first.result();
  assert.equal(firstResult.stopReason, "aborted", "the superseded turn is closed out, not left hanging");

  deliver({ type: "response.done", response: { id: "resp_1" } });
  await settle();
  assert.equal(creates().length, 2, "the new turn creates its response once the slot frees");

  // Trailing deltas from the retired response must not leak into the new turn.
  deliver({ type: "response.audio_transcript.delta", response_id: "resp_1", item_id: "item-1", delta: " leaked" });
  deliver({ type: "response.created", response: { id: "resp_2" } });
  deliver({ type: "response.output_item.added", item: { id: "item-2", type: "message" } });
  deliver({ type: "response.audio_transcript.delta", item_id: "item-2", delta: "second answer" });
  deliver({ type: "response.done", response: { id: "resp_2" } });

  const secondResult = await second.result();
  assert.equal(secondResult.content.find((c) => c.type === "text")?.text, "second answer");
});

test("a mic commit during an in-flight audio turn is queued, not dropped", async () => {
  const { session, sentMessages, deliver } = makeSession();
  session.micMode = "vad";

  session.triggerCommittedAudioTurn();
  assert.equal(sentMessages.length, 1, "first commit triggers a Pi turn");
  assert.equal(session.pendingAudioTurnPending, true);

  // Barge-in: the user speaks again before the first turn settles.
  session.triggerCommittedAudioTurn();
  assert.equal(sentMessages.length, 1, "no duplicate turn while one is pending");
  assert.equal(session.audioTurnQueued, true, "the utterance is remembered");

  // The in-flight turn settles; the queued utterance is replayed.
  const stream = startTurn(session);
  await settle();
  deliver({ type: "response.created", response: { id: "resp_1" } });
  deliver({ type: "response.done", response: { id: "resp_1" } });
  await settle();

  assert.equal(session.audioTurnQueued, false);
  assert.equal(sentMessages.length, 2, "the queued barge-in utterance triggers its own turn");
  await stream.result();
});

test("commentary preambles render as thinking, the final answer as text", async () => {
  const { session, deliver } = makeSession();
  const stream = startTurn(session);
  await settle();
  deliver({ type: "response.created", response: { id: "resp_1" } });
  deliver({ type: "response.output_item.added", item: { id: "item-1", type: "message", phase: "commentary" } });
  deliver({ type: "response.audio_transcript.delta", item_id: "item-1", delta: "let me think about that" });
  deliver({ type: "response.output_item.done", item: { id: "item-1", type: "message", phase: "commentary" } });
  deliver({ type: "response.output_item.added", item: { id: "item-2", type: "message", phase: "final_answer" } });
  deliver({ type: "response.audio_transcript.delta", item_id: "item-2", delta: "the answer is 42" });
  deliver({ type: "response.done", response: { id: "resp_1" } });

  const result = await stream.result();
  assert.deepEqual(
    result.content.map((c) => [c.type, c.type === "thinking" ? c.thinking : c.text]),
    [["thinking", "let me think about that"], ["text", "the answer is 42"]],
  );
});

test("commentary mode text inlines the preamble, hidden drops it (audio still plays)", async () => {
  for (const [mode, expected] of [
    ["text", [["text", "let me think. the answer is 42"]]],
    ["hidden", [["text", "the answer is 42"]]],
  ]) {
    const { session, deliver } = makeSession({ commentaryMode: mode });
    const stream = startTurn(session);
    await settle();
    deliver({ type: "response.created", response: { id: "resp_1" } });
    deliver({ type: "response.output_item.added", item: { id: "item-1", type: "message", phase: "commentary" } });
    deliver({ type: "response.audio_transcript.delta", item_id: "item-1", delta: "let me think. " });
    deliver({ type: "response.output_item.added", item: { id: "item-2", type: "message", phase: "final_answer" } });
    deliver({ type: "response.audio_transcript.delta", item_id: "item-2", delta: "the answer is 42" });
    deliver({ type: "response.done", response: { id: "resp_1" } });

    const result = await stream.result();
    assert.deepEqual(
      result.content.map((c) => [c.type, c.type === "thinking" ? c.thinking : c.text]),
      expected,
      `commentary=${mode}`,
    );
  }
});

test("untagged output items keep the pre-2.x single-text-block rendering", async () => {
  const { session, deliver } = makeSession();
  const stream = startTurn(session);
  await settle();
  deliver({ type: "response.created", response: { id: "resp_1" } });
  deliver({ type: "response.audio_transcript.delta", delta: "plain " });
  deliver({ type: "response.audio_transcript.delta", delta: "answer" });
  deliver({ type: "response.done", response: { id: "resp_1" } });

  const result = await stream.result();
  assert.deepEqual(result.content.map((c) => [c.type, c.text]), [["text", "plain answer"]]);
});

test("response.create carries reasoning.effort for 2.x and omits it for gpt-realtime", async () => {
  const { session, creates } = makeSession();
  startTurn(session);
  await settle();
  assert.deepEqual(creates()[0].response.reasoning, { effort: "low" }, "reasoning low is the 2.x default");

  const legacy = makeSession({ model: "gpt-realtime" });
  legacy.session.streamSimple(
    { provider: "openai-realtime", id: "gpt-realtime", contextWindow: 128_000 },
    { systemPrompt: "", tools: [], messages: [] },
    {},
  );
  await settle();
  assert.equal(legacy.creates()[0].response.reasoning, undefined, "gpt-realtime does not accept response.reasoning");
});

test("a cancel that raced response.done does not fail the pending turn", async () => {
  const { session, deliver } = makeSession();
  const stream = startTurn(session);
  await settle();
  deliver({ type: "error", error: { message: "Cancellation failed: no active response found" } });
  await settle();
  assert.ok(session.current, "the benign cancel race keeps the turn alive");

  deliver({ type: "response.created", response: { id: "resp_1" } });
  deliver({ type: "response.audio_transcript.delta", delta: "still here" });
  deliver({ type: "response.done", response: { id: "resp_1" } });
  const result = await stream.result();
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content.find((c) => c.type === "text")?.text, "still here");
});

test("a missing response.done cannot wedge later turns forever", async () => {
  const previous = process.env.PI_RT_RESPONSE_SLOT_TIMEOUT_MS;
  process.env.PI_RT_RESPONSE_SLOT_TIMEOUT_MS = "20";
  try {
    const { session, creates, deliver } = makeSession();
    startTurn(session);
    await settle();
    deliver({ type: "response.created", response: { id: "resp_stuck" } });
    assert.equal(session.responseInFlight, true);

    // The server never reports resp_stuck done. The next turn must still fire.
    startTurn(session);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(creates().length, 2, "the slot wait times out and releases the turn");
    assert.equal(session.responseInFlight, false);
  } finally {
    if (previous === undefined) delete process.env.PI_RT_RESPONSE_SLOT_TIMEOUT_MS;
    else process.env.PI_RT_RESPONSE_SLOT_TIMEOUT_MS = previous;
  }
});
