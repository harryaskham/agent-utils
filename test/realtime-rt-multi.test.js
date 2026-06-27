import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AUDIO_CHUNK_BYTES,
  chunkBuffer,
  buildAudioInjectionEvents,
  buildResponseCreateEvent,
  buildHearAndRespondEvents,
} from "../extensions/lib/realtime-rt-multi.js";

test("chunkBuffer splits a buffer into <= chunkBytes slices that reassemble", () => {
  const buf = Buffer.from(Array.from({ length: 10 }, (_, i) => i));
  const chunks = chunkBuffer(buf, 4);
  assert.deepEqual(chunks.map((c) => c.length), [4, 4, 2]);
  assert.deepEqual(Buffer.concat(chunks), buf);
});

test("chunkBuffer handles empty and non-buffer input and a default size", () => {
  assert.deepEqual(chunkBuffer(Buffer.alloc(0), 4), []);
  assert.deepEqual(chunkBuffer([], 4), []);
  const big = chunkBuffer(Buffer.alloc(DEFAULT_AUDIO_CHUNK_BYTES + 1));
  assert.equal(big.length, 2);
});

test("buildAudioInjectionEvents builds append events then a commit", () => {
  const encode = (b) => `b64:${b.length}`;
  const events = buildAudioInjectionEvents(Buffer.alloc(9), { chunkBytes: 4, encode });
  assert.deepEqual(events, [
    { type: "input_audio_buffer.append", audio: "b64:4" },
    { type: "input_audio_buffer.append", audio: "b64:4" },
    { type: "input_audio_buffer.append", audio: "b64:1" },
    { type: "input_audio_buffer.commit" },
  ]);
});

test("buildAudioInjectionEvents returns [] for empty audio and can skip the commit", () => {
  assert.deepEqual(buildAudioInjectionEvents(Buffer.alloc(0)), []);
  const noCommit = buildAudioInjectionEvents(Buffer.alloc(4), { chunkBytes: 4, commit: false, encode: () => "x" });
  assert.deepEqual(noCommit, [{ type: "input_audio_buffer.append", audio: "x" }]);
});

test("buildAudioInjectionEvents default-encodes chunks as base64", () => {
  const events = buildAudioInjectionEvents(Buffer.from("hi"), { chunkBytes: 10 });
  assert.equal(events[0].type, "input_audio_buffer.append");
  assert.equal(events[0].audio, Buffer.from("hi").toString("base64"));
});

test("buildResponseCreateEvent includes a response object when given", () => {
  assert.deepEqual(buildResponseCreateEvent(), { type: "response.create" });
  assert.deepEqual(buildResponseCreateEvent({ modalities: ["audio"] }), { type: "response.create", response: { modalities: ["audio"] } });
});

test("buildHearAndRespondEvents chains append+commit+response.create", () => {
  const events = buildHearAndRespondEvents(Buffer.alloc(4), { chunkBytes: 4, encode: () => "x", responseObj: { o: 1 } });
  assert.deepEqual(events, [
    { type: "input_audio_buffer.append", audio: "x" },
    { type: "input_audio_buffer.commit" },
    { type: "response.create", response: { o: 1 } },
  ]);
  // even with no audio, it still triggers a response (the agent responds to context)
  assert.deepEqual(buildHearAndRespondEvents(Buffer.alloc(0)), [{ type: "response.create" }]);
});
