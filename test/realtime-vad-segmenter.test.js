import test from "node:test";
import assert from "node:assert/strict";

import {
  VadSegmenter,
  DEFAULT_VAD_SEGMENTER_CONFIG,
  normalizedRms,
  frameDurationMs,
} from "../extensions/lib/realtime-vad-segmenter.js";

const SAMPLE_RATE = 24000;
const SAMPLE_WIDTH = 2;

// Build a PCM16-LE frame of `ms` duration that is either speech (constant high
// amplitude -> RMS well above the energy threshold) or silence (zeros).
function frame(ms, { speech } = {}) {
  const samples = Math.round((ms / 1000) * SAMPLE_RATE);
  const buf = Buffer.alloc(samples * SAMPLE_WIDTH);
  if (speech) {
    for (let i = 0; i < samples; i++) buf.writeInt16LE(8000, i * SAMPLE_WIDTH);
  }
  return buf;
}

// Push `totalMs` of audio in 100 ms frames, collecting any emitted events.
function pushMs(seg, totalMs, opts, sink) {
  const step = 100;
  for (let pushed = 0; pushed < totalMs; pushed += step) {
    for (const event of seg.push(frame(step, opts))) sink.push(event);
  }
}

test("helpers: normalizedRms and frameDurationMs are exact for the realtime format", () => {
  assert.equal(normalizedRms(frame(100, { speech: false })), 0, "zeros -> 0 rms");
  const rms = normalizedRms(frame(100, { speech: true }));
  assert.ok(rms > 0.2 && rms < 0.3, `constant 8000 amplitude rms ~0.244, got ${rms}`);
  // 100 ms mono s16le == 0.1 * 24000 * 2 == 4800 bytes, exactly 100 ms back.
  assert.equal(frameDurationMs(4800), 100);
});

test("speech then short silence inserts once, longer silence commits once", () => {
  const seg = new VadSegmenter();
  const events = [];

  // 500 ms of speech establishes a turn above minTurnSpeechMs.
  for (const e of seg.push(frame(500, { speech: true }))) events.push(e);
  assert.deepEqual(events, [], "speech alone emits nothing");

  // Trailing silence: insert fires at insertSilenceMs (1000), commit at
  // commitSilenceMs (3000). Push 3000 ms of silence and collect all events.
  pushMs(seg, 3000, { speech: false }, events);

  const types = events.map((e) => e.type);
  assert.deepEqual(types, ["insert", "commit"], "exactly one insert then one commit");

  const insert = events[0];
  assert.equal(insert.silenceMs, DEFAULT_VAD_SEGMENTER_CONFIG.insertSilenceMs);
  assert.ok(insert.turnSpeechMs >= 200, "insert carries the turn's speech ms");
  assert.ok(insert.audio.length > 0 && insert.delta.length > 0, "insert carries audio");

  const commit = events[1];
  assert.equal(commit.silenceMs, DEFAULT_VAD_SEGMENTER_CONFIG.commitSilenceMs);
  assert.ok(commit.audio.length > 0, "commit carries the whole-turn audio");
});

test("reset-on-speech: a sub-threshold pause does not trigger; only the full gap after the latest speech does", () => {
  const seg = new VadSegmenter();
  const events = [];

  // speech, a 500 ms pause (below the 1000 ms insert threshold), then speech.
  for (const e of seg.push(frame(300, { speech: true }))) events.push(e);
  pushMs(seg, 500, { speech: false }, events);
  assert.deepEqual(events, [], "a pause shorter than insertSilenceMs emits nothing");

  for (const e of seg.push(frame(300, { speech: true }))) events.push(e);
  assert.deepEqual(events, [], "resuming speech still emits nothing");

  // Now a full 1000 ms gap after the most recent speech -> exactly one insert,
  // proving the mid-utterance speech reset the trailing-silence accumulator.
  pushMs(seg, 1000, { speech: false }, events);
  assert.deepEqual(events.map((e) => e.type), ["insert"], "insert fires only after the full post-speech gap");
});

test("commit resets the turn so a second utterance segments independently", () => {
  const seg = new VadSegmenter();
  const first = [];
  for (const e of seg.push(frame(500, { speech: true }))) first.push(e);
  pushMs(seg, 3000, { speech: false }, first);
  assert.deepEqual(first.map((e) => e.type), ["insert", "commit"], "first cycle");

  const second = [];
  for (const e of seg.push(frame(500, { speech: true }))) second.push(e);
  pushMs(seg, 3000, { speech: false }, second);
  assert.deepEqual(second.map((e) => e.type), ["insert", "commit"], "second cycle is fresh after reset");
});

test("turns below minTurnSpeechMs (pure silence or a tiny blip) never insert or commit", () => {
  const silenceOnly = new VadSegmenter();
  const silenceEvents = [];
  pushMs(silenceOnly, 5000, { speech: false }, silenceEvents);
  assert.deepEqual(silenceEvents, [], "pure silence emits nothing");

  const blip = new VadSegmenter();
  const blipEvents = [];
  for (const e of blip.push(frame(100, { speech: true }))) blipEvents.push(e); // 100 ms < 200 ms min
  pushMs(blip, 3000, { speech: false }, blipEvents);
  assert.deepEqual(blipEvents, [], "a sub-minimum speech blip never commits");
});

test("flush() finalizes an in-progress turn as a single commit and resets", () => {
  const seg = new VadSegmenter();
  for (const e of seg.push(frame(500, { speech: true }))) assert.fail(`unexpected event ${e.type}`);

  const flushed = seg.flush();
  assert.deepEqual(flushed.map((e) => e.type), ["commit"], "flush finalizes the turn");
  assert.equal(seg.flush().length, 0, "flush after reset emits nothing");

  // flush with no speech at all emits nothing.
  assert.deepEqual(new VadSegmenter().flush(), []);
});
