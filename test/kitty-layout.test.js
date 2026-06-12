import test from "node:test";
import assert from "node:assert/strict";

import {
  estimatedRowsForColumns,
  fitImageColumnsForRows,
  containImageBox,
  packImagesIntoPages,
  composePagedSidePanelLines,
  pageForIndex,
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

test("packImagesIntoPages packs multiple width-fit images per page and overflows to a new page", () => {
  // No-dimension items are deterministic: estimatedRows = ceil(c/2), so
  // containImageBox(NO_DIMS, 10, budget>=5) -> { imageWidth: 10, imageRows: 5 }.
  // headerRows 1 -> each block is 6 rows. availableRows 14 -> two blocks fit
  // (6 + 6 = 12 <= 14); the third overflows (12 + 6 = 18 > 14) to page two.
  const items = [
    { id: 1, path: "/a.png", label: "a" },
    { id: 2, path: "/b.png", label: "b" },
    { id: 3, path: "/c.png", label: "c" },
  ];
  const pages = packImagesIntoPages(items, { columnWidth: 10, availableRows: 14, headerRows: 1 });
  assert.equal(pages.length, 2, "third image overflows onto a second page");
  assert.equal(pages[0].entries.length, 2);
  assert.equal(pages[1].entries.length, 1);
  // First page entries are header(1) + image(5) blocks stacked with no gap.
  assert.deepEqual(pages[0].entries.map((e) => e.startRow), [0, 6]);
  assert.deepEqual(pages[0].entries.map((e) => e.blockRows), [6, 6]);
  assert.equal(pages[0].usedRows, 12);
  // Labels and global indices are preserved for header rendering + navigation.
  assert.deepEqual(pages[0].entries.map((e) => e.label), ["a", "b"]);
  assert.equal(pages[1].entries[0].index, 2);
  assert.equal(pages[1].entries[0].startRow, 0, "a fresh page starts at row 0");
  // Every image is width-fit to the column and bounded by the page height.
  for (const page of pages) {
    for (const entry of page.entries) {
      assert.equal(entry.imageWidth, 10);
      assert.ok(entry.headerRows + entry.imageRows <= 14);
    }
  }
});

test("packImagesIntoPages honors an inter-image row gap", () => {
  const items = [
    { id: 1, path: "/a.png", label: "a" },
    { id: 2, path: "/b.png", label: "b" },
    { id: 3, path: "/c.png", label: "c" },
  ];
  // Same blocks (6 rows each) but a 1-row gap between images: 6 + 1 + 6 = 13
  // still fits 14, so the second image starts at row 7 instead of 6.
  const pages = packImagesIntoPages(items, { columnWidth: 10, availableRows: 14, headerRows: 1, rowGap: 1 });
  assert.equal(pages.length, 2);
  assert.deepEqual(pages[0].entries.map((e) => e.startRow), [0, 7]);
  assert.equal(pages[0].usedRows, 13);
});

test("packImagesIntoPages bounds each image height by the page minus its header", () => {
  // availableRows 6, headerRows 1 -> imageRowBudget 5; one 6-row block per page.
  const items = [
    { id: 1, path: "/a.png", label: "a" },
    { id: 2, path: "/b.png", label: "b" },
  ];
  const pages = packImagesIntoPages(items, { columnWidth: 10, availableRows: 6, headerRows: 1 });
  assert.equal(pages.length, 2, "a full-height image takes a page each");
  for (const page of pages) {
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].imageRows, 5);
    assert.equal(page.entries[0].blockRows, 6);
  }
});

test("packImagesIntoPages never needs more than one page for a single tall image", () => {
  // A big header relative to the page still yields a single bounded block.
  const pages = packImagesIntoPages([{ id: 1, path: "/tall.png", label: "tall" }], {
    columnWidth: 10,
    availableRows: 4,
    headerRows: 2,
  });
  assert.equal(pages.length, 1);
  const entry = pages[0].entries[0];
  assert.ok(entry.blockRows <= 4, `block ${entry.blockRows} must fit the page`);
  assert.ok(entry.imageRows >= 1 && entry.imageWidth >= 1);
});

test("packImagesIntoPages returns no pages for an empty or non-array input", () => {
  assert.deepEqual(packImagesIntoPages([], { columnWidth: 10, availableRows: 10 }), []);
  assert.deepEqual(packImagesIntoPages(null, { columnWidth: 10, availableRows: 10 }), []);
  assert.deepEqual(packImagesIntoPages(undefined, {}), []);
});

test("pageForIndex locates the page containing a global item index", () => {
  const items = Array.from({ length: 5 }, (_v, i) => ({ id: i, path: `/${i}.png`, label: String(i) }));
  // 14 rows / 6-per-block -> 2 images per page: [0,1] [2,3] [4].
  const pages = packImagesIntoPages(items, { columnWidth: 10, availableRows: 14, headerRows: 1 });
  assert.equal(pages.length, 3);
  assert.equal(pageForIndex(pages, 0), 0);
  assert.equal(pageForIndex(pages, 1), 0);
  assert.equal(pageForIndex(pages, 2), 1);
  assert.equal(pageForIndex(pages, 3), 1);
  assert.equal(pageForIndex(pages, 4), 2);
  // Unknown / out-of-range indices fall back to the first page.
  assert.equal(pageForIndex(pages, 99), 0);
  assert.equal(pageForIndex([], 3), 0);
  assert.equal(pageForIndex(null, 1), 0);
});

