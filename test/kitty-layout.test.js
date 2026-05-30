import test from "node:test";
import assert from "node:assert/strict";

import {
  estimatedRowsForColumns,
  fitImageColumnsForRows,
  limitLinesToTerminalRows,
  currentTerminalColumns,
  currentTerminalRows,
  previewViewportRowLimit,
  previewImageRowLimit,
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

// Temporarily override the terminal dimension getters with restore, so the
// terminal-coupled helpers can be exercised deterministically.
function withTerminal({ columns, rows }, fn) {
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  const origEnv = { COLUMNS: process.env.COLUMNS, LINES: process.env.LINES };
  try {
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
    delete process.env.COLUMNS;
    delete process.env.LINES;
    return fn();
  } finally {
    if (origCols) Object.defineProperty(process.stdout, "columns", origCols);
    if (origRows) Object.defineProperty(process.stdout, "rows", origRows);
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test("currentTerminalColumns/Rows read stdout and guard non-positive values", () => {
  withTerminal({ columns: 120, rows: 48 }, () => {
    assert.equal(currentTerminalColumns(), 120);
    assert.equal(currentTerminalRows(), 48);
  });
  withTerminal({ columns: 0, rows: -3 }, () => {
    assert.equal(currentTerminalColumns(), undefined);
    assert.equal(currentTerminalRows(), undefined);
  });
});

test("previewViewportRowLimit delegates to the half-viewport limit", () => {
  assert.equal(previewViewportRowLimit(24), 12);
  assert.equal(previewViewportRowLimit(1), 1);
  // No arg uses currentTerminalRows() as the default.
  withTerminal({ columns: 80, rows: 48 }, () => {
    assert.equal(previewViewportRowLimit(), 24);
  });
  // When terminal rows are unknown, the default resolves to undefined.
  withTerminal({ columns: undefined, rows: undefined }, () => {
    assert.equal(previewViewportRowLimit(), undefined);
  });
});

test("previewImageRowLimit clamps to the minimum of protocol/viewport/available", () => {
  // viewport half of 24 is 12; protocolMax 200 -> min is the viewport.
  assert.equal(previewImageRowLimit({ viewportRows: 24, protocolMax: 200 }), 12);
  // includeControls reserves one row from the viewport limit.
  assert.equal(previewImageRowLimit({ viewportRows: 24, includeControls: true, protocolMax: 200 }), 11);
  // availableRows can be the binding minimum.
  assert.equal(previewImageRowLimit({ viewportRows: 24, availableRows: 5, protocolMax: 200 }), 5);
  // a small protocol cap wins.
  assert.equal(previewImageRowLimit({ viewportRows: 24, protocolMax: 3 }), 3);
  // result floors at 1.
  assert.equal(previewImageRowLimit({ viewportRows: 2, availableRows: 1, protocolMax: 200 }), 1);
});

test("previewImageRowLimit ignores the viewport when terminal rows are unknown", () => {
  withTerminal({ columns: undefined, rows: undefined }, () => {
    // viewport limit is undefined, so only protocolMax + availableRows apply.
    assert.equal(previewImageRowLimit({ protocolMax: 200, availableRows: 7 }), 7);
    assert.equal(previewImageRowLimit({ protocolMax: 50 }), 50);
  });
});
