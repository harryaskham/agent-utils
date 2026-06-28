import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_METER_GAIN,
  DEFAULT_METER_WIDTH,
  rmsToLevel,
  formatLevelBar,
  formatLevelLabel,
  AudioLevelMeter,
} from "../extensions/lib/realtime-audio-meter.js";

test("rmsToLevel applies gain and clamps to 0..1", () => {
  assert.equal(rmsToLevel(0), 0);
  assert.equal(rmsToLevel(0.05, { gain: 10 }), 0.5);
  assert.equal(rmsToLevel(1, { gain: 12 }), 1, "clamped to 1");
  assert.equal(rmsToLevel(-5), 0, "negative clamps to 0");
  assert.equal(rmsToLevel(0.04), 0.04 * DEFAULT_METER_GAIN);
});

test("formatLevelBar renders a fixed-width filled/empty bar", () => {
  assert.equal(formatLevelBar(0, { width: 4 }), "\u2591\u2591\u2591\u2591");
  assert.equal(formatLevelBar(1, { width: 4 }), "\u2588\u2588\u2588\u2588");
  assert.equal(formatLevelBar(0.5, { width: 4 }), "\u2588\u2588\u2591\u2591");
  assert.equal(formatLevelBar(2, { width: 4 }), "\u2588\u2588\u2588\u2588", "over 1 clamps");
  // custom glyphs
  assert.equal(formatLevelBar(0.5, { width: 4, filled: "#", empty: "-" }), "##--");
});

test("formatLevelBar can mark the threshold with a caret", () => {
  // width 10, threshold 0.5 -> caret at index 5
  const bar = formatLevelBar(1, { width: 10, threshold: 0.5 });
  assert.equal(bar.length, 10);
  assert.equal(bar[5], "\u2502");
});

test("formatLevelLabel renders [bar] NN%", () => {
  assert.equal(formatLevelLabel(0.5, { width: 4 }), "[\u2588\u2588\u2591\u2591] 50%");
  assert.equal(formatLevelLabel(0, { width: 2 }), "[\u2591\u2591]  0%");
  assert.equal(formatLevelLabel(1, { width: 2 }), "[\u2588\u2588] 100%");
});

test("AudioLevelMeter has fast attack and slow decay", () => {
  const m = new AudioLevelMeter({ gain: 10, decay: 0.5, width: 10 });
  // loud frame jumps straight up (attack)
  assert.equal(m.pushRms(0.1), 1, "0.1*10 = 1.0, attacks immediately");
  // silence decays by the decay factor, not instantly to 0
  assert.equal(m.pushRms(0), 0.5);
  assert.equal(m.pushRms(0), 0.25);
  // a louder-than-current value jumps up again
  assert.equal(m.pushRms(0.06), 0.6);
});

test("AudioLevelMeter.pushFrame computes RMS from a PCM16 frame and renders", () => {
  const m = new AudioLevelMeter({ gain: 1, width: 8 });
  // a frame of zeros -> rms 0 -> level 0
  assert.equal(m.pushFrame(Buffer.alloc(48)), 0);
  assert.equal(m.render(), "\u2591".repeat(8));
  // a loud frame -> non-zero level
  const loud = Buffer.alloc(48);
  for (let i = 0; i < 24; i++) loud.writeInt16LE(20000, i * 2);
  const lvl = m.pushFrame(loud);
  assert.ok(lvl > 0, "loud frame raises the level");
  assert.match(m.label(), /^\[.+\] \d+%$/);
});

test("AudioLevelMeter.reset clears level/peak and exposes defaults", () => {
  const m = new AudioLevelMeter();
  m.pushRms(0.1);
  assert.ok(m.level > 0);
  m.reset();
  assert.equal(m.level, 0);
  assert.equal(m.peak, 0);
  assert.equal(m.width, DEFAULT_METER_WIDTH);
});
