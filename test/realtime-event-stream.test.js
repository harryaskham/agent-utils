// Direct unit tests for the realtime AssistantMessageEventStream async queue
// (bd-d2821c). Regression net for the actual concurrency/ordering behavior; no
// source changes.

import test from "node:test";
import assert from "node:assert/strict";

import { AssistantMessageEventStream } from "../extensions/lib/realtime-event-stream.js";

async function collect(stream) {
  const seen = [];
  for await (const event of stream) seen.push(event);
  return seen;
}

test("yields events pushed before iteration in FIFO order, then ends", async () => {
  const s = new AssistantMessageEventStream();
  s.push({ type: "text", v: 1 });
  s.push({ type: "text", v: 2 });
  s.push({ type: "text", v: 3 });
  s.end();
  const seen = await collect(s);
  assert.deepEqual(seen.map((e) => e.v), [1, 2, 3]);
});

test("delivers an event to a consumer already awaiting next()", async () => {
  const s = new AssistantMessageEventStream();
  const it = s[Symbol.asyncIterator]();
  const pending = it.next(); // queue empty + not done -> registers a waiter
  s.push({ type: "text", v: "a" });
  const r = await pending;
  assert.equal(r.done, false);
  assert.deepEqual(r.value, { type: "text", v: "a" });
});

test("a done event finalizes result() and is itself yielded before iteration ends", async () => {
  const s = new AssistantMessageEventStream();
  const message = { role: "assistant", text: "hi" };
  s.push({ type: "done", message });
  assert.equal(await s.result(), message);
  const seen = await collect(s);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "done");
});

test("an error event resolves result() with the error", async () => {
  const s = new AssistantMessageEventStream();
  const err = new Error("boom");
  s.push({ type: "error", error: err });
  assert.equal(await s.result(), err);
});

test("push after the stream is done is ignored", async () => {
  const s = new AssistantMessageEventStream();
  s.push({ type: "done", message: { ok: true } });
  s.push({ type: "text", v: "late" }); // dropped
  const seen = await collect(s);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "done");
});

test("end(result) resolves result() and ends a waiting consumer with done", async () => {
  const s = new AssistantMessageEventStream();
  const it = s[Symbol.asyncIterator]();
  const pending = it.next(); // registers a waiter
  s.end("final-x");
  const r = await pending;
  assert.equal(r.done, true);
  assert.equal(r.value, undefined);
  assert.equal(await s.result(), "final-x");
});

test("interleaved queued + waiter delivery preserves order", async () => {
  const s = new AssistantMessageEventStream();
  s.push({ type: "text", v: 1 }); // queued
  const it = s[Symbol.asyncIterator]();
  const first = await it.next(); // drains the queued event
  assert.deepEqual(first.value, { type: "text", v: 1 });
  const pending = it.next(); // now waits
  s.push({ type: "text", v: 2 }); // delivered to the waiter
  const second = await pending;
  assert.deepEqual(second.value, { type: "text", v: 2 });
});
