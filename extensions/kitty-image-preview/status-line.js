// Status-line / control-hint formatters extracted from kitty-image-preview.js
// (bd-e1914a). Pure over `state`; produce the widget status string and the
// slash-command control hint. Behavior unchanged from the inline definitions.

import { pluralizeImages, truncatePlainText } from "./text-utils.js";

export function imageControlHint(state, { includeCount = false } = {}) {
  if (state.items.length === 0) return "/image-status";
  if (!state.visible) {
    const count = includeCount ? ` ${state.items.length} ${pluralizeImages(state.items.length)}` : "";
    return `/image-show /image-clear${count}`;
  }
  const nav = state.items.length > 1 ? "/image-prev /image-next " : "";
  const count = includeCount ? ` ${state.index + 1}/${state.items.length}` : "";
  return `${nav}/image-hide /image-clear${count}`;
}

export function imageStatusLine(state, current) {
  if (state.items.length === 0) return undefined;
  if (!state.visible) return `🖼 hidden ${state.items.length} ${pluralizeImages(state.items.length)} — /image-show /image-clear`;
  const animation = state.animation?.running ? " ▶" : "";
  const cycle = state.cycle?.running ? ` ⟳${Math.round((state.cycle.intervalMs || 0) / 1000)}s` : "";
  const label = current?.label ? ` ${current.label}` : "";
  return `🖼${animation}${cycle} ${state.index + 1}/${state.items.length}${label} — ${imageControlHint(state)}`;
}

// Single truncated "controls: …" hint line for the current preview state.
// Extracted from kitty-image-preview.js (bd-e1914a).
export function imageControlsLine(state, width) {
  if (state.items.length === 0) return "";
  return truncatePlainText(`controls: ${imageControlHint(state, { includeCount: true })}`, width);
}
