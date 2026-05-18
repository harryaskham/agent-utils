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

export function shouldAutoShowThemeSwatchSplash(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_THEME_SWATCH ?? env.PI_KITTY_GRAPHICS_AUTO_THEME_SWATCH;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoShowTerminalScene(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_TERMINAL_SCENE ?? env.PI_KITTY_GRAPHICS_AUTO_TERMINAL_SCENE;
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

export function buildStartupThemeSwatchMessage({ width = 96 } = {}) {
  return {
    customType: "pi-graphics-theme-swatch",
    content: "PI KITTY GRAPHICS THEME SWATCH — actual runtime theme-token calibration bars",
    display: true,
    details: { width },
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

export function buildWorkingMessage({ stage = "active", toolName = "" } = {}, theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const safeStage = String(stage || "active").replace(/\s+/g, " ").trim().slice(0, 28).toUpperCase();
  const safeTool = String(toolName || "").replace(/\s+/g, " ").trim().slice(0, 32);
  const suffix = safeTool ? ` // ${safeTool}` : "";
  return `${fg("thinkingXhigh", "⬢")} ${fg("customMessageLabel", "PI KITTY GFX")} ${fg("borderAccent", `// ${safeStage}`)}${fg("muted", suffix)} ${fg("accent", "deep nordic glow")}`;
}

export function buildHiddenThinkingLabel(theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  return `${fg("thinkingXhigh", "⬢")} ${fg("customMessageLabel", "PI GFX THOUGHTSTREAM")} ${fg("muted", "folded")}`;
}

export function buildTerminalTitle({ stage = "ready", toolName = "" } = {}) {
  const safeStage = String(stage || "ready").replace(/\s+/g, " ").trim().slice(0, 28).toUpperCase();
  const safeTool = String(toolName || "").replace(/\s+/g, " ").trim().slice(0, 28);
  const suffix = safeTool ? ` · ${safeTool}` : "";
  return `⬢ PI KITTY GFX // ${safeStage}${suffix}`.slice(0, 80);
}

export function buildVisualContractLines({ themeName = "kitty-graphics", unicodePlacement = false, splash = true } = {}, theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const ok = (label) => `${fg("success", "✓")} ${fg("customMessageLabel", label)}`;
  const warn = (label) => `${fg("warning", "⚠")} ${fg("borderAccent", label)}`;
  return [
    fg("thinkingXhigh", "⬢ PI KITTY GRAPHICS VISUAL CONTRACT ⬢"),
    ok(`theme requested: ${themeName}`),
    unicodePlacement ? ok("kitty placeholder graphics active") : warn("kitty placeholder graphics fallback text active"),
    ok("header/footer/HUD/floodlight mounted"),
    ok("editor frame + APNG aura mounted"),
    ok("working row + terminal title branded"),
    splash ? ok("startup splash enabled") : warn("startup splash disabled by env"),
    fg("muted", "If any line is absent in the UI, reload Pi packages/tools and check opt-out env vars."),
  ];
}

export function buildPiGraphicsDoctorLines({ themeName = "unknown", unicodePlacement = false, autoTerminalScene = true, autoTheme = true, autoWidget = true, autoSplash = true, autoThemeSwatch = true } = {}, theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const ok = (label) => `${fg("success", "✓")} ${label}`;
  const warn = (label) => `${fg("warning", "⚠")} ${label}`;
  const themeOk = themeName === "kitty-graphics" || themeName === "unknown";
  return [
    fg("thinkingXhigh", "⬢ PI KITTY GRAPHICS DOCTOR / TAKEOVER ⬢"),
    themeOk ? ok(`theme: ${themeName}`) : warn(`theme: ${themeName} (select /settings → kitty-graphics)`),
    unicodePlacement ? ok("kitty placeholders: active, APNG pixels can render") : warn("kitty placeholders: inactive, image/APNG surfaces fall back to text"),
    autoTheme ? ok("auto theme apply: enabled") : warn("auto theme apply disabled by PI_GRAPHICS_AUTO_THEME"),
    autoWidget ? ok("auto stage/floodlight/widgets: enabled") : warn("auto widgets disabled by PI_GRAPHICS_AUTO_WIDGET"),
    autoTerminalScene ? ok("auto rendered terminal scene: enabled") : warn("auto terminal scene disabled by PI_GRAPHICS_AUTO_TERMINAL_SCENE"),
    autoSplash ? ok("startup splash: enabled") : warn("startup splash disabled"),
    autoThemeSwatch ? ok("transcript theme swatch: enabled") : warn("transcript theme swatch disabled"),
    fg("customMessageLabel", "Takeover actions: /pi-graphics-show, /pi-graphics-theme-swatch-message, /pi-graphics-photon-rain, pi_graphics_render_terminal_scene."),
    fg("muted", "If this doctor is absent after update, reload Pi tools/session; if theme says not kitty-graphics, use /settings."),
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

export function buildPiGraphicsThemeSwatchLines(theme, { width = 96, phase = 0 } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const cells = Math.max(48, Math.min(160, Math.trunc(width)));
  const p = Math.abs(Math.sin(Number(phase) * Math.PI * 2));
  const barWidth = Math.max(10, Math.min(34, Math.floor(cells / 4)));
  const brightBar = (p > 0.5 ? "█▓" : "▓█").repeat(Math.ceil(barWidth / 2)).slice(0, barWidth);
  const dimBar = (p > 0.5 ? "▒░" : "░▒").repeat(Math.ceil(barWidth / 2)).slice(0, barWidth);
  return [
    bg("selectedBg", `${fg("thinkingXhigh", "⬢ PI THEME CALIBRATION SWATCH ⬢")} ${fg("muted", "actual theme tokens")}`),
    bg("customMessageBg", `${fg("borderAccent", brightBar)} ${fg("customMessageLabel", "selectedBg + borderAccent")} ${fg("accent", "cyan rail")}`),
    bg("toolPendingBg", `${fg("thinkingXhigh", brightBar)} ${fg("customMessageLabel", "toolPendingBg + thinkingXhigh")} ${fg("muted", "violet glow")}`),
    bg("selectedBg", `${fg("accent", dimBar)} ${fg("customMessageLabel", "accent pulse")} ${fg("success", "success")} ${fg("warning", "warning")} ${fg("error", "error")}`),
    bg("customMessageBg", `${fg("dim", "If these bars look ordinary, the kitty-graphics theme is not active in this Pi session.")}`),
  ];
}

export function buildPiGraphicsThemeSwatchComponent(theme, options = {}) {
  let tick = Number(options.phase || 0);
  return {
    render(width = 120) {
      tick = (tick + 0.125) % 1;
      return boundedLines(buildPiGraphicsThemeSwatchLines(theme, { ...options, width, phase: tick }), width);
    },
    invalidate() { tick = (tick + 0.25) % 1; },
  };
}

export function buildPiGraphicsThemeSwatchMessageComponent(message, _options = {}, theme) {
  const details = message?.details && typeof message.details === "object" ? message.details : {};
  return buildPiGraphicsThemeSwatchComponent(theme, { width: details.width || 96, phase: details.phase || 0 });
}

export function buildPiGraphicsPhotonRainLines(theme, { width = 96, phase = 0 } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const cells = Math.max(48, Math.min(180, Math.trunc(width)));
  const glyphs = ["⬢", "◆", "✦", "✺", "▰", "▱", "◢", "◣"];
  const offset = Math.abs(Math.trunc(Number(phase) * 17)) % glyphs.length;
  const makeRain = (row) => Array.from({ length: Math.max(18, Math.min(72, cells - 28)) }, (_, i) => glyphs[(i + row + offset) % glyphs.length]).join("");
  return [
    bg("selectedBg", `${fg("thinkingXhigh", "╔═⬢")} ${fg("customMessageLabel", "PI PHOTON RAIN // DEEP NORDIC RENDER FIELD")} ${fg("borderAccent", "⬢═╗")}`),
    bg("customMessageBg", `${fg("borderAccent", "║")} ${fg("accent", makeRain(0))} ${fg("muted", "cyan ion drift")}`),
    bg("toolPendingBg", `${fg("borderAccent", "║")} ${fg("thinkingXhigh", makeRain(2))} ${fg("muted", "violet pulse scan")}`),
    bg("customMessageBg", `${fg("borderAccent", "║")} ${fg("accent", makeRain(4))} ${fg("muted", "aurora terminal field")}`),
    bg("selectedBg", `${fg("thinkingXhigh", "╚═")}${fg("borderAccent", "▀".repeat(Math.max(12, Math.min(64, cells - 26))))}${fg("thinkingXhigh", "═╝")} ${fg("customMessageLabel", "never-normal terminal")}`),
  ];
}

export function buildPiGraphicsPhotonRainComponent(theme, options = {}) {
  let tick = Number(options.phase || 0);
  return {
    render(width = 120) {
      tick = (tick + 0.0625) % 1;
      return boundedLines(buildPiGraphicsPhotonRainLines(theme, { ...options, width, phase: tick }), width);
    },
    invalidate() { tick = (tick + 0.125) % 1; },
  };
}

export function buildPiGraphicsLighthouseLines(theme, { width = 112, phase = 0 } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const cells = Math.max(64, Math.min(180, Math.trunc(width)));
  const p = Math.abs(Math.sin(Number(phase) * Math.PI * 2));
  const barA = (p > 0.5 ? "█▓▒░" : "░▒▓█").repeat(Math.ceil(cells / 4)).slice(0, cells);
  const barB = (p > 0.5 ? "▰▱⬢◆✦" : "✦◆⬢▱▰").repeat(Math.ceil(cells / 5)).slice(0, cells);
  const center = "PI KITTY GRAPHICS LIGHTHOUSE // GRAPHICAL MODE IS ACTIVE";
  const pad = Math.max(0, Math.floor((cells - center.length) / 2));
  return [
    bg("selectedBg", fg("thinkingXhigh", barA)),
    bg("customMessageBg", `${fg("borderAccent", "█".repeat(Math.max(4, pad)))} ${fg("customMessageLabel", center)} ${fg("borderAccent", "█".repeat(Math.max(4, pad)))}`),
    bg("toolPendingBg", `${fg("accent", barB)}`),
    bg("customMessageBg", `${fg("thinkingXhigh", "⬢")} ${fg("text", "DEEP NORDIC AURORA // CYAN-VIOLET GLOW // RENDERED TUI MIRROR // APNG READY")} ${fg("thinkingXhigh", "⬢")}`),
    bg("selectedBg", fg("borderAccent", barA.split("").reverse().join(""))),
  ];
}

export function buildPiGraphicsLighthouseComponent(theme, options = {}) {
  let tick = Number(options.phase || 0);
  return {
    render(width = 120) {
      tick = (tick + 0.08) % 1;
      return boundedLines(buildPiGraphicsLighthouseLines(theme, { ...options, width, phase: tick }), width);
    },
    invalidate() { tick = (tick + 0.16) % 1; },
  };
}

function footerBranch(footerData = {}) {
  if (typeof footerData.getGitBranch === "function") return footerData.getGitBranch() || "";
  return footerData?.gitBranch || "";
}

function footerStatuses(footerData = {}) {
  const source = typeof footerData.getExtensionStatuses === "function"
    ? footerData.getExtensionStatuses()
    : footerData?.extensionStatuses;
  const entries = source instanceof Map ? Array.from(source.entries()) : Object.entries(source || {});
  return entries
    .filter(([key]) => String(key).startsWith("pi"))
    .slice(0, 3)
    .map(([key, value]) => `${key}:${String(value).replace(/\s+/g, " ").slice(0, 28)}`);
}

export function buildPiGraphicsFooterLines(theme, footerData = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const branch = footerBranch(footerData);
  const branchText = branch ? ` • ${branch}` : "";
  const statuses = footerStatuses(footerData);
  const statusText = statuses.length ? ` • ${statuses.join(" • ")}` : " • gfx surfaces armed";
  const mode = fg("customMessageLabel", "KITTY-GFX LIVE FOOTER");
  const pulse = fg("thinkingXhigh", "⬢") + fg("borderAccent", "◆") + fg("accent", "✦");
  const status = fg("text", `deep nordic glow${branchText}${statusText}`);
  return [bg("toolPendingBg", `${fg("borderAccent", "▰▱▰")} ${mode} ${pulse} ${status}`)];
}

export function buildPiGraphicsFooterComponent(theme, footerData = {}) {
  return {
    render(width = 120) { return boundedLines(buildPiGraphicsFooterLines(theme, footerData), width); },
    invalidate() {},
  };
}

export function buildPiGraphicsHudLines(theme, { phase = 0 } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const p = Math.abs(Math.sin(Number(phase) * Math.PI * 2));
  const level = p > 0.66 ? "MAX" : p > 0.33 ? "MID" : "LOW";
  return [
    bg("selectedBg", `${fg("borderAccent", "╔═◢")} ${fg("customMessageLabel", "PI GFX HUD")} ${fg("thinkingXhigh", `pulse:${level}`)} ${fg("borderAccent", "◣═╗")}`),
    bg("customMessageBg", `${fg("accent", "║")} ${fg("text", "TypeScript component render mirror")}${fg("muted", " :: ")}${fg("borderAccent", "deep nordic photon field")}`),
    bg("toolPendingBg", `${fg("accent", "╚═")}${fg("thinkingXhigh", "⬢◆✦⬢◆✦")}${fg("accent", "═")}${fg("muted", " efficient persistent HUD below editor")}`),
  ];
}

export function buildPiGraphicsHudComponent(theme, options = {}) {
  let tick = Number(options.phase || 0);
  return {
    render(width = 120) {
      tick = (tick + 0.125) % 1;
      return boundedLines(buildPiGraphicsHudLines(theme, { phase: tick }), width);
    },
    invalidate() { tick = (tick + 0.25) % 1; },
  };
}

export function buildPiGraphicsEditorFrameLines(theme, { edge = "top", width = 72, phase = 0 } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const cells = Math.max(24, Math.min(120, Math.trunc(width)));
  const pulse = Math.abs(Math.sin(Number(phase) * Math.PI * 2)) > 0.55 ? "⬢◆✦" : "✦◆⬢";
  const label = edge === "bottom" ? "INPUT FIELD STABILIZED" : "NEON EDITOR FIELD";
  const railWidth = Math.max(8, cells - label.length - pulse.length - 10);
  const rail = edge === "bottom" ? "▄".repeat(railWidth) : "▀".repeat(railWidth);
  const left = edge === "bottom" ? "╚═" : "╔═";
  const right = edge === "bottom" ? "═╝" : "═╗";
  return [bg("customMessageBg", `${fg("borderAccent", left)}${fg("accent", rail)} ${fg("customMessageLabel", label)} ${fg("thinkingXhigh", pulse)}${fg("borderAccent", right)}`)];
}

export function buildPiGraphicsEditorFrameComponent(theme, options = {}) {
  let tick = Number(options.phase || 0);
  return {
    render(width = 120) {
      tick = (tick + 0.1) % 1;
      return boundedLines(buildPiGraphicsEditorFrameLines(theme, { ...options, width, phase: tick }), width);
    },
    invalidate() { tick = (tick + 0.2) % 1; },
  };
}

export function buildPiGraphicsFloodlightLines(theme, { width = 96, phase = 0 } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const cells = Math.max(40, Math.min(160, Math.trunc(width)));
  const p = Math.abs(Math.sin(Number(phase) * Math.PI * 2));
  const bright = p > 0.5;
  const title = bright ? "⬢ PI KITTY GRAPHICS FLOODLIGHT ⬢" : "◆ PI KITTY GRAPHICS FLOODLIGHT ◆";
  const rail = (bright ? "█▓▒" : "▒▓█").repeat(Math.ceil(cells / 3)).slice(0, cells);
  const subtitle = "DEEP NORDIC GLOW // TYPESCRIPT TUI MIRROR // PULSING HIGH-TECH MODE";
  const meter = (bright ? "⬢◆✦" : "✦◆⬢").repeat(Math.ceil(cells / 3)).slice(0, Math.min(cells, 72));
  return [
    bg("selectedBg", fg("thinkingXhigh", rail)),
    bg("customMessageBg", `${fg("borderAccent", "▌")} ${fg("customMessageLabel", title)} ${fg("borderAccent", "▐")}`),
    bg("customMessageBg", `${fg("accent", "▌")} ${fg("text", subtitle)} ${fg("accent", "▐")}`),
    bg("toolPendingBg", `${fg("muted", "▌")} ${fg("thinkingXhigh", meter)} ${fg("muted", "▐")}`),
    bg("selectedBg", fg("borderAccent", rail.split("").reverse().join(""))),
  ];
}

export function buildPiGraphicsFloodlightComponent(theme, options = {}) {
  let tick = Number(options.phase || 0);
  return {
    render(width = 120) {
      tick = (tick + 0.08) % 1;
      return boundedLines(buildPiGraphicsFloodlightLines(theme, { ...options, width, phase: tick }), width);
    },
    invalidate() { tick = (tick + 0.24) % 1; },
  };
}

export function buildEditorAuraWidget(state, {
  columns = 54,
  rows = 4,
  frames = 8,
  delayMs = 70,
  tone = "tool",
  caption = "editor aura active",
} = {}) {
  const pulse = renderTuiComponentPulseApng({ columns, rows, frames, delayMs, tone });
  const placement = buildPlacement(state, {
    name: `editor-aura-${pulse.tone}-${pulse.columns}x${pulse.rows}-${pulse.frames}f`,
    png: pulse.png,
    columns: pulse.columns,
    rows: pulse.rows,
    width: Math.min(120, Math.max(pulse.columns, String(caption || "").length + 18)),
    caption: ` ⬢ ${caption}`,
  });
  return {
    lines: [
      "╭─ PI KITTY GFX EDITOR AURA ─╮",
      ...renderToText(placement).split("\n"),
      "╰─ actual APNG pixels below the input field ─╯",
    ],
    placement,
    details: {
      columns: pulse.columns,
      rows: pulse.rows,
      frames: pulse.frames,
      delayMs: pulse.delayMs,
      tone: pulse.tone,
      caption,
      metrics: pulse.metrics,
    },
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
