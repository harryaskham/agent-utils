// Direct unit tests for the pi-graphics footer-layout.js segment fitter
// (bd-7e92fe). Focuses on the documented null contract and the no-overflow
// invariant; footer-layout is otherwise exercised indirectly via pi-graphics.

import test from "node:test";
import assert from "node:assert/strict";

import {
  fitFooterSegments,
  footerSegmentsWidth,
  FOOTER_DIVIDER_WIDTH,
} from "../extensions/pi-graphics/footer-layout.js";

const trunc = (value, width) => String(value).slice(0, width);
const seg = (key, value, min, max) => ({ key, value, min, max, truncate: trunc });

test("returns null when per-segment minimums plus dividers cannot fit (bd-7e92fe)", () => {
  // Two segments each min=5 with one divider => minimum renderable width is
  // 5 + 5 + FOOTER_DIVIDER_WIDTH(3) = 13.
  const raw = [seg("a", "xxxxxxxx", 5, 10), seg("b", "yyyyyyyy", 5, 10)];
  assert.equal(5 + 5 + FOOTER_DIVIDER_WIDTH, 13);
  assert.equal(fitFooterSegments(raw, 12), null); // one cell too narrow -> null
  assert.notEqual(fitFooterSegments(raw, 13), null); // exactly fits
});

test("a non-null result never renders wider than the requested width", () => {
  const raw = [seg("a", "xxxxxxxx", 5, 10), seg("b", "yyyyyyyy", 5, 10)];
  for (const width of [13, 14, 20, 30, 50]) {
    const out = fitFooterSegments(raw, width);
    if (out) {
      assert.ok(
        footerSegmentsWidth(out) <= width,
        `rendered ${footerSegmentsWidth(out)} > width ${width}`,
      );
    }
  }
});

test("returns null when width minus dividers is below the segment count", () => {
  const many = Array.from({ length: 5 }, (_, i) => seg(`s${i}`, "x", 1, 5));
  // dividers = 4 * 3 = 12; width 5 -> budget = -7 < 5 -> null.
  assert.equal(fitFooterSegments(many, 5), null);
});

test("fits within width and absorbs spare columns when there is room", () => {
  const raw = [seg("label", "ab", 1, 10), seg("model", "m", 1, 20)];
  const out = fitFooterSegments(raw, 30);
  assert.notEqual(out, null);
  assert.ok(footerSegmentsWidth(out) <= 30);
  // absorbSpare grants leftover columns to the model segment.
  const model = out.find((s) => s.key === "model");
  assert.ok(model.width >= 1);
});

test("footerSegmentsWidth counts dividers and is 0 for empty / non-array", () => {
  assert.equal(footerSegmentsWidth([]), 0);
  assert.equal(footerSegmentsWidth(null), 0);
  const out = fitFooterSegments([seg("a", "x", 1, 5), seg("b", "y", 1, 5)], 20);
  assert.equal(footerSegmentsWidth(out), out.reduce((n, s) => n + s.width, 0) + FOOTER_DIVIDER_WIDTH);
});
