import { approximateVisibleCells } from "./ansi-width.js";

export const EDITOR_CURSOR_GLOW_COLUMNS = 11;
export const EDITOR_CURSOR_GLOW_ROWS = 5;
export const EDITOR_CURSOR_H_OFFSET = -Math.floor(EDITOR_CURSOR_GLOW_COLUMNS / 2);
export const EDITOR_CURSOR_V_OFFSET = -Math.floor(EDITOR_CURSOR_GLOW_ROWS / 2);

const REVERSE_VIDEO_CURSOR_RE = /\x1b\[7m[^\x1b]*\x1b\[(?:0|27)m/;

/**
 * Locate Pi's rendered reverse-video cursor in one fullscreen editor row.
 * The returned column is relative to the row, not the terminal screen: Kitty's
 * virtual placeholder supplies the physical anchor after Pi paints the row.
 */
export function locateEditorCursorAnchor(line, rowWidth = 1) {
  const text = String(line ?? "");
  const match = REVERSE_VIDEO_CURSOR_RE.exec(text);
  if (!match) return null;
  const width = Math.max(1, Math.trunc(Number(rowWidth) || 1));
  const cursorCol = approximateVisibleCells(text.slice(0, match.index));
  const left = cursorCol + EDITOR_CURSOR_H_OFFSET;
  const right = left + EDITOR_CURSOR_GLOW_COLUMNS;
  return {
    matchIndex: match.index,
    matchText: match[0],
    cursorCol,
    rowWidth: width,
    columns: EDITOR_CURSOR_GLOW_COLUMNS,
    rows: EDITOR_CURSOR_GLOW_ROWS,
    hOffset: EDITOR_CURSOR_H_OFFSET,
    vOffset: EDITOR_CURSOR_V_OFFSET,
    clippedLeftCells: Math.max(0, -left),
    clippedRightCells: Math.max(0, right - width),
  };
}

export function replaceLocatedEditorCursor(line, anchor, replacement) {
  if (!anchor) return line;
  const text = String(line ?? "");
  return `${text.slice(0, anchor.matchIndex)}${replacement}${text.slice(anchor.matchIndex + anchor.matchText.length)}`;
}
