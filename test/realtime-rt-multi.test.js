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

import { RtOutputCollector, AUDIO_DELTA_TYPES, RESPONSE_DONE_TYPES } from "../extensions/lib/realtime-rt-multi.js";

test("RtOutputCollector accumulates base64 audio deltas (GA + beta event names) into PCM", () => {
  const c = new RtOutputCollector();
  assert.equal(c.accept({ type: "response.audio.delta", delta: Buffer.from([1, 2]).toString("base64") }), true);
  assert.equal(c.accept({ type: "response.output_audio.delta", delta: Buffer.from([3, 4]).toString("base64") }), true);
  assert.deepEqual(c.pcm(), Buffer.from([1, 2, 3, 4]));
});

test("RtOutputCollector accumulates transcript deltas and trims", () => {
  const c = new RtOutputCollector();
  c.accept({ type: "response.audio_transcript.delta", delta: "Hello " });
  c.accept({ type: "response.output_audio_transcript.delta", delta: "world  " });
  assert.equal(c.text(), "Hello world");
});

test("RtOutputCollector marks done and ignores unrelated events", () => {
  const c = new RtOutputCollector();
  assert.equal(c.accept({ type: "response.created" }), false);
  assert.equal(c.done, false);
  assert.equal(c.accept({ type: "response.done" }), true);
  assert.equal(c.done, true);
});

test("RtOutputCollector pcm() is an empty buffer with no audio, and reset clears", () => {
  const c = new RtOutputCollector();
  assert.equal(c.pcm().length, 0);
  c.accept({ type: "response.audio.delta", delta: Buffer.from([9]).toString("base64") });
  c.accept({ type: "response.audio_transcript.delta", delta: "x" });
  c.reset();
  assert.equal(c.pcm().length, 0);
  assert.equal(c.text(), "");
  assert.equal(c.done, false);
});

test("RtOutputCollector uses an injectable decode and exposes the event-type sets", () => {
  const c = new RtOutputCollector({ decode: () => Buffer.from([7, 7, 7]) });
  c.accept({ type: "response.audio.delta", delta: "ignored-by-fake-decode" });
  assert.deepEqual(c.pcm(), Buffer.from([7, 7, 7]));
  assert.ok(AUDIO_DELTA_TYPES.has("response.output_audio.delta"));
  assert.ok(RESPONSE_DONE_TYPES.has("response.done"));
});

import { runRtMultiRound } from "../extensions/lib/realtime-rt-multi.js";
import { buildParticipantRoster, MODE_RT, ORDER_FIXED } from "../extensions/lib/realtime-participants.js";

function rtRoster() {
  return buildParticipantRoster({ mode: MODE_RT, n: 3, env: {} }).participants;
}

test("runRtMultiRound requires injectAndRespond", async () => {
  await assert.rejects(runRtMultiRound({ participants: rtRoster(), humanAudio: Buffer.from([1]) }), /requires an injectAndRespond/);
});

test("runRtMultiRound routes the human + every earlier speaker's audio to each participant", async () => {
  const roster = rtRoster();
  const heard = [];
  const out = { 0: Buffer.from("a0"), 1: Buffer.from("a1"), 2: Buffer.from("a2") };
  const res = await runRtMultiRound({
    participants: roster,
    humanAudio: Buffer.from("H"),
    order: ORDER_FIXED,
    injectAndRespond: (index, segments) => {
      heard.push({ index, segs: segments.map((s) => s.toString()) });
      return { pcm: out[index], text: `t${index}` };
    },
  });
  // turn 0 hears [human]; turn 1 hears [human, out0]; turn 2 hears [human, out0, out1]
  assert.deepEqual(heard[0], { index: 0, segs: ["H"] });
  assert.deepEqual(heard[1], { index: 1, segs: ["H", "a0"] });
  assert.deepEqual(heard[2], { index: 2, segs: ["H", "a0", "a1"] });
  assert.deepEqual(res.turns.map((t) => t.text), ["t0", "t1", "t2"]);
  assert.deepEqual(res.turns.map((t) => t.pcmBytes), [2, 2, 2]);
});

test("runRtMultiRound plays each output to the human in turn order", async () => {
  const roster = rtRoster();
  const playOrder = [];
  await runRtMultiRound({
    participants: roster,
    humanAudio: Buffer.from("H"),
    order: ORDER_FIXED,
    injectAndRespond: (index) => ({ pcm: Buffer.from(`out${index}`), text: `t${index}` }),
    play: (p, pcm) => { playOrder.push(pcm.toString()); },
  });
  assert.deepEqual(playOrder, ["out0", "out1", "out2"]);
});

test("runRtMultiRound tolerates a silent turn (empty output) and a missing human", async () => {
  const roster = rtRoster();
  const heard = [];
  await runRtMultiRound({
    participants: roster,
    humanAudio: null,
    order: ORDER_FIXED,
    injectAndRespond: (index, segments) => {
      heard.push(segments.map((s) => s.toString()));
      return index === 0 ? { pcm: Buffer.alloc(0), text: "" } : { pcm: Buffer.from(`o${index}`), text: `t${index}` };
    },
  });
  // no human; turn 0 silent -> turn 1 hears nothing prior, turn 2 hears only o1
  assert.deepEqual(heard[0], []);
  assert.deepEqual(heard[1], []);
  assert.deepEqual(heard[2], ["o1"]);
});

test("runRtMultiRound surfaces a play error", async () => {
  const roster = buildParticipantRoster({ mode: MODE_RT, n: 2, env: {} }).participants;
  await assert.rejects(
    runRtMultiRound({
      participants: roster,
      humanAudio: Buffer.from("H"),
      order: ORDER_FIXED,
      injectAndRespond: (index) => ({ pcm: Buffer.from(`o${index}`), text: "t" }),
      play: () => { throw new Error("play boom"); },
    }),
    /play boom/,
  );
});
