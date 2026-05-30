// Image-fit / row-limit layout math extracted from kitty-image-preview.js
// (bd-e1914a). Pure functions over their arguments plus the kitty-graphics
// row-estimation primitive and placeholder diacritic cap. Behavior is unchanged
// from the original inline definitions.

import { MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE, estimateRowsForImage } from "../kitty-graphics.js";

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
