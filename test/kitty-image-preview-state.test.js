// Direct unit tests for kitty-image-preview/state.js pure state helpers
// (bd-f70141): index wrapping, config validation/clamping, result shaping, and
// timer cleanup. Regression net; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceIndex,
  applyConfig,
  makeDetails,
  makeContent,
  stopAnimation,
  stopCycle,
  keepTimerFromHoldingProcess,
} from "../extensions/kitty-image-preview/state.js";

function makeState() {
  return {
    index: 0,
    items: [],
    visible: false,
    ownedImageIds: new Set(),
    currentCommand: "cached",
    animation: { running: false },
    cycle: { running: false },
    config: {
      columns: 10, rows: 5, maxRows: 20, minRows: 1, zIndex: 0,
      background: false, showCaption: true, clearPrevious: false,
      placement: "auto", transferMode: "auto", passthrough: "auto",
      placementMode: "auto", placementId: 1, chunkSize: 1024,
    },
  };
}

test("advanceIndex returns false when empty and wraps in both directions", () => {
  const empty = makeState();
  assert.equal(advanceIndex(empty, 1), false);

  const s = makeState();
  s.items = [{}, {}, {}];
  s.index = 0;
  assert.equal(advanceIndex(s, 1), true);
  assert.equal(s.index, 1);
  advanceIndex(s, -1); // -> 0
  advanceIndex(s, -1); // wraps -> 2
  assert.equal(s.index, 2);
});

test("applyConfig clamps numeric fields and invalidates the cached command", () => {
  const s = makeState();
  applyConfig(s, { columns: 99999, rows: -3, zIndex: 5, chunkSize: 100 });
  assert.equal(s.config.columns, 4096); // clamped to max
  assert.equal(s.config.rows, 1); // clamped to min
  assert.equal(s.config.zIndex, 5);
  assert.equal(s.config.chunkSize, 512); // below min (512) -> min
  assert.equal(s.currentCommand, undefined); // memoized command invalidated
});

test("applyConfig validates enums and boolean type-guards", () => {
  const s = makeState();
  applyConfig(s, {
    placement: "belowEditor", // valid -> applied
    transferMode: "memory", // valid -> applied
    passthrough: "tmux", // valid -> applied
    placementMode: "unicode", // valid -> applied
    background: true, // boolean -> applied
    showCaption: "yes", // non-boolean -> ignored
  });
  assert.equal(s.config.placement, "belowEditor");
  assert.equal(s.config.transferMode, "memory");
  assert.equal(s.config.passthrough, "tmux");
  assert.equal(s.config.placementMode, "unicode");
  assert.equal(s.config.background, true);
  assert.equal(s.config.showCaption, true); // unchanged (non-boolean ignored)

  const s2 = makeState();
  applyConfig(s2, { placement: "BOGUS", transferMode: "nope" });
  assert.equal(s2.config.placement, "auto"); // invalid enum ignored
  assert.equal(s2.config.transferMode, "auto");
});

test("applyConfig no-ops on null / non-object and preserves the cached command", () => {
  const s = makeState();
  applyConfig(s, null);
  assert.equal(s.currentCommand, "cached");
  applyConfig(s, "not an object");
  assert.equal(s.currentCommand, "cached");
});

test("makeContent renders a single text block of summary + extra lines", () => {
  const s = makeState();
  s.items = [{ label: "img", path: "/p" }];
  const content = makeContent(s, ["extra line", ""]);
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.match(content[0].text, /Showing 1\/1: img/);
  assert.match(content[0].text, /extra line/);
});

test("makeDetails attaches the serialized public state", () => {
  const s = makeState();
  s.items = [{ id: 7, path: "/p", label: "img" }];
  const details = makeDetails(s, { extra: 1 });
  assert.equal(details.extra, 1);
  assert.ok(details.kittyImagePreviewState);
  assert.equal(details.kittyImagePreviewState.version, 1);
  assert.equal(details.kittyImagePreviewState.items.length, 1);
});

test("stopAnimation and stopCycle clear the timer and running flag", () => {
  const s = makeState();
  s.animationTimer = setInterval(() => {}, 10_000);
  s.animation = { running: true };
  stopAnimation(s);
  assert.equal(s.animationTimer, undefined);
  assert.deepEqual(s.animation, { running: false });

  s.cycleTimer = setInterval(() => {}, 10_000);
  s.cycle = { running: true };
  stopCycle(s);
  assert.equal(s.cycleTimer, undefined);
  assert.deepEqual(s.cycle, { running: false });
});

test("keepTimerFromHoldingProcess unrefs a timer and tolerates a non-timer", () => {
  let unreffed = false;
  const fakeTimer = { unref: () => { unreffed = true; } };
  assert.equal(keepTimerFromHoldingProcess(fakeTimer), fakeTimer);
  assert.equal(unreffed, true);
  // No unref method -> returned unchanged, no throw.
  const plain = {};
  assert.equal(keepTimerFromHoldingProcess(plain), plain);
  assert.equal(keepTimerFromHoldingProcess(undefined), undefined);
});
