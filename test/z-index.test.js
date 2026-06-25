// Direct unit tests for the pi-graphics z-index.js reserved-band constants
// (bd-590f81). Pins the documented invariant so accidental edits to the kitty
// graphics cleanup band fail fast. Regression net; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  PI_GRAPHICS_Z,
  PI_GRAPHICS_RESERVED_Z_INDICES,
  PI_GRAPHICS_RESERVED_Z_INDEX_MIN,
  PI_GRAPHICS_RESERVED_Z_INDEX_MAX,
} from "../extensions/pi-graphics/z-index.js";

test("PI_GRAPHICS_Z: named constants are the documented reserved values", () => {
  assert.equal(PI_GRAPHICS_Z.BOX_CHROME, -1073741823);
  assert.equal(PI_GRAPHICS_Z.ANCHOR, -1073741824);
  assert.equal(PI_GRAPHICS_Z.SURFACE, -1073741825);
  assert.equal(PI_GRAPHICS_Z.BACKGROUND, -1073741826);
  assert.equal(PI_GRAPHICS_Z.DEEP_BACKGROUND, -1073741827);
});

test("PI_GRAPHICS_RESERVED_Z_INDICES: lists every named constant, all distinct", () => {
  assert.deepEqual(PI_GRAPHICS_RESERVED_Z_INDICES, [
    PI_GRAPHICS_Z.BOX_CHROME,
    PI_GRAPHICS_Z.ANCHOR,
    PI_GRAPHICS_Z.SURFACE,
    PI_GRAPHICS_Z.BACKGROUND,
    PI_GRAPHICS_Z.DEEP_BACKGROUND,
  ]);
  assert.equal(new Set(PI_GRAPHICS_RESERVED_Z_INDICES).size, 5);
});

test("reserved band MIN/MAX bound the set and form a contiguous 5-value range", () => {
  assert.equal(PI_GRAPHICS_RESERVED_Z_INDEX_MIN, PI_GRAPHICS_Z.DEEP_BACKGROUND);
  assert.equal(PI_GRAPHICS_RESERVED_Z_INDEX_MAX, PI_GRAPHICS_Z.BOX_CHROME);
  assert.equal(PI_GRAPHICS_RESERVED_Z_INDEX_MIN, Math.min(...PI_GRAPHICS_RESERVED_Z_INDICES));
  assert.equal(PI_GRAPHICS_RESERVED_Z_INDEX_MAX, Math.max(...PI_GRAPHICS_RESERVED_Z_INDICES));
  // Five consecutive integers occupy a span of exactly 4.
  assert.equal(PI_GRAPHICS_RESERVED_Z_INDEX_MAX - PI_GRAPHICS_RESERVED_Z_INDEX_MIN, 4);
});

test("PI_GRAPHICS_Z and the reserved list are frozen", () => {
  assert.ok(Object.isFrozen(PI_GRAPHICS_Z));
  assert.ok(Object.isFrozen(PI_GRAPHICS_RESERVED_Z_INDICES));
});
