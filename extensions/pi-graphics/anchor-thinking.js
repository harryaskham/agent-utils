// Pure value classifiers extracted from pi-graphics.js (bd-e1914a).
// Self-contained: no module/closure state, no ctx/pi coupling.
//
// - normalizeUnicodeAnchorMode maps a raw unicode-anchor setting string to the
//   canonical "topLeft"/"fill" mode used by box/box-rail unicode placement.
// - valueLooksLikeThinking inspects a status value/label/object and reports
//   whether it represents a thinking/reasoning/responding phase, used to drive
//   the editor context heat mode.

export function normalizeUnicodeAnchorMode(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (["topleft", "top-left", "top_left", "anchor", "single", "joined", "joinedunicode"].includes(value)) return "topLeft";
  return "fill";
}

export function valueLooksLikeThinking(value) {
  if (value?.type === "thinking" || value?.stage === "thinking" || value?.phase === "thinking") return true;
  const text = typeof value === "string" ? value : typeof value?.label === "string" ? value.label : typeof value?.text === "string" ? value.text : "";
  return /\b(thinking|reasoning|responding)\b/i.test(text);
}
