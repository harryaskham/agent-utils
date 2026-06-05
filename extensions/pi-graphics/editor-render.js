// Pure editor render-composition helpers extracted from pi-graphics.js
// (bd-f5f802). The KittyEditor wrapper decorates the base editor rows: it
// detects the ASCII/box dash rule rows, swaps the first/last dash rule for
// rendered top/bottom border rows, decorates the remaining content rows, and
// clamps everything to the terminal width. The stateful parts (cursor chrome,
// trailing workspace PNGs, border PNG rows, width clamping) stay in the
// extension closure and are injected here as callbacks, so this orchestration
// can be asserted behaviorally instead of by matching the exact return
// expression in source.

// A dash rule row is one whose visible text (ANSI stripped) is non-empty and
// consists solely of whitespace and horizontal box-drawing dashes. Pi renders
// the editor's top/bottom separators as such rows, which this module replaces
// with graphical border rows.
export function isEditorDashLine(line) {
  const text = String(line || "").replace(/\x1b\[[0-9;]*m/g, "").trim();
  return text.length > 0 && /^[\s─━═]+$/.test(text);
}

// Compose the decorated editor rows from the base rows.
//
// All terminal-bound work is delegated to injected callbacks so this stays pure
// and testable:
//   - width:            terminal width passed through to the callbacks
//   - isDashLine:       predicate identifying separator rows (defaults to
//                       isEditorDashLine)
//   - decorateLine:     (line, width) => decorated content line
//   - clampRows:        (lines, width) => width-clamped lines (final pass)
//   - buildBorderRow:   (width, edge) => rendered border row, or falsy when the
//                       graphical border is unavailable
//   - topLeftUnicode:   when true, the unicode top-left editor border owns the
//                       separator rows, so dash rows are passed through verbatim
//                       and only content rows are decorated
//
// Mirrors the original KittyEditor.render control flow exactly:
//   * < 2 base rows, or a non-array: return base rows unchanged (no clamp).
//   * no dash rows: decorate every row, then clamp.
//   * topLeftUnicode: decorate non-dash rows (dash rows verbatim), then clamp.
//   * otherwise: replace the first dash row with a top border and, when there is
//     a distinct last dash row, the last with a bottom border; if no top border
//     is available, clamp the untouched base rows; decorate the remaining
//     non-dash rows and clamp.
export function composeEditorRenderRows(baseLines, {
  width,
  isDashLine = isEditorDashLine,
  decorateLine,
  clampRows,
  buildBorderRow,
  topLeftUnicode = false,
} = {}) {
  if (!Array.isArray(baseLines) || baseLines.length < 2) return baseLines;
  const next = baseLines.slice();
  const dashIndices = [];
  for (let i = 0; i < next.length; i += 1) {
    if (isDashLine(next[i])) dashIndices.push(i);
  }
  if (dashIndices.length === 0) {
    return clampRows(baseLines.map((line) => decorateLine(line, width)), width);
  }
  if (topLeftUnicode) {
    return clampRows(
      next.map((line, index) => (dashIndices.includes(index) ? line : decorateLine(line, width))),
      width,
    );
  }
  const firstDash = dashIndices[0];
  const lastDash = dashIndices[dashIndices.length - 1];
  const top = buildBorderRow(width, "top");
  const bot = firstDash !== lastDash ? buildBorderRow(width, "bottom") : null;
  if (!top) return clampRows(baseLines, width);
  next[firstDash] = top;
  if (bot && lastDash !== firstDash) next[lastDash] = bot;
  return clampRows(
    next.map((line, index) => (dashIndices.includes(index) ? line : decorateLine(line, width))),
    width,
  );
}
