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

export function previewImageRowLimit({ viewportRows = currentTerminalRows(), availableRows, includeControls = false, protocolMax = 200 } = {}) {
  const limits = [Math.max(1, Math.trunc(protocolMax || 1))];
  const viewportLimit = previewViewportRowLimit(viewportRows);
  if (viewportLimit !== undefined) limits.push(Math.max(1, viewportLimit - (includeControls ? 1 : 0)));
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
