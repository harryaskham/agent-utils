import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAnsiTruecolorRgb,
  rgbToHex,
  getThemeColorRgb,
  getThemeColorHex,
} from "../extensions/pi-graphics/theme-colors.js";

test("parseAnsiTruecolorRgb decodes 38;2;R;G;B", () => {
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;2;136;192;208m"), [136, 192, 208]);
});

test("parseAnsiTruecolorRgb decodes 256-color palette", () => {
  const rgb = parseAnsiTruecolorRgb("\x1b[38;5;15m");
  assert.ok(Array.isArray(rgb));
  assert.equal(rgb.length, 3);
});

test("rgbToHex pads and clamps", () => {
  assert.equal(rgbToHex([0, 0, 0]), "#000000");
  assert.equal(rgbToHex([255, 255, 255]), "#ffffff");
  assert.equal(rgbToHex([300, -5, 17]), "#ff0011");
});

test("getThemeColorRgb falls back when theme has no token", () => {
  const rgb = getThemeColorRgb(null, "accent", "#88c0d0");
  assert.deepEqual(rgb, [136, 192, 208]);
});

test("getThemeColorRgb extracts truecolor from a theme.getFgAnsi stub", () => {
  const theme = { getFgAnsi: () => "\x1b[38;2;180;142;173m" };
  assert.deepEqual(getThemeColorRgb(theme, "accent"), [180, 142, 173]);
});

test("parseAnsiTruecolorRgb decodes the 256-color grayscale ramp and color cube (bd-b0e0d1)", () => {
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;232m"), [8, 8, 8]); // first gray
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;244m"), [128, 128, 128]); // mid gray
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;16m"), [0, 0, 0]); // cube origin
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;196m"), [255, 0, 0]); // cube red
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;21m"), [0, 0, 255]); // cube blue
});

test("parseAnsiTruecolorRgb maps the low/bright 256-color base indices (bd-b0e0d1)", () => {
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;0m"), [0, 0, 0]); // base black (30)
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;1m"), [205, 0, 0]); // base red (31)
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[38;5;9m"), [255, 0, 0]); // bright red (91)
});

test("parseAnsiTruecolorRgb decodes the 16-color ANSI fallback path (bd-b0e0d1)", () => {
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[31m"), [205, 0, 0]); // ANSI red
  assert.deepEqual(parseAnsiTruecolorRgb("\x1b[97m"), [255, 255, 255]); // bright white
});

test("parseAnsiTruecolorRgb returns null for nullish, non-string, and non-matching input (bd-b0e0d1)", () => {
  assert.equal(parseAnsiTruecolorRgb(null), null);
  assert.equal(parseAnsiTruecolorRgb(undefined), null);
  assert.equal(parseAnsiTruecolorRgb(12345), null); // non-string
  assert.equal(parseAnsiTruecolorRgb("no ansi here"), null);
  assert.equal(parseAnsiTruecolorRgb("\x1b[38;5;999m") === null, false); // 256 still parses (clamped math)
});

test("getThemeColorRgb parses short-hex, invalid-length, and theme-throws fallbacks (bd-b0e0d1)", () => {
  // 3-char short hex expands each nibble.
  assert.deepEqual(getThemeColorRgb(null, "t", "#abc"), [170, 187, 204]);
  // Length that is neither 3 nor 6 -> hard default.
  assert.deepEqual(getThemeColorRgb(null, "t", "12"), [136, 192, 208]);
  assert.deepEqual(getThemeColorRgb(null, "t", ""), [136, 192, 208]);
  // A theme whose getFgAnsi throws falls through to the hex fallback.
  const throwingTheme = { getFgAnsi: () => { throw new Error("boom"); } };
  assert.deepEqual(getThemeColorRgb(throwingTheme, "t", "#000000"), [0, 0, 0]);
  // A theme emitting a 256-color sequence is decoded via parseAnsiTruecolorRgb.
  const paletteTheme = { getFgAnsi: () => "\x1b[38;5;196m" };
  assert.deepEqual(getThemeColorRgb(paletteTheme, "t"), [255, 0, 0]);
});

test("getThemeColorHex returns the resolved color as a hex string (bd-b0e0d1)", () => {
  assert.equal(getThemeColorHex(null, "t", "#88c0d0"), "#88c0d0"); // fallback path
  const theme = { getFgAnsi: () => "\x1b[38;2;255;0;0m" };
  assert.equal(getThemeColorHex(theme, "accent"), "#ff0000"); // truecolor stub
});
