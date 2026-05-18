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

function stageLabel(tone, caption) {
  const label = String(caption || "kitty graphics pulse active").toUpperCase();
  const glyph = tone === "tool" ? "⚙" : tone === "user" ? "◆" : "✦";
  return `${glyph} PI KITTY GFX // ${label}`;
}

export function buildTextStagePanel({ tone = "assistant", caption = "kitty graphics pulse active", frames = 8, delayMs = 90 } = {}) {
  const label = stageLabel(tone, caption);
  const bar = tone === "tool" ? "▱▰▱▰▱▰" : tone === "user" ? "◢◣◢◣◢◣" : "▰▱▰▱▰▱";
  return [
    `╭─ ${label} ─╮`,
    `│ ${bar} deep nordic glow • ${frames}f @ ${delayMs}ms • APNG-ready ${bar} │`,
    `╰─ neon cyan / aurora violet / void black graphical mode ─╯`,
  ];
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

export function buildStagePanelWidget(state, {
  columns = 58,
  rows = 7,
  frames = 8,
  delayMs = 80,
  tone = "assistant",
  caption = "kitty graphics pulse active",
} = {}) {
  const label = stageLabel(tone, caption);
  const pulse = renderTuiComponentPulseApng({ columns, rows, frames, delayMs, tone });
  const placement = buildPlacement(state, {
    name: `stage-panel-${pulse.tone}-${pulse.columns}x${pulse.rows}-${pulse.frames}f`,
    png: pulse.png,
    columns: pulse.columns,
    rows: pulse.rows,
    width: Math.min(120, Math.max(pulse.columns, label.length + 8)),
    caption: ` ${label}`,
  });
  const textFallback = buildTextStagePanel({ tone, caption, frames, delayMs });
  return {
    lines: [textFallback[0], ...renderToText(placement).split("\n"), textFallback[2]],
    placement,
    details: {
      columns: pulse.columns,
      rows: pulse.rows,
      frames: pulse.frames,
      delayMs: pulse.delayMs,
      tone: pulse.tone,
      caption,
      label,
      metrics: pulse.metrics,
    },
  };
}
