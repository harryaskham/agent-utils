// Auto-visible Pi kitty graphics widget helpers.
//
// These are split from the Pi extension factory so tests can validate the
// graphical startup/status surface without booting Pi. The widget is intentionally
// small and APNG-backed: normal sessions get an unmistakable animated glow cue,
// but the upload stays bounded and is owned by the pi-graphics image registry.

import { renderTuiComponentPulseApng } from "./components.js";
import { buildPlacement, renderToText } from "./runtime.js";

const FALSE_RE = /^(0|false|off|no)$/i;

export function shouldAutoShowGraphics(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_WIDGET ?? env.PI_KITTY_GRAPHICS_AUTO_WIDGET;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function buildAutoPulseWidget(state, {
  columns = 42,
  rows = 6,
  frames = 8,
  delayMs = 90,
  tone = "assistant",
  caption = "kitty graphics pulse active",
} = {}) {
  const pulse = renderTuiComponentPulseApng({ columns, rows, frames, delayMs, tone });
  const placement = buildPlacement(state, {
    name: `auto-pulse-${pulse.tone}-${pulse.columns}x${pulse.rows}-${pulse.frames}f`,
    png: pulse.png,
    columns: pulse.columns,
    rows: pulse.rows,
    width: Math.min(120, pulse.columns + String(caption || "").length + 1),
    caption,
  });
  return {
    lines: renderToText(placement).split("\n"),
    placement,
    details: {
      columns: pulse.columns,
      rows: pulse.rows,
      frames: pulse.frames,
      delayMs: pulse.delayMs,
      tone: pulse.tone,
      metrics: pulse.metrics,
    },
  };
}
