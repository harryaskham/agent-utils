import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  SPEECH_INDICATOR_EVENT,
  createSpeechIndicatorPublisher,
  normalizeSpeechIndicator,
  rmsToDb,
  subscribeSpeechIndicator,
} from "../extensions/lib/speech-indicator.js";

const bus = () => ({ events: new EventEmitter() });
const clock = () => {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    advance(ms) {
      now += ms;
      for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn();
    },
    setTimer(fn) { const timer = { fn, cleared: false }; timers.push(timer); return timer; },
    clearTimer(timer) { if (timer) timer.cleared = true; },
  };
};

test("indicator state is bounded single-line data and disabled carries no meter", () => {
  assert.deepEqual(normalizeSpeechIndicator({ phase: "bogus", meter: true, level: 1 }).meter, false);
  const state = normalizeSpeechIndicator({ phase: "on-air", surface: "PTT", hint: "a\nb".repeat(20), meter: true, level: 4, db: -300, threshold: 0.2 });
  assert.equal(state.level, 1);
  assert.equal(state.db, -90);
  assert.equal(state.hint.includes("\n"), false);
  assert.ok(state.hint.length <= 24);
  assert.equal(normalizeSpeechIndicator({ phase: "listening", surface: "evil" }).surface, "");
  assert.equal(Math.round(rmsToDb(0.1)), -20);
  assert.equal(rmsToDb(0), -90);
});

test("publisher announces once, emits phases immediately and coalesces meter-only updates", () => {
  const pi = bus();
  const time = clock();
  const seen = [];
  const fallbacks = [];
  pi.events.on(SPEECH_INDICATOR_EVENT, (state) => seen.push(state));
  const publisher = createSpeechIndicatorPublisher(pi, { ...time, intervalMs: 100, fallback: (state, consumed) => fallbacks.push([state.phase, consumed]) });
  publisher.publish({ phase: "disabled" });
  assert.equal(seen.length, 1, "initial disabled state is announced");
  publisher.publish({ phase: "disabled" });
  assert.equal(seen.length, 1, "unchanged state is silent");
  publisher.publish({ phase: "on-air", surface: "PTT", meter: true, level: 0.1, db: -40 });
  assert.equal(seen.length, 2, "phase change is immediate");
  publisher.publish({ phase: "on-air", surface: "PTT", meter: true, level: 0.2, db: -30 });
  publisher.publish({ phase: "on-air", surface: "PTT", meter: true, level: 0.3, db: -20 });
  assert.equal(seen.length, 2, "meter-only changes wait for the interval");
  time.advance(100);
  assert.equal(seen.length, 3);
  assert.equal(seen.at(-1).level, 0.3, "trailing write carries the latest level");
  assert.deepEqual(fallbacks.at(-1), ["on-air", false], "no consumer: fallback draws");
});

test("consumers accept, late consumers request the current state, and dispose hides it", () => {
  const pi = bus();
  const fallbacks = [];
  const publisher = createSpeechIndicatorPublisher(pi, { fallback: (state, consumed) => fallbacks.push([state.phase, consumed]) });
  publisher.publish({ phase: "armed", surface: "PTT", hint: "⌃␣ talk" });
  const received = [];
  const unsubscribe = subscribeSpeechIndicator(pi, (state) => received.push(state));
  assert.deepEqual(received.map((state) => state.phase), ["armed"], "subscription replays current state");
  assert.equal(received[0].accept, undefined, "consumers receive plain data");
  assert.deepEqual(fallbacks.at(-1), ["armed", true], "accepted state suppresses fallback");
  publisher.dispose();
  assert.equal(received.at(-1).phase, "disabled");
  publisher.publish({ phase: "on-air" });
  assert.equal(received.at(-1).phase, "disabled", "disposed publisher is inert");
  unsubscribe();
});

test("a consumer that declines leaves the fallback in charge", () => {
  const pi = bus();
  const fallbacks = [];
  subscribeSpeechIndicator(pi, () => {}, { accept: () => false });
  const publisher = createSpeechIndicatorPublisher(pi, { fallback: (state, consumed) => fallbacks.push(consumed) });
  publisher.publish({ phase: "listening", surface: "STT" });
  assert.deepEqual(fallbacks, [false]);
});
