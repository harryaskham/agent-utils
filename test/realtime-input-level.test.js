import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_INPUT_LEVEL_CONFIG,
  clampUnit,
  smoothLevel,
  InputLevelTracker,
} from "../extensions/lib/realtime-input-level.js";
import { SAMPLE_WIDTH } from "../extensions/lib/realtime-audio.js";

// Build a PCM16 (s16le) buffer of `n` samples all at amplitude `amp`.
function pcm(n, amp) {
  const buf = Buffer.alloc(n * SAMPLE_WIDTH);
  for (let i = 0; i < n; i++) buf.writeInt16LE(amp, i * SAMPLE_WIDTH);
  return buf;
}

test("clampUnit coerces to a finite 0..1", () => {
  assert.equal(clampUnit(-1), 0);
  assert.equal(clampUnit(2), 1);
  assert.equal(clampUnit(0.5), 0.5);
  assert.equal(clampUnit(NaN), 0);
  assert.equal(clampUnit(Infinity), 0);
  assert.equal(clampUnit("0.25"), 0.25);
});

test("smoothLevel uses fast attack when the level is rising", () => {
  // rising from 0 toward 1 with attack 0.5 -> 0.5
  assert.equal(smoothLevel(0, 1, { attack: 0.5, decay: 0.1 }), 0.5);
});

test("smoothLevel uses slow decay when the level is falling", () => {
  // falling from 1 toward 0 with decay 0.1 -> 0.9
  assert.ok(Math.abs(smoothLevel(1, 0, { attack: 0.5, decay: 0.1 }) - 0.9) < 1e-9);
});

test("smoothLevel clamps out-of-range inputs", () => {
  assert.equal(smoothLevel(-5, 5, { attack: 1, decay: 1 }), 1);
  assert.equal(smoothLevel(2, -2, { attack: 1, decay: 1 }), 0);
});

test("smoothLevel falls back to default coefficients", () => {
  // default attack 0.5: rising 0 -> 1 yields 0.5
  assert.equal(smoothLevel(0, 1), 0.5);
});

test("InputLevelTracker rises on a loud chunk and decays on silence", () => {
  const t = new InputLevelTracker({ attack: 0.5, decay: 0.2 });
  assert.equal(t.value(), 0);
  const loud = t.push(pcm(240, 30000)); // near full scale
  assert.ok(loud > 0, "rises above 0 on loud input");
  const afterSilence = t.push(pcm(240, 0)); // silence
  assert.ok(afterSilence < loud, "decays toward silence on a quiet chunk");
});

test("InputLevelTracker treats empty / odd chunk as silence", () => {
  const t = new InputLevelTracker();
  t.push(pcm(240, 30000));
  const before = t.value();
  const afterEmpty = t.push(Buffer.alloc(0));
  assert.ok(afterEmpty <= before, "empty chunk does not raise the level");
  const afterOdd = t.push(Buffer.from([0x01])); // 1 byte < SAMPLE_WIDTH
  assert.ok(afterOdd <= afterEmpty, "odd-length chunk counts as silence");
});

test("InputLevelTracker.reset returns to silence", () => {
  const t = new InputLevelTracker();
  t.push(pcm(240, 30000));
  assert.ok(t.value() > 0);
  assert.equal(t.reset(), 0);
  assert.equal(t.value(), 0);
});

test("InputLevelTracker.pushLevel folds a precomputed level without RMS", () => {
  const t = new InputLevelTracker({ attack: 0.5, decay: 0.1 });
  assert.equal(t.pushLevel(1), 0.5);
});

test("DEFAULT_INPUT_LEVEL_CONFIG has fast attack, slow decay", () => {
  assert.ok(DEFAULT_INPUT_LEVEL_CONFIG.attack > DEFAULT_INPUT_LEVEL_CONFIG.decay);
  assert.equal(clampUnit(DEFAULT_INPUT_LEVEL_CONFIG.attack), DEFAULT_INPUT_LEVEL_CONFIG.attack);
});
