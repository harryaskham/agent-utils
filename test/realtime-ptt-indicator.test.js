import test from "node:test";
import assert from "node:assert/strict";

import {
  ansiFg,
  pttStateStyle,
  pttFlashStyle,
  renderPttIndicator,
  makePttIndicator,
  PTT_COLORS,
} from "../extensions/lib/realtime-ptt-indicator.js";

test("ansiFg wraps text in a 24-bit truecolor SGR (bd-081267)", () => {
  assert.equal(ansiFg([255, 165, 0], "hi"), "\x1b[38;2;255;165;0mhi\x1b[0m");
});

test("pttStateStyle maps controller states to steady colors (bd-081267)", () => {
  assert.equal(pttStateStyle("listening").key, "listening");
  assert.deepEqual(pttStateStyle("listening").color, PTT_COLORS.listening);
  assert.equal(pttStateStyle("transcribing").key, "transcribing");
  assert.equal(pttStateStyle("transcribing-final").key, "transcribing", "in-flight commit is still 'transcribing' steady");
  assert.equal(pttStateStyle("idle").key, "idle");
  assert.equal(pttStateStyle("held").key, "idle", "held is handled as a flash by the caller, not a steady state");
  assert.equal(pttStateStyle("whatever").key, "idle");
});

test("pttFlashStyle maps chunk/commit and nothing else (bd-081267)", () => {
  assert.deepEqual(pttFlashStyle("chunk").color, PTT_COLORS.chunk);
  assert.deepEqual(pttFlashStyle("commit").color, PTT_COLORS.commit);
  assert.equal(pttFlashStyle("held"), null);
  assert.equal(pttFlashStyle(undefined), null);
});

test("renderPttIndicator returns a colored bar + label, width clamped (bd-081267)", () => {
  const lines = renderPttIndicator(pttStateStyle("listening"), 10);
  assert.equal(lines.length, 2);
  assert.ok(lines[0].includes("▁".repeat(10)), "bar is `width` cells");
  assert.ok(lines[0].includes("38;2;255;165;0"), "bar carries the orange color");
  assert.ok(renderPttIndicator(pttStateStyle("idle"), 1)[0].includes("▁".repeat(4)), "min width 4");
  assert.ok(renderPttIndicator(pttStateStyle("idle"), 9999)[0].includes("▁".repeat(240)), "max width 240");
});

test("makePttIndicator: setState draws steady, flash reverts after flashMs (bd-081267)", () => {
  const renders = [];
  let queued = null;
  const setTimer = (fn, ms) => { queued = { fn, ms }; return 1; };
  const clearTimer = () => { queued = null; };
  const ind = makePttIndicator({ render: (l) => renders.push(l), width: 8, flashMs: 300, setTimer, clearTimer });

  ind.setState("listening");
  assert.ok(renders.at(-1)[0].includes("38;2;255;165;0"), "orange steady drawn");
  assert.equal(ind.state, "listening");

  ind.flash("commit");
  assert.ok(renders.at(-1)[0].includes("38;2;80;200;120"), "green commit flash drawn");
  assert.equal(ind.flashing, true);
  assert.equal(queued.ms, 300);

  // A steady state change while flashing defers the redraw until the flash ends.
  const nBefore = renders.length;
  ind.setState("transcribing");
  assert.equal(renders.length, nBefore, "steady redraw deferred while flashing");
  assert.equal(ind.state, "transcribing");

  // Flash timer fires -> revert to the (updated) steady state.
  queued.fn();
  assert.equal(ind.flashing, false);
  assert.ok(renders.at(-1)[0].includes("38;2;199;21;133"), "reverts to magenta steady");
});

test("makePttIndicator.stop cancels a pending flash without redrawing (bd-081267)", () => {
  const renders = [];
  let queued = null;
  const ind = makePttIndicator({
    render: (l) => renders.push(l),
    setTimer: (fn, ms) => { queued = { fn, ms }; return 1; },
    clearTimer: () => { queued = null; },
  });
  ind.flash("chunk");
  assert.equal(ind.flashing, true);
  const n = renders.length;
  ind.stop();
  assert.equal(ind.flashing, false);
  assert.equal(renders.length, n, "stop does not redraw");
});
