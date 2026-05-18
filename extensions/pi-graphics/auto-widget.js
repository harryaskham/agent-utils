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

export function shouldAutoApplyTheme(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_THEME ?? env.PI_KITTY_GRAPHICS_AUTO_THEME;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoShowSplash(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_SPLASH ?? env.PI_KITTY_GRAPHICS_AUTO_SPLASH;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function buildStartupSplashMessage({ content, tone = "assistant", title = "startup splash" } = {}) {
  const body = String(content || "PI KITTY GRAPHICS ONLINE — deep Nordic gradients, cyan/violet glow, APNG pulse, header/footer chrome, and rendered TypeScript TUI components are active.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
  return {
    customType: "pi-graphics-message",
    content: body,
    display: true,
    details: { tone, title },
  };
}

export function buildWorkingIndicatorFrames(theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  return [
    fg("dim", "✧"),
    fg("muted", "✦"),
    fg("accent", "◆"),
    fg("borderAccent", "✺"),
    fg("thinkingXhigh", "⬢"),
    fg("borderAccent", "✺"),
    fg("accent", "◆"),
    fg("muted", "✦"),
  ];
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

export function buildPiGraphicsMessageLines({ content = "Pi graphics message", tone = "assistant", title = "rendered message", expanded = false } = {}, theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const safeContent = String(content || "Pi graphics message").replace(/\s+/g, " ").trim();
  const safeTitle = String(title || "rendered message").replace(/\s+/g, " ").trim().toUpperCase();
  const label = stageLabel(tone, safeTitle);
  const rail = tone === "tool" ? fg("toolTitle", "▌") : tone === "user" ? fg("borderAccent", "▌") : fg("accent", "▌");
  const pulse = fg("thinkingXhigh", "⬢") + fg("borderAccent", "◆") + fg("accent", "✦");
  const body = safeContent.length > 96 ? `${safeContent.slice(0, 93)}...` : safeContent;
  const lines = [
    bg("customMessageBg", `${rail} ${fg("customMessageLabel", label)} ${pulse}`),
    bg("customMessageBg", `${rail} ${fg("text", body)}`),
    bg("customMessageBg", `${rail} ${fg("dim", "cyan/violet glow • rendered by pi_graphics message renderer")}`),
  ];
  if (expanded) {
    lines.push(bg("customMessageBg", `${rail} ${fg("muted", "expanded: pure TypeScript TUI component, no external pi-tui import")}`));
  }
  return lines;
}

function boundedLines(lines, width = 120) {
  const max = Math.max(24, Math.trunc(width));
  return lines.map((line) => line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line);
}

export function buildPiGraphicsMessageComponent(message, options = {}, theme) {
  const details = message?.details && typeof message.details === "object" ? message.details : {};
  const lines = buildPiGraphicsMessageLines({
    content: message?.content,
    tone: details.tone || "assistant",
    title: details.title || message?.customType || "rendered message",
    expanded: Boolean(options.expanded),
  }, theme);
  return {
    render(width = 120) { return boundedLines(lines, width); },
    invalidate() {},
  };
}

export function buildPiGraphicsHeaderLines(theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const left = fg("borderAccent", "╭─⬢─◆─✦");
  const right = fg("thinkingXhigh", "✦─◆─⬢─╮");
  return [
    bg("selectedBg", `${left} ${fg("customMessageLabel", "PI KITTY GRAPHICS ONLINE")} ${right}`),
    bg("customMessageBg", `${fg("accent", "▌")} ${fg("text", "deep Nordic void • cyan/violet glow • APNG pulse • TypeScript TUI mirror")}`),
    bg("toolPendingBg", `${fg("muted", "▔".repeat(12))} ${fg("borderAccent", "never-a-normal-terminal mode")}`),
  ];
}

export function buildPiGraphicsHeaderComponent(theme) {
  const lines = buildPiGraphicsHeaderLines(theme);
  return {
    render(width = 120) { return boundedLines(lines, width); },
    invalidate() {},
  };
}

export function buildPiGraphicsFooterLines(theme, footerData = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const branch = footerData?.gitBranch ? ` • ${footerData.gitBranch}` : "";
  const mode = fg("customMessageLabel", "KITTY-GFX");
  const pulse = fg("thinkingXhigh", "⬢") + fg("borderAccent", "◆") + fg("accent", "✦");
  const status = fg("text", `deep nordic glow${branch}`);
  return [bg("toolPendingBg", `${fg("borderAccent", "▰▱▰")} ${mode} ${pulse} ${status}`)];
}

export function buildPiGraphicsFooterComponent(theme, footerData = {}) {
  const lines = buildPiGraphicsFooterLines(theme, footerData);
  return {
    render(width = 120) { return boundedLines(lines, width); },
    invalidate() {},
  };
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
