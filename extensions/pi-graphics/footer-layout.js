// Footer segment layout helpers extracted from pi-graphics.js (bd-0f9032).
//
// fitFooterSegments/footerSegmentsWidth are pure over their inputs: each raw
// segment carries its own { key, value, min, max, truncate } shape, and the
// only external dependencies are the FOOTER_DIVIDER_WIDTH constant and the
// shared approximateVisibleCells width estimator. Extracting them lets the
// footer width-budgeting + shrink-order behavior be asserted by calling the
// functions instead of matching source text in the extension closure.

import { approximateVisibleCells } from "./ansi-width.js";

// Visual width (in terminal cells) reserved for each divider drawn between two
// footer segments. The segmented footer renders a 1x1 unicode placeholder
// divider that occupies this many text cells.
export const FOOTER_DIVIDER_WIDTH = 3;

// Fit raw footer segments into the available terminal width.
//
// Each raw segment is { key, value, min, max, truncate(value, innerWidth) }.
// Returns a new array of segments with an added `text` field padded to the
// allocated inner width, or null when even the per-segment minimums plus the
// inter-segment dividers cannot fit. Segments are shrunk toward their `min` in
// a fixed priority order (so e.g. the model segment is preserved longest); when
// `absorbSpare` is true, leftover columns are granted to the `model` segment
// (or the first segment) so the footer fills the line.
export function fitFooterSegments(rawSegments, width, { absorbSpare = true } = {}) {
  const terminalWidth = Math.max(1, Math.trunc(Number(width) || 1));
  const dividerBudget = Math.max(0, rawSegments.length - 1) * FOOTER_DIVIDER_WIDTH;
  let budget = terminalWidth - dividerBudget;
  if (budget < rawSegments.length) return null;
  const segments = rawSegments.map((segment) => {
    const preferred = Math.min(segment.max, approximateVisibleCells(segment.value));
    return { ...segment, width: Math.max(segment.min, preferred) };
  });
  let used = segments.reduce((sum, segment) => sum + segment.width, 0);
  const shrinkOrder = [0, 5, 3, 1, 2, 4];
  while (used > budget) {
    let changed = false;
    for (const index of shrinkOrder) {
      const segment = segments[index];
      if (segment && segment.width > segment.min) {
        segment.width -= 1;
        used -= 1;
        changed = true;
        if (used <= budget) break;
      }
    }
    if (!changed) break;
  }
  if (absorbSpare && used < budget && segments.length) {
    const modelSegment = segments.find((segment) => segment.key === "model");
    const spare = budget - used;
    if (modelSegment) modelSegment.width += spare;
    else segments[0].width += spare;
  }
  return segments.map((segment) => {
    const innerWidth = Math.max(0, segment.width);
    const text = segment.truncate(segment.value, innerWidth);
    const padded = `${text}${" ".repeat(Math.max(0, innerWidth - approximateVisibleCells(text)))}`;
    return { ...segment, text: padded };
  });
}

// Total rendered width (in cells) of an array of fitted segments, including the
// dividers drawn between them. Accepts the output of fitFooterSegments (segments
// with a `text` field); returns 0 for empty/non-array input.
export function footerSegmentsWidth(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  return segments.reduce((sum, segment) => sum + approximateVisibleCells(segment.text), 0)
    + Math.max(0, segments.length - 1) * FOOTER_DIVIDER_WIDTH;
}
