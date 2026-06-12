// Image-fit / row-limit layout math extracted from kitty-image-preview.js
// (bd-e1914a). Pure functions over their arguments plus the kitty-graphics
// row-estimation primitive and placeholder diacritic cap. Behavior is unchanged
// from the original inline definitions.

import { MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE, estimateRowsForImage, viewportHalfRowLimit } from "../kitty-graphics.js";

import {
  DEFAULT_MAX_ROWS,
  SIDE_PANEL_LEFT_PADDING,
  SIDE_PANEL_MAX_WIDTH_RATIO,
} from "./constants.js";
import { clampInteger } from "./text-utils.js";

export function estimatedRowsForColumns(item, columns) {
  const columnCount = Math.max(1, Math.trunc(columns || 1));
  if (!item?.width || !item?.height) return Math.max(1, Math.ceil(columnCount * 0.5));
  return estimateRowsForImage({
    imageWidth: item.width,
    imageHeight: item.height,
    columns: columnCount,
    maxRows: MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1,
    minRows: 1,
  });
}

export function fitImageColumnsForRows(item, maxColumns, maxRows) {
  const columnLimit = Math.max(1, Math.trunc(maxColumns || 1));
  const rowLimit = Math.max(1, Math.trunc(maxRows || 1));
  let low = 1;
  let high = columnLimit;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimatedRowsForColumns(item, mid) <= rowLimit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

// Aspect-preserving "contain" fit for one image inside a (maxWidth x maxRows)
// cell box (bd image-preview sidebar work). Returns the largest box, in terminal
// cells, that (a) never exceeds maxWidth columns, (b) never exceeds maxRows rows,
// and (c) keeps the image's natural aspect ratio so kitty is never asked to
// scale into a mismatched cell rectangle (the side-panel vertical-squish bug).
//
// When the image's aspect-natural height at maxWidth fits within maxRows the box
// fills the full column width (imageWidth === maxWidth); only height-bound
// (portrait/tall) images reduce width to stay aspect-correct. Pure over its
// arguments plus the shared row estimator.
export function containImageBox(item, maxWidth, maxRows) {
  const widthCap = Math.max(1, Math.trunc(maxWidth || 1));
  const rowCap = Math.max(1, Math.trunc(maxRows || 1));
  const imageWidth = fitImageColumnsForRows(item, widthCap, rowCap);
  const imageRows = Math.max(1, Math.min(rowCap, estimatedRowsForColumns(item, imageWidth)));
  return { imageWidth, imageRows };
}

// Greedy multi-image page packing for the side panel (Part C of the
// image-preview sidebar work, bd-502d6a). Packs as many aspect-fit images as
// fit into each page of `availableRows`, reserving `headerRows` per image for a
// name header, and starts a fresh page when the next image's header+image block
// would overflow the page. Each image's height is additionally bounded by the
// page height minus its own header, so a single tall image never needs more than
// one page. Pure over its arguments plus containImageBox; reflow on resize is
// automatic because callers recompute pages from the live terminal width/rows on
// every render.
//
// Returns an array of pages; each page is { entries, usedRows } where every
// entry is { index, item, label, headerRows, imageWidth, imageRows, startRow,
// blockRows }. `startRow` is the 0-based row within the page where the entry's
// header begins; `blockRows` is headerRows + imageRows.
export function packImagesIntoPages(items, {
  columnWidth,
  availableRows,
  headerRows = 1,
  rowGap = 0,
  minImageRows = 1,
} = {}) {
  const width = Math.max(1, Math.trunc(columnWidth || 1));
  const rowCap = Math.max(1, Math.trunc(availableRows || 1));
  const header = Math.max(0, Math.trunc(headerRows));
  const gap = Math.max(0, Math.trunc(rowGap));
  const minRows = Math.max(1, Math.trunc(minImageRows));
  const list = Array.isArray(items) ? items : [];
  // Each image is height-bounded by the page minus its own header so a single
  // tall image can never demand more than one page.
  const imageRowBudget = Math.max(minRows, rowCap - header);
  const pages = [];
  let current = null;

  const flush = () => {
    if (current && current.entries.length) pages.push(current);
    current = null;
  };

  list.forEach((item, index) => {
    const box = containImageBox(item, width, imageRowBudget);
    const blockRows = header + box.imageRows;
    if (current && current.entries.length) {
      const projected = current.usedRows + gap + blockRows;
      if (projected > rowCap) flush();
    }
    if (!current) current = { entries: [], usedRows: 0 };
    const startRow = current.entries.length ? current.usedRows + gap : 0;
    current.entries.push({
      index,
      item,
      label: item?.label ?? "",
      headerRows: header,
      imageWidth: box.imageWidth,
      imageRows: box.imageRows,
      startRow,
      blockRows,
    });
    current.usedRows = startRow + blockRows;
  });
  flush();
  return pages;
}

// Compose the side-panel lines for one packed page (Part C-wire of the
// image-preview sidebar work, bd-502d6a). Given a packed page from
// packImagesIntoPages plus per-entry header/image render callbacks, this lays
// each entry's header rows followed by its image rows at the entry's packed
// `startRow`, fills unused rows with blank lines, and (by default) bottom-aligns
// the whole page block within the visible `rows` budget so the multi-image
// preview pins immediately above the editor exactly like the single-image side
// panel. Pure over its arguments plus the injected callbacks; there is no
// kitty/terminal coupling so it is unit-testable headlessly, mirroring the
// widget render seam (bd-c75d9e) — the live wiring just supplies callbacks that
// emit the name header and the per-entry transmit/placeholder lines.
//
//   renderHeaderLines(entry) -> string[]  (up to entry.headerRows lines)
//   renderImageLines(entry)  -> string[]  (up to entry.imageRows lines)
//
// Both callbacks own their own width/padding; any gap (missing callback line,
// inter-block slack, or top padding from bottom-alignment) is filled with a
// `totalWidth`-wide blank so the panel column stays rectangular. Entries (or
// rows) that fall outside the visible `rows` budget are clipped, so a caller may
// safely pass a page packed for a larger row budget than is currently visible.
export function composePagedSidePanelLines(page, {
  rows,
  totalWidth = 0,
  renderHeaderLines,
  renderImageLines,
  bottomAlign = true,
} = {}) {
  const rowCount = Math.max(0, Math.trunc(Number(rows) || 0));
  if (rowCount <= 0) return [];
  const blank = " ".repeat(Math.max(0, Math.trunc(Number(totalWidth) || 0)));
  const entries = Array.isArray(page?.entries) ? page.entries : [];
  // The packed page height is the bottom of its last block; clip to the visible
  // budget so an over-tall packed page never overflows the reserved frame.
  const usedRows = entries.reduce(
    (max, entry) => Math.max(max, Math.trunc(entry?.startRow ?? 0) + Math.trunc(entry?.blockRows ?? 0)),
    0,
  );
  const pageHeight = Math.min(rowCount, Math.max(0, usedRows));
  const slots = new Array(pageHeight).fill(blank);
  for (const entry of entries) {
    const headerLines = renderHeaderLines?.(entry) ?? [];
    const imageLines = renderImageLines?.(entry) ?? [];
    const startRow = Math.trunc(entry?.startRow ?? 0);
    const header = Math.max(0, Math.trunc(entry?.headerRows ?? headerLines.length));
    const imageRows = Math.max(0, Math.trunc(entry?.imageRows ?? imageLines.length));
    for (let h = 0; h < header; h += 1) {
      const slot = startRow + h;
      if (slot >= 0 && slot < pageHeight) slots[slot] = headerLines[h] ?? blank;
    }
    for (let i = 0; i < imageRows; i += 1) {
      const slot = startRow + header + i;
      if (slot >= 0 && slot < pageHeight) slots[slot] = imageLines[i] ?? blank;
    }
  }
  // Bottom-align the packed block within the visible frame by default, padding
  // the top with blanks; bottomAlign=false anchors the block to the top instead.
  const topPad = bottomAlign ? Math.max(0, rowCount - pageHeight) : 0;
  return Array.from({ length: rowCount }, (_unused, row) => {
    const local = row - topPad;
    return local >= 0 && local < pageHeight ? slots[local] : blank;
  });
}

// Find which packed page contains the image at the given global item index.
// Returns the 0-based page number, or 0 when the index is not found (degenerate
// or empty page sets). Pure over its arguments.
export function pageForIndex(pages, index) {
  const target = Math.trunc(Number(index) || 0);
  const list = Array.isArray(pages) ? pages : [];
  for (let page = 0; page < list.length; page += 1) {
    if (Array.isArray(list[page]?.entries) && list[page].entries.some((entry) => entry.index === target)) {
      return page;
    }
  }
  return 0;
}

export function limitLinesToTerminalRows(lines, terminalRows) {
  const rowLimit = Math.max(1, Math.trunc(Number(terminalRows) || 1));
  const input = Array.isArray(lines) ? lines : [];
  return input.length <= rowLimit ? input : input.slice(input.length - rowLimit);
}

export function currentTerminalColumns() {
  const columns = Number(process.stdout?.columns ?? process.env.COLUMNS);
  return Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : undefined;
}

export function currentTerminalRows() {
  const rows = Number(process.stdout?.rows ?? process.env.LINES);
  return Number.isFinite(rows) && rows > 0 ? Math.trunc(rows) : undefined;
}

export function previewViewportRowLimit(viewportRows = currentTerminalRows()) {
  return viewportHalfRowLimit(viewportRows);
}

export function previewImageRowLimit({ viewportRows = currentTerminalRows(), availableRows, includeControls = false, reservedRows, protocolMax = 200 } = {}) {
  const limits = [Math.max(1, Math.trunc(protocolMax || 1))];
  const viewportLimit = previewViewportRowLimit(viewportRows);
  // reservedRows takes precedence when provided (e.g. the unicode framing uses
  // two hlines + a header line); otherwise fall back to the legacy single
  // controls-row reservation.
  const reserve = reservedRows !== undefined ? Math.max(0, Math.trunc(reservedRows)) : (includeControls ? 1 : 0);
  if (viewportLimit !== undefined) limits.push(Math.max(1, viewportLimit - reserve));
  if (availableRows !== undefined) limits.push(Math.max(1, Math.trunc(availableRows)));
  return Math.max(1, Math.min(...limits));
}

export function buildSidePanelLayout(state, terminalWidth, availableRows = DEFAULT_MAX_ROWS) {
  const width = Math.max(1, Math.trunc(terminalWidth || 1));
  // Keep at least one text column. On absurdly narrow terminals, disable the
  // side rail rather than generating lines wider than the terminal.
  const maxTotalWidth = Math.max(0, Math.min(Math.floor(width * SIDE_PANEL_MAX_WIDTH_RATIO), width - 1));
  const rowLimit = Math.max(0, Math.trunc(availableRows || 0));
  if (maxTotalWidth < 1 || rowLimit < 1) {
    return { mainWidth: width, imageWidth: 0, imageRows: 0, padding: 0, totalWidth: 0 };
  }
  const maxRows = Math.min(
    state.config.rows === undefined ? rowLimit : clampInteger(state.config.rows, rowLimit, 1, rowLimit),
    MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1,
  );
  if (maxRows < 1) {
    return { mainWidth: width, imageWidth: 0, imageRows: 0, padding: 0, totalWidth: 0 };
  }
  const padding = Math.min(SIDE_PANEL_LEFT_PADDING, Math.max(0, maxTotalWidth - 1));
  const maxImageWidth = Math.max(1, maxTotalWidth - padding);
  const current = state.items[state.index];
  const imageWidth = fitImageColumnsForRows(current, maxImageWidth, maxRows);
  const imageRows = Math.min(maxRows, estimatedRowsForColumns(current, imageWidth));
  const totalWidth = Math.min(maxTotalWidth, imageWidth + padding);
  return {
    mainWidth: Math.max(1, width - totalWidth),
    imageWidth,
    imageRows,
    padding: Math.max(0, totalWidth - imageWidth),
    totalWidth,
  };
}

// Pure recursive component-tree membership test (does root contain target in
// its children graph). Extracted from kitty-image-preview.js (bd-e1914a);
// no state/ctx/imports.
export function componentContains(root, target, seen = new Set()) {
  if (!root || !target || seen.has(root)) return false;
  if (root === target) return true;
  seen.add(root);
  if (!Array.isArray(root.children)) return false;
  return root.children.some((child) => componentContains(child, target, seen));
}

// Pure component-tree render helpers extracted from kitty-image-preview.js
// (bd-e1914a). They only invoke each child's render(width) method; no state/ctx.
export function renderChildren(children, width) {
  const lines = [];
  for (const child of children) lines.push(...child.render(width));
  return lines;
}

export function wantsFullWidthWithSidePanel(component) {
  return Boolean(component?.__piGraphicsFullWidthWidget || component?.__kittyImagePreviewFullWidthWidget);
}

export function renderChildrenForSidePanel(children, mainWidth, fullWidth) {
  const lines = [];
  const fullWidthLines = [];
  for (const child of children) {
    const childFullWidth = wantsFullWidthWithSidePanel(child);
    const childLines = child.render(childFullWidth ? fullWidth : mainWidth);
    for (const line of childLines) {
      lines.push(line);
      fullWidthLines.push(childFullWidth);
    }
  }
  return { lines, fullWidthLines };
}
