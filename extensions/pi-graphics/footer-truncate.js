// Pure footer text-truncation helpers for the pi-graphics extension, extracted
// from pi-graphics.js (bd-e1914a). Self-contained: no module/closure state —
// pure grapheme-array slicing keyed off a width. truncateFooterStart keeps the
// tail (for paths), truncateFooterEnd keeps the head (for labels/branches).

export function truncateFooterStart(text, width) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= width) return chars.join("");
  if (width <= 0) return "";
  return chars.slice(chars.length - width).join("");
}

export function truncateFooterEnd(text, width) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= width) return chars.join("");
  if (width <= 0) return "";
  return chars.slice(0, width).join("");
}
