// Direct unit tests for pi-graphics/runtime.js buildAnimatedPlacement
// (bd-1ef196): the animated sibling of buildPlacement, covering its
// transmit-once dedup/caching. Regression net; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import { makeState, buildAnimatedPlacement } from "../extensions/pi-graphics/runtime.js";
import { renderPromptEnclosure } from "../extensions/pi-graphics/affordances.js";

function animationFrames() {
  return [
    renderPromptEnclosure({ columns: 4, variant: "glow" }).png,
    renderPromptEnclosure({ columns: 4, variant: "scanlines" }).png,
  ];
}

test("buildAnimatedPlacement transmits the animation and tracks the image id on first build", () => {
  const state = makeState();
  state.config.passthrough = "none";
  const pngs = animationFrames();
  const placement = buildAnimatedPlacement(state, {
    name: "anim-rule",
    pngs,
    delaysMs: 80,
    columns: 4,
    rows: 1,
  });
  assert.ok(
    placement.imageId >= 0x01000000 && placement.imageId <= 0xffffffff,
    "image id should use the protocol's 32-bit namespace",
  );
  assert.equal(placement.transmitted, true);
  assert.equal(placement.frames, pngs.length);
  assert.ok(placement.transmit.length > 0);
  assert.match(placement.transmit, /\x1b_G/); // kitty graphics command
  assert.equal(placement.lines.length, 1);
  assert.ok(state.ownedImageIds.has(placement.imageId));
});

test("buildAnimatedPlacement dedups a repeat build of identical frames (transmit-once)", () => {
  const state = makeState();
  state.config.passthrough = "none";
  const pngs = animationFrames();
  const first = buildAnimatedPlacement(state, { name: "anim-dedup", pngs, delaysMs: 80, columns: 4, rows: 1 });
  const second = buildAnimatedPlacement(state, { name: "anim-dedup", pngs, delaysMs: 80, columns: 4, rows: 1 });
  assert.equal(first.transmitted, true);
  assert.equal(second.transmitted, false);
  assert.equal(second.transmit, ""); // no re-upload of identical animation bytes
  assert.equal(second.frames, pngs.length); // still reports frame count
  assert.equal(second.imageId, first.imageId); // same stable id
});
