// Terminal cell-width measurement and ANSI-aware truncation for the pi-graphics
// extension, extracted from pi-graphics.js (bd-e1914a). Self-contained: pure
// functions over strings plus the TERMINAL_CONTROL_RE escape-sequence regex.
// No module/closure state, no ctx/pi coupling. readTerminalControlAt,
// charCellWidth, and truncateAnsiToVisibleWidth are subsystem-internal; the
// extension consumes approximateVisibleCells, clampRenderedLineToWidth, and
// clampRenderedRowsToWidth.

const TERMINAL_CONTROL_RE = /(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b\][\s\S]*?(?:\x07|\x1b\\))|(?:\x1b[_PG][\s\S]*?\x1b\\)/g;

export function readTerminalControlAt(text, index) {
  TERMINAL_CONTROL_RE.lastIndex = index;
  const match = TERMINAL_CONTROL_RE.exec(text);
  return match && match.index === index ? match[0] : null;
}

export function charCellWidth(ch) {
  if (!ch) return 0;
  const code = ch.codePointAt(0) || 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  // Zero-width: Latin combining diacriticals, zero-width/bidi/invisible
  // formatting and joiner controls (incl. ZWJ used in emoji sequences),
  // variation selectors, and the dedicated all-non-spacing combining-mark
  // blocks (Cyrillic, combining extensions/supplement, symbols, half marks).
  // These render as 0 cells. Interspersed-spacing scripts (Hebrew/Arabic)
  // need per-codepoint ranges and are intentionally excluded (bd-46436b).
  if (
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x483 && code <= 0x489) ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) return 0;
  if (
    code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    )
  ) return 2;
  return 1;
}

export function approximateVisibleCells(text) {
  const source = String(text || "");
  let width = 0;
  for (let i = 0; i < source.length;) {
    const control = readTerminalControlAt(source, i);
    if (control) { i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    width += charCellWidth(ch);
    i += ch.length;
  }
  return width;
}

export function truncateAnsiToVisibleWidth(text, maxWidth) {
  const limit = Math.max(0, Math.trunc(Number(maxWidth) || 0));
  const source = String(text || "");
  let out = "";
  let width = 0;
  let i = 0;
  for (; i < source.length;) {
    const control = readTerminalControlAt(source, i);
    if (control) { out += control; i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    const w = charCellWidth(ch);
    if (w > 0 && width + w > limit) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  for (; i < source.length;) {
    const control = readTerminalControlAt(source, i);
    if (control) { out += control; i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    i += ch.length;
  }
  return out;
}

export function clampRenderedLineToWidth(line, width) {
  const limit = Math.max(1, Math.trunc(Number(width) || 1));
  const text = String(line ?? "");
  if (approximateVisibleCells(text) <= limit) return text;
  return truncateAnsiToVisibleWidth(text, limit);
}

export function clampRenderedRowsToWidth(lines, width) {
  if (!Array.isArray(lines)) return lines;
  const limit = Math.max(1, Math.trunc(Number(width) || 1));
  return lines.map((line) => clampRenderedLineToWidth(line, limit));
}
