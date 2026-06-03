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

// Default label for a captured screenshot, derived from the Tendril target and
// capture time. Pure over its arguments. Extracted from kitty-image-preview.js
// (bd-e1914a).
export function defaultScreenshotLabel(target, date = new Date()) {
  const name = target.title || target.name || target.app_name || target.id;
  return `screenshot ${target.kind} ${name} ${date.toLocaleTimeString()}`;
}

// One-line human-readable summary of an active screenshot stream. Pure over the
// `stream` object plus the current clock. Extracted from kitty-image-preview.js
// (bd-e1914a).
export function streamStatusLine(stream) {
  if (!stream?.running) return "No kitty image preview stream is running.";
  const elapsedSeconds = Math.max(0.001, (Date.now() - stream.startedAt) / 1000);
  const fps = stream.frameCount / elapsedSeconds;
  return `Streaming ${stream.target.kind} ${stream.target.id}: frames=${stream.frameCount} fps=${fps.toFixed(2)} interval=${stream.intervalMs}ms latest=${stream.latestPath || "none"}`;
}
