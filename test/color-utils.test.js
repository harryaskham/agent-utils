// Direct unit tests for the pi-graphics color-utils.js pure helpers (bd-590f81).
// Regression net for the actual behavior; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import { mixRgbChannel, mixHexColor } from "../extensions/pi-graphics/color-utils.js";

test("mixRgbChannel: interpolates and rounds between endpoints", () => {
  assert.equal(mixRgbChannel(0, 10, 0), 0);
  assert.equal(mixRgbChannel(0, 10, 1), 10);
  assert.equal(mixRgbChannel(0, 10, 0.5), 5);
  assert.equal(mixRgbChannel(0, 255, 0.5), 128); // Math.round(127.5) rounds half up
  assert.equal(mixRgbChannel(100, 0, 0.5), 50); // descending channel
});

test("mixRgbChannel: clamps t into [0, 1]", () => {
  assert.equal(mixRgbChannel(0, 10, -1), 0);
  assert.equal(mixRgbChannel(0, 10, 2), 10);
});

test("mixHexColor: mixes valid 6-hex colors at the endpoints and midpoint", () => {
  assert.equal(mixHexColor("#000000", "#ffffff", 0), "#000000");
  assert.equal(mixHexColor("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(mixHexColor("#000000", "#ffffff", 0.5), "#808080");
});

test("mixHexColor: accepts hex without a leading # and emits lowercase", () => {
  assert.equal(mixHexColor("000000", "ffffff", 1), "#ffffff");
  assert.equal(mixHexColor("#ABCDEF", "#ABCDEF", 0), "#abcdef");
});

test("mixHexColor: invalid 'from' falls back to #88c0d0, invalid 'to' to #ffffff", () => {
  // Invalid from + t=0 returns the from-fallback unchanged.
  assert.equal(mixHexColor("nothex", "#000000", 0), "#88c0d0");
  // Invalid to + t=1 returns the to-fallback unchanged.
  assert.equal(mixHexColor("#000000", "bad", 1), "#ffffff");
  // Short hex is not 6 digits -> treated as invalid -> from-fallback.
  assert.equal(mixHexColor("#fff", "#fff", 0), "#88c0d0");
  // Nullish inputs use both fallbacks.
  assert.equal(mixHexColor(null, undefined, 0), "#88c0d0");
});
