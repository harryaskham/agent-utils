import test from "node:test";
import assert from "node:assert/strict";

import {
  estimatedRowsForColumns,
  fitImageColumnsForRows,
  limitLinesToTerminalRows,
} from "../extensions/kitty-image-preview/layout.js";

// An item with no width/height exercises the pure fallback path
// (ceil(columns * 0.5)), which is deterministic and independent of the
// kitty-graphics row estimator.
const NO_DIMS = { id: 1, path: "/x.png" };
const SIZED = { id: 2, path: "/y.png", width: 1000, height: 1000 };

test("estimatedRowsForColumns falls back to ceil(columns/2) without dimensions", () => {
  assert.equal(estimatedRowsForColumns(NO_DIMS, 1), 1);
  assert.equal(estimatedRowsForColumns(NO_DIMS, 4), 2);
  assert.equal(estimatedRowsForColumns(NO_DIMS, 9), 5);
  // column count is clamped to >= 1.
  assert.equal(estimatedRowsForColumns(NO_DIMS, 0), 1);
  assert.equal(estimatedRowsForColumns(NO_DIMS, undefined), 1);
});

test("estimatedRowsForColumns returns a positive integer for a sized image", () => {
  const rows = estimatedRowsForColumns(SIZED, 40);
  assert.ok(Number.isInteger(rows) && rows >= 1, `expected >=1 integer, got ${rows}`);
  // Wider rendering should not require fewer rows than a narrower one
  // (the monotonicity the binary search in fitImageColumnsForRows relies on).
  assert.ok(estimatedRowsForColumns(SIZED, 80) >= estimatedRowsForColumns(SIZED, 10));
});

test("fitImageColumnsForRows binary-searches the largest fitting column count", () => {
  // Deterministic via the no-dimension fallback: ceil(c/2) <= rowLimit.
  // rowLimit 2 -> c<=4 (ceil(4/2)=2, ceil(5/2)=3); rowLimit 1 -> c<=2.
  assert.equal(fitImageColumnsForRows(NO_DIMS, 10, 2), 4);
  assert.equal(fitImageColumnsForRows(NO_DIMS, 10, 1), 2);
  // Generous row budget returns the full column limit.
  assert.equal(fitImageColumnsForRows(NO_DIMS, 10, 100), 10);
  // Always at least 1 column.
  assert.equal(fitImageColumnsForRows(NO_DIMS, 1, 1), 1);
});

test("fitImageColumnsForRows result is on the fit boundary", () => {
  const maxColumns = 64;
  const maxRows = 12;
  const best = fitImageColumnsForRows(SIZED, maxColumns, maxRows);
  assert.ok(best >= 1 && best <= maxColumns);
  // best fits within the row budget...
  assert.ok(estimatedRowsForColumns(SIZED, best) <= maxRows);
  // ...and one more column either exceeds the budget or hits the column cap.
  if (best < maxColumns) {
    assert.ok(estimatedRowsForColumns(SIZED, best + 1) > maxRows);
  }
});

test("limitLinesToTerminalRows keeps the tail when over the row budget", () => {
  const lines = ["a", "b", "c", "d", "e"];
  assert.deepEqual(limitLinesToTerminalRows(lines, 10), lines, "under budget is unchanged");
  assert.deepEqual(limitLinesToTerminalRows(lines, 2), ["d", "e"], "keeps the last N");
  assert.deepEqual(limitLinesToTerminalRows(lines, 5), lines, "exact budget unchanged");
});

test("limitLinesToTerminalRows guards non-arrays and clamps the row limit", () => {
  assert.deepEqual(limitLinesToTerminalRows(null, 3), []);
  assert.deepEqual(limitLinesToTerminalRows("nope", 3), []);
  // row limit clamps to >= 1, so the single last line survives.
  assert.deepEqual(limitLinesToTerminalRows(["a", "b", "c"], 0), ["c"]);
  assert.deepEqual(limitLinesToTerminalRows(["a", "b", "c"], NaN), ["c"]);
});
