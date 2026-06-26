// Render smoke tests for pi-graphics/affordances.js (bd-748c3b). These assert
// the chrome render functions produce valid PNGs / frame objects of the expected
// dimensions — catching crashes and dimension regressions without any visual
// judgment or a live terminal. Structure only; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  CELL_PX_W,
  CELL_PX_H,
  renderAccentBar,
  renderGlowPanel,
  renderGlowPanelFrames,
  renderGradientBorder,
  renderEditorCursorVline,
  renderEditorBox,
  renderEditorRailFrame,
  renderFooterDividerPng,
  renderEditorBoxFrame,
  renderEditorBoxApng,
  renderEditorRailApng,
  renderEditorBorderApng,
} from "../extensions/pi-graphics/affordances.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngOf(result) {
  return Buffer.isBuffer(result) ? result : result?.png;
}

function assertPng(result, label) {
  const png = pngOf(result);
  assert.ok(Buffer.isBuffer(png), `${label} should produce a PNG buffer`);
  assert.ok(png.length > 8 && png.subarray(0, 8).equals(PNG_SIG), `${label} should have a PNG signature`);
  // IHDR width/height are big-endian u32 at byte offsets 16 and 20.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test("renderAccentBar renders a valid single-row PNG sized to the column count", () => {
  const dims = assertPng(renderAccentBar({ columns: 8 }), "renderAccentBar");
  assert.equal(dims.width, 8 * CELL_PX_W);
  assert.equal(dims.height, CELL_PX_H);
});

test("renderGlowPanel renders a valid PNG sized columns x rows", () => {
  const dims = assertPng(renderGlowPanel({ columns: 6, rows: 3 }), "renderGlowPanel");
  assert.equal(dims.width, 6 * CELL_PX_W);
  assert.equal(dims.height, 3 * CELL_PX_H);
});

test("renderGradientBorder renders a valid single-row PNG", () => {
  const dims = assertPng(renderGradientBorder({ columns: 6 }), "renderGradientBorder");
  assert.equal(dims.width, 6 * CELL_PX_W);
  assert.equal(dims.height, CELL_PX_H);
});

test("renderEditorCursorVline renders a valid PNG for a single cell", () => {
  const dims = assertPng(renderEditorCursorVline({ columns: 1, rows: 1 }), "renderEditorCursorVline");
  assert.equal(dims.width, CELL_PX_W);
  assert.equal(dims.height, CELL_PX_H);
});

test("renderFooterDividerPng renders a valid single-row divider PNG", () => {
  const dims = assertPng(renderFooterDividerPng({ columns: 3 }), "renderFooterDividerPng");
  assert.equal(dims.width, 3 * CELL_PX_W);
  assert.equal(dims.height, CELL_PX_H);
});

test("renderEditorBox renders a valid PNG sized to the column count", () => {
  const dims = assertPng(renderEditorBox({ columns: 6, rows: 2 }), "renderEditorBox");
  assert.equal(dims.width, 6 * CELL_PX_W);
  assert.ok(dims.height > 0); // height includes layout padding; just assert positive
});

test("renderEditorRailFrame returns a frame object with consistent pixel buffer dimensions", () => {
  const frame = renderEditorRailFrame({ columns: 6, rows: 1 });
  assert.equal(frame.widthPx, 6 * CELL_PX_W);
  assert.equal(frame.heightPx, CELL_PX_H);
  assert.ok(Buffer.isBuffer(frame.pixels));
  assert.equal(frame.pixels.length, frame.widthPx * frame.heightPx * 4); // RGBA
});

test("renderGlowPanelFrames returns one frame per requested frame", () => {
  const frames = renderGlowPanelFrames({ columns: 4, rows: 1, frames: 3 });
  assert.ok(Array.isArray(frames));
  assert.equal(frames.length, 3);
  assert.ok(Buffer.isBuffer(pngOf(frames[0])));
});

for (const [name, fn] of [
  ["renderEditorBoxApng", renderEditorBoxApng],
  ["renderEditorRailApng", renderEditorRailApng],
  ["renderEditorBorderApng", renderEditorBorderApng],
]) {
  test(`${name} renders a valid APNG sized columns x rows with frame metadata (bd-e5edc5)`, () => {
    const r = fn({ columns: 8, rows: 3, frames: 4, delayMs: 100 });
    const dims = assertPng(r, name);
    assert.equal(dims.width, 8 * CELL_PX_W);
    assert.equal(dims.height, 3 * CELL_PX_H);
    assert.equal(r.frames, 4);
    assert.equal(r.animationMs, 100 * 4); // delayMs * frames
    // Frame count is clamped to <=256 for oversized requests.
    assert.equal(fn({ columns: 4, rows: 2, frames: 9999 }).frames, 256);
  });
}

test("renderEditorBoxFrame returns an RGBA pixel buffer matching its dimensions (bd-e5edc5)", () => {
  const f = renderEditorBoxFrame({ columns: 6, rows: 2 });
  assert.ok(f.widthPx > 0 && f.heightPx > 0);
  assert.equal(f.pixels.length, f.widthPx * f.heightPx * 4); // RGBA, 4 bytes/pixel
});
