import test from "node:test";
import assert from "node:assert/strict";

import { runPeerTurn, makeInjectAndRespond } from "../extensions/lib/realtime-rt-peer.js";

// A mock peer session: records sent events, lets the test feed incoming events.
function mockSession() {
  const sent = [];
  let handler = null;
  return {
    sent,
    send: (ev) => sent.push(ev),
    onEvent: (h) => { handler = h; return () => { handler = null; }; },
    feed: (ev) => { if (handler) handler(ev); },
    get subscribed() { return handler !== null; },
  };
}

test("runPeerTurn injects concatenated audio + commit + response.create, then resolves on response.done", async () => {
  const s = mockSession();
  const p = runPeerTurn({
    send: s.send,
    onEvent: s.onEvent,
    audioSegments: [Buffer.from([1, 2]), Buffer.from([3, 4])],
    encode: (b) => `b64:${b.length}`,
    chunkBytes: 100,
  });
  // it should have injected: one append (concatenated 4 bytes) + commit + response.create
  assert.deepEqual(s.sent, [
    { type: "input_audio_buffer.append", audio: "b64:4" },
    { type: "input_audio_buffer.commit" },
    { type: "response.create" },
  ]);
  // feed the model's output, then completion
  s.feed({ type: "response.audio.delta", delta: Buffer.from([9, 9]).toString("base64") });
  s.feed({ type: "response.audio_transcript.delta", delta: "hello" });
  s.feed({ type: "response.done" });
  const result = await p;
  assert.deepEqual(result.pcm, Buffer.from([9, 9]));
  assert.equal(result.text, "hello");
  assert.equal(s.subscribed, false, "unsubscribed after completion");
});

test("runPeerTurn with no audio still triggers a response (the agent responds to context)", async () => {
  const s = mockSession();
  const p = runPeerTurn({ send: s.send, onEvent: s.onEvent, audioSegments: [] });
  assert.deepEqual(s.sent, [{ type: "response.create" }]);
  s.feed({ type: "response.done" });
  const r = await p;
  assert.equal(r.pcm.length, 0);
  assert.equal(r.text, "");
});

test("runPeerTurn rejects on timeout if no completion arrives", async () => {
  const s = mockSession();
  await assert.rejects(
    runPeerTurn({ send: s.send, onEvent: s.onEvent, audioSegments: [Buffer.from([1])], encode: () => "x", timeoutMs: 20 }),
    /peer turn timed out/,
  );
});

test("runPeerTurn requires send + onEvent deps", async () => {
  await assert.rejects(runPeerTurn({ onEvent: () => () => {} }), /requires a send/);
  await assert.rejects(runPeerTurn({ send: () => {} }), /requires an onEvent/);
});

test("makeInjectAndRespond adapts indexed sessions and routes per index", async () => {
  const a = mockSession();
  const b = mockSession();
  const inject = makeInjectAndRespond([a, b], { encode: () => "x" });
  const pa = inject(1, [Buffer.from([7])]);
  // session b (index 1) got the events, session a did not
  assert.ok(b.sent.length > 0);
  assert.equal(a.sent.length, 0);
  b.feed({ type: "response.audio.delta", delta: Buffer.from([5]).toString("base64") });
  b.feed({ type: "response.done" });
  const r = await pa;
  assert.deepEqual(r.pcm, Buffer.from([5]));
});

test("makeInjectAndRespond rejects when a session is missing send/onEvent", async () => {
  const inject = makeInjectAndRespond([{}], {});
  await assert.rejects(inject(0, []), /missing send\/onEvent/);
  await assert.rejects(inject(5, []), /missing send\/onEvent/);
});