// Deterministic header/image callbacks so the composition geometry can be
// asserted exactly without any kitty/terminal coupling.
const HEADER = (entry) => [`H${entry.index}`];
const IMAGE = (entry) => Array.from({ length: entry.imageRows }, (_v, i) => `I${entry.index}.${i}`);

test("composePagedSidePanelLines bottom-aligns header+image blocks within the row budget", () => {
  const items = [
    { id: 1, path: "/a.png", label: "a" },
    { id: 2, path: "/b.png", label: "b" },
  ];
  // Two 6-row blocks (header 1 + image 5) -> usedRows 12. Visible 14 rows ->
  // 2 rows of top padding, then H0 / I0.0..4 / H1 / I1.0..4.
  const page = packImagesIntoPages(items, { columnWidth: 10, availableRows: 14, headerRows: 1 })[0];
  const lines = composePagedSidePanelLines(page, {
    rows: 14,
    totalWidth: 4,
    renderHeaderLines: HEADER,
    renderImageLines: IMAGE,
  });
  assert.equal(lines.length, 14);
  assert.deepEqual(lines.slice(0, 2), ["    ", "    "], "top is blank-padded to bottom-align the block");
  assert.equal(lines[2], "H0");
  assert.deepEqual(lines.slice(3, 8), ["I0.0", "I0.1", "I0.2", "I0.3", "I0.4"]);
  assert.equal(lines[8], "H1");
  assert.deepEqual(lines.slice(9, 14), ["I1.0", "I1.1", "I1.2", "I1.3", "I1.4"]);
});

test("composePagedSidePanelLines can top-align instead of bottom-align", () => {
  const page = packImagesIntoPages([{ id: 1, path: "/a.png", label: "a" }], {
    columnWidth: 10,
    availableRows: 10,
    headerRows: 1,
  })[0];
  const lines = composePagedSidePanelLines(page, {
    rows: 10,
    totalWidth: 2,
    renderHeaderLines: HEADER,
    renderImageLines: IMAGE,
    bottomAlign: false,
  });
  // Block is header(1)+image(5)=6 rows at the top; the remaining 4 are blank.
  assert.equal(lines[0], "H0");
  assert.deepEqual(lines.slice(1, 6), ["I0.0", "I0.1", "I0.2", "I0.3", "I0.4"]);
  assert.deepEqual(lines.slice(6, 10), ["  ", "  ", "  ", "  "]);
});

test("composePagedSidePanelLines clips a page taller than the visible budget", () => {
  // Pack for 14 rows (two blocks) but only 5 rows are visible: only the first
  // entry's header + first 4 image rows survive; bottomAlign cannot pad because
  // the page already fills the budget (topPad 0).
  const items = [
    { id: 1, path: "/a.png", label: "a" },
    { id: 2, path: "/b.png", label: "b" },
  ];
  const page = packImagesIntoPages(items, { columnWidth: 10, availableRows: 14, headerRows: 1 })[0];
  const lines = composePagedSidePanelLines(page, {
    rows: 5,
    totalWidth: 4,
    renderHeaderLines: HEADER,
    renderImageLines: IMAGE,
  });
  assert.equal(lines.length, 5);
  assert.deepEqual(lines, ["H0", "I0.0", "I0.1", "I0.2", "I0.3"]);
});

test("composePagedSidePanelLines fills missing callback lines and empty pages with blanks", () => {
  // A callback that under-produces image lines leaves the slack blank rather
  // than collapsing the block.
  const page = packImagesIntoPages([{ id: 1, path: "/a.png", label: "a" }], {
    columnWidth: 10,
    availableRows: 7,
    headerRows: 1,
  })[0];
  const lines = composePagedSidePanelLines(page, {
    rows: 7,
    totalWidth: 3,
    renderHeaderLines: HEADER,
    renderImageLines: () => ["only-one"],
  });
  assert.equal(lines.length, 7);
  // header(1)+image(5)=6 block, bottom-aligned -> 1 blank row on top.
  assert.equal(lines[0], "   ");
  assert.equal(lines[1], "H0");
  assert.equal(lines[2], "only-one");
  assert.deepEqual(lines.slice(3, 7), ["   ", "   ", "   ", "   "], "missing image rows stay blank");
  // Degenerate inputs: empty page / zero rows.
  assert.deepEqual(
    composePagedSidePanelLines({ entries: [] }, { rows: 3, totalWidth: 2, renderHeaderLines: HEADER, renderImageLines: IMAGE }),
    ["  ", "  ", "  "],
  );
  assert.deepEqual(composePagedSidePanelLines(null, { rows: 0 }), []);
  assert.deepEqual(composePagedSidePanelLines(undefined, {}), []);
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
