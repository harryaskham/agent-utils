import test from "node:test";
import assert from "node:assert/strict";

import {
  estimatedRowsForColumns,
  fitImageColumnsForRows,
  containImageBox,
  limitLinesToTerminalRows,
  currentTerminalColumns,
  currentTerminalRows,
  previewViewportRowLimit,
  previewImageRowLimit,
  buildSidePanelLayout,
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

test("containImageBox fills the full column width when height is not the binding constraint", () => {
  // Generous row budget: a width-bound image keeps the full column width and the
  // aspect-natural height, so kitty receives an aspect-correct (w, r) box.
  const box = containImageBox(SIZED, 40, 1000);
  assert.equal(box.imageWidth, 40, "fills the full column width");
  assert.equal(box.imageRows, estimatedRowsForColumns(SIZED, 40), "height tracks the aspect ratio at full width");
  assert.ok(box.imageRows <= 1000);
});

test("containImageBox narrows tall images to stay aspect-correct instead of squishing", () => {
  // No-dimension fallback is deterministic: estimatedRows = ceil(c/2). With a
  // 3-row budget the widest aspect-correct width is c<=6 (ceil(6/2)=3); the box
  // must NOT keep width 40 at 3 rows (that is the vertical-squish bug).
  const box = containImageBox(NO_DIMS, 40, 3);
  assert.equal(box.imageWidth, 6, "reduces width so the aspect-natural height fits the row budget");
  assert.equal(box.imageRows, 3, "uses the full row budget at the reduced width");
  // Invariant: the chosen box never needs more rows than the budget.
  assert.ok(estimatedRowsForColumns(NO_DIMS, box.imageWidth) <= 3);
});

test("containImageBox clamps to >=1 cell and tolerates degenerate caps", () => {
  const box = containImageBox(SIZED, 0, 0);
  assert.ok(box.imageWidth >= 1 && box.imageRows >= 1);
  const undef = containImageBox(NO_DIMS, undefined, undefined);
  assert.ok(undef.imageWidth >= 1 && undef.imageRows >= 1);
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
  // reservedRows takes precedence and can reserve several rows (unicode frame).
  assert.equal(previewImageRowLimit({ viewportRows: 24, reservedRows: 3, protocolMax: 200 }), 9);
  assert.equal(previewImageRowLimit({ viewportRows: 24, reservedRows: 0, includeControls: true, protocolMax: 200 }), 12);
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

// A no-dimension item makes buildSidePanelLayout deterministic: the image fit
// math falls back to ceil(columns / 2), independent of the kitty row estimator.
function panelState(config = {}) {
  return { config: { rows: undefined, ...config }, items: [{ id: 1, path: "/x.png" }], index: 0 };
}

test("buildSidePanelLayout disables the rail on too-narrow terminals", () => {
  assert.deepEqual(buildSidePanelLayout(panelState(), 1, 20), {
    mainWidth: 1,
    imageWidth: 0,
    imageRows: 0,
    padding: 0,
    totalWidth: 0,
  });
});

test("buildSidePanelLayout disables the rail when no rows are available", () => {
  assert.deepEqual(buildSidePanelLayout(panelState(), 100, 0), {
    mainWidth: 100,
    imageWidth: 0,
    imageRows: 0,
    padding: 0,
    totalWidth: 0,
  });
});

test("buildSidePanelLayout sizes the rail to half width with padding and main remainder", () => {
  // width 100 -> maxTotalWidth 50; rows 20; padding 2; maxImageWidth 48;
  // fit(48,20)=40 (ceil(40/2)=20); totalWidth=min(50,42)=42; main=58.
  const layout = buildSidePanelLayout(panelState(), 100, 20);
  assert.equal(layout.imageWidth, 40);
  assert.equal(layout.imageRows, 20);
  assert.equal(layout.padding, 2);
  assert.equal(layout.totalWidth, 42);
  assert.equal(layout.mainWidth, 58);
  // invariant: the panel and the main column tile the terminal width.
  assert.equal(layout.mainWidth + layout.totalWidth, 100);
});

test("buildSidePanelLayout clamps padding to maxTotalWidth-1 on narrow terminals", () => {
  // width 4 -> maxTotalWidth 2; padding clamps to 1 (not the default 2).
  const layout = buildSidePanelLayout(panelState(), 4, 10);
  assert.equal(layout.totalWidth, 2);
  assert.equal(layout.imageWidth, 1);
  assert.equal(layout.padding, 1);
  assert.equal(layout.mainWidth, 2);
});

test("buildSidePanelLayout honors config.rows when capping image height", () => {
  // rows 5 -> fit(48,5)=10 (ceil(10/2)=5); imageRows 5; totalWidth=min(50,12)=12.
  const layout = buildSidePanelLayout(panelState({ rows: 5 }), 100, 20);
  assert.equal(layout.imageRows, 5);
  assert.equal(layout.imageWidth, 10);
  assert.equal(layout.totalWidth, 12);
});
