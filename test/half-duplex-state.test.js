import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateSpeechMs,
  markAssistantSpeaking,
  isAssistantSpeaking,
  __resetAssistantSpeaking,
} from "../extensions/lib/half-duplex-state.js";

test("estimateSpeechMs scales with length at the chars/sec rate (bd-ddc391)", () => {
  assert.equal(estimateSpeechMs(""), 0);
  assert.equal(estimateSpeechMs(null), 0);
  assert.equal(estimateSpeechMs("x".repeat(15)), 1000);
  assert.equal(estimateSpeechMs("x".repeat(30)), 2000);
  assert.equal(estimateSpeechMs("x".repeat(30), { charsPerSec: 30 }), 1000);
});

test("markAssistantSpeaking opens a window incl. tail; isAssistantSpeaking tracks it (bd-ddc391)", () => {
  __resetAssistantSpeaking();
  const now = 10_000;
  assert.equal(isAssistantSpeaking(now), false, "idle before any speaking");
  markAssistantSpeaking(1000, { tailMs: 350, now });
  assert.equal(isAssistantSpeaking(now), true);
  assert.equal(isAssistantSpeaking(now + 1349), true, "still speaking within duration + tail");
  assert.equal(isAssistantSpeaking(now + 1351), false, "window ends after duration + tail");
  __resetAssistantSpeaking();
  assert.equal(isAssistantSpeaking(now), false, "reset clears the window");
});

test("markAssistantSpeaking extends but never shortens the window (bd-ddc391)", () => {
  __resetAssistantSpeaking();
  const now = 0;
  markAssistantSpeaking(5000, { tailMs: 0, now });
  markAssistantSpeaking(100, { tailMs: 0, now }); // shorter -> ignored
  assert.equal(isAssistantSpeaking(4999), true, "longer window preserved against a shorter mark");
  markAssistantSpeaking(10_000, { tailMs: 0, now }); // longer -> extends
  assert.equal(isAssistantSpeaking(9999), true, "extended to the longer window");
  __resetAssistantSpeaking();
});

test("markAssistantSpeaking tolerates junk durations (bd-ddc391)", () => {
  __resetAssistantSpeaking();
  const now = 0;
  markAssistantSpeaking(NaN, { tailMs: 200, now });
  assert.equal(isAssistantSpeaking(199), true, "junk duration -> just the tail");
  assert.equal(isAssistantSpeaking(201), false);
  __resetAssistantSpeaking();
});
