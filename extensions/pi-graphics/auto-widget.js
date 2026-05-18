// Auto-visible Pi kitty graphics widget helpers.
//
// These are split from the Pi extension factory so tests can validate the
// graphical startup/status surface without booting Pi. The widget is intentionally
// small and APNG-backed: normal sessions get an unmistakable animated glow cue,
// but the upload stays bounded and is owned by the pi-graphics image registry.

import { renderTerminalScenePixels, renderTuiComponentPulseApng } from "./components.js";
import { buildPlacement, renderToText } from "./runtime.js";

const FALSE_RE = /^(0|false|off|no)$/i;

export const PI_GRAPHICS_RELOAD_SENTINEL = "PI-GFX-RELOAD-SENTINEL/2026-05-18/NEON-LIGHTHOUSE";

function hexRgb(hex) {
  const value = String(hex || "").replace(/^#/, "").slice(0, 6);
  if (value.length !== 6) return [0, 0, 0];
  return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16)];
}

function rgbDelta(a, b) {
  const aa = hexRgb(a);
  const bb = hexRgb(b);
  return Math.abs(aa[0] - bb[0]) + Math.abs(aa[1] - bb[1]) + Math.abs(aa[2] - bb[2]);
}

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

export function shouldAutoShowConversationFrame(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_CONVERSATION_FRAME ?? env.PI_KITTY_GRAPHICS_AUTO_CONVERSATION_FRAME;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoShowAnsiTakeover(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_ANSI_TAKEOVER ?? env.PI_KITTY_GRAPHICS_AUTO_ANSI_TAKEOVER;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoShowAnsiScene(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_ANSI_SCENE ?? env.PI_KITTY_GRAPHICS_AUTO_ANSI_SCENE;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoApplyTerminalPalette(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_TERMINAL_PALETTE ?? env.PI_KITTY_GRAPHICS_AUTO_TERMINAL_PALETTE;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoShowCockpitWall(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_COCKPIT_WALL ?? env.PI_KITTY_GRAPHICS_AUTO_COCKPIT_WALL;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function shouldAutoShowHeartbeat(env = process.env) {
  const value = env.PI_GRAPHICS_AUTO_HEARTBEAT ?? env.PI_KITTY_GRAPHICS_AUTO_HEARTBEAT;
  return value === undefined ? true : !FALSE_RE.test(String(value).trim());
}

export function heartbeatIntervalMs(env = process.env) {
  const raw = env.PI_GRAPHICS_HEARTBEAT_MS ?? env.PI_KITTY_GRAPHICS_HEARTBEAT_MS;
  const ms = Math.trunc(Number(raw ?? 750));
  return Number.isFinite(ms) ? Math.max(250, Math.min(5000, ms)) : 750;
}

const OSC = "\u001b]";
const BEL = "\u0007";

export function buildPiGraphicsOscPaletteSequence({ includeAnsi = true } = {}) {
  const base = [
    `${OSC}10;#e9f8ff${BEL}`,
    `${OSC}11;#02030b${BEL}`,
    `${OSC}12;#00ffd0${BEL}`,
  ];
  const ansi = [
    "#02030b", "#ff2f6d", "#00ff88", "#fff05a", "#00aaff", "#d85cff", "#00ffd0", "#ffffff",
    "#07101f", "#ff4dff", "#72fbd6", "#ffb000", "#39fffd", "#7c4dff", "#00ffd0", "#e9f8ff",
  ].map((color, index) => `${OSC}4;${index};${color}${BEL}`);
  return [...base, ...(includeAnsi ? ansi : [])].join("");
}

export function buildPiGraphicsOscPaletteResetSequence() {
  return [`${OSC}110${BEL}`, `${OSC}111${BEL}`, `${OSC}112${BEL}`].join("");
}

export function buildPiGraphicsOscPaletteLines(theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  return [
    fg("thinkingXhigh", "⬢ PI KITTY GRAPHICS OSC PALETTE TAKEOVER ⬢"),
    fg("borderAccent", "Sets terminal fg/bg/cursor + ANSI slots to deep Nordic cyan/violet when the terminal permits OSC palette changes."),
    fg("muted", PI_GRAPHICS_RELOAD_SENTINEL),
  ];
}

function ansiBg(hex) {
  const [r, g, b] = hexRgb(hex);
  return `\u001b[48;2;${r};${g};${b}m`;
}

function ansiFg(hex) {
  const [r, g, b] = hexRgb(hex);
  return `\u001b[38;2;${r};${g};${b}m`;
}

function ansiBgRgb(r, g, b) {
  return `\u001b[48;2;${r};${g};${b}m`;
}

function ansiFgRgb(r, g, b) {
  return `\u001b[38;2;${r};${g};${b}m`;
}

function samplePixel(pixels, widthPx, heightPx, x, y) {
  const xx = Math.max(0, Math.min(widthPx - 1, Math.trunc(x)));
  const yy = Math.max(0, Math.min(heightPx - 1, Math.trunc(y)));
  const offset = (yy * widthPx + xx) * 4;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

export function buildPiGraphicsAnsiTakeoverText({ width = 88, phase = 0, label = "PI KITTY GRAPHICS TRUECOLOR TAKEOVER" } = {}) {
  const cells = Math.max(48, Math.min(160, Math.trunc(width)));
  const reset = "\u001b[0m";
  const palette = ["#02030b", "#03152a", "#006ec0", "#00ffd0", "#7c4dff", "#ff4dff"];
  const offset = Math.abs(Math.trunc(Number(phase) * 13)) % palette.length;
  const row = (glyph, shift = 0) => Array.from({ length: cells }, (_, i) => {
    const color = palette[(i + shift + offset) % palette.length];
    return `${ansiBg(color)}${ansiFg(i % 3 === 0 ? "#ffffff" : "#00ffd0")}${glyph}`;
  }).join("") + reset;
  const title = ` ${String(label).replace(/\s+/g, " ").trim().slice(0, Math.max(18, cells - 4))} `;
  const paddedTitle = title.padStart(Math.floor((cells + title.length) / 2), "█").padEnd(cells, "█").slice(0, cells);
  return [
    row("█", 0),
    `${ansiBg("#02030b")}${ansiFg("#00ffd0")}${paddedTitle}${reset}`,
    `${ansiBg("#33006b")}${ansiFg("#ff4dff")}${PI_GRAPHICS_RELOAD_SENTINEL.padEnd(cells).slice(0, cells)}${reset}`,
    row("▓", 2),
    row("▒", 4),
  ].join("\n");
}

function ansiLine(text, { fg = "#00ffd0", bg = "#02030b", width = 88, fill = " " } = {}) {
  const cells = Math.max(24, Math.min(180, Math.trunc(width)));
  return `${ansiBg(bg)}${ansiFg(fg)}${String(text).padEnd(cells, fill).slice(0, cells)}\u001b[0m`;
}

export function buildPiGraphicsAnsiSceneText({ columns = 72, rows = 12, phase = 0, label = "PI GFX ANSI SCENE SHADER" } = {}) {
  const cols = Math.max(24, Math.min(120, Math.trunc(columns)));
  const textRows = Math.max(6, Math.min(32, Math.trunc(rows)));
  const scene = renderTerminalScenePixels({ columns: cols, rows: Math.max(8, textRows * 2), phase });
  const reset = "\u001b[0m";
  const lines = [];
  const title = ` ${String(label).replace(/\s+/g, " ").trim().slice(0, Math.max(16, cols - 4))} `;
  lines.push(`${ansiBg("#02030b")}${ansiFg("#00ffd0")}${title.padStart(Math.floor((cols + title.length) / 2), "▓").padEnd(cols, "▓").slice(0, cols)}${reset}`);
  const sampleW = scene.widthPx / cols;
  const sampleH = scene.heightPx / (textRows * 2);
  for (let row = 0; row < textRows; row += 1) {
    let line = "";
    for (let col = 0; col < cols; col += 1) {
      const x = (col + 0.5) * sampleW;
      const upper = samplePixel(scene.pixels, scene.widthPx, scene.heightPx, x, (row * 2 + 0.5) * sampleH);
      const lower = samplePixel(scene.pixels, scene.widthPx, scene.heightPx, x, (row * 2 + 1.5) * sampleH);
      line += `${ansiFgRgb(upper[0], upper[1], upper[2])}${ansiBgRgb(lower[0], lower[1], lower[2])}▀`;
    }
    lines.push(`${line}${reset}`);
  }
  lines.push(`${ansiBg("#33006b")}${ansiFg("#ff4dff")}${PI_GRAPHICS_RELOAD_SENTINEL.padEnd(cols).slice(0, cols)}${reset}`);
  return lines.join("\n");
}

export function buildPiGraphicsCockpitWallText({ width = 88, phase = 0, label = "PI KITTY GRAPHICS COCKPIT WALL" } = {}) {
  const cells = Math.max(64, Math.min(140, Math.trunc(width)));
  const scene = buildPiGraphicsAnsiSceneText({ columns: Math.min(96, cells), rows: 7, phase, label: "RENDERED PIXEL SCENE // ANSI HALF-BLOCK SHADER" });
  const scan = "⬢◆✦✺▰▱◢◣".repeat(Math.ceil(cells / 8)).slice(0, cells);
  const rails = "═".repeat(cells);
  const title = ` ${String(label).replace(/\s+/g, " ").trim().toUpperCase()} // TRUECOLOR TERMINAL TAKEOVER `;
  const centered = title.padStart(Math.floor((cells + title.length) / 2), "═").padEnd(cells, "═").slice(0, cells);
  const panels = [
    ansiLine(centered, { fg: "#ffffff", bg: "#006ec0", width: cells, fill: "═" }),
    ansiLine(scan, { fg: "#00ffd0", bg: "#02030b", width: cells }),
    ansiLine(" STATUS: DEEP NORDIC VOID ACTIVE   GLOW: CYAN/VIOLET   MODE: NOT A NORMAL TERMINAL", { fg: "#00ffd0", bg: "#33006b", width: cells }),
    scene,
    ansiLine(" PULSE BUS: ▰▱▰▱▰▱  RENDER BUS: HALF-BLOCK PIXELS  THEME BUS: OSC PALETTE", { fg: "#ff4dff", bg: "#020b20", width: cells }),
    ansiLine(PI_GRAPHICS_RELOAD_SENTINEL, { fg: "#fff05a", bg: "#03152a", width: cells }),
    ansiLine(rails, { fg: "#7c4dff", bg: "#02030b", width: cells, fill: "═" }),
  ];
  return panels.join("\n");
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

export function buildStartupConversationFrameMessage({ content, role = "assistant", title = "conversation chrome" } = {}) {
  return {
    customType: "pi-graphics-conversation-frame",
    content: String(content || "Normal transcript output is now framed by Pi kitty graphics chrome — deep Nordic rails, cyan/violet glow, and reload sentinel active.").slice(0, 360),
    display: true,
    details: { role, title },
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

export function buildPiGraphicsHeartbeatLine(theme, { tick = 0, stage = "idle" } = {}) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const glyphs = ["⬢", "◆", "✦", "✺", "▰", "▱", "◢", "◣"];
  const index = Math.abs(Math.trunc(Number(tick) || 0)) % glyphs.length;
  const head = glyphs[index];
  const trail = Array.from({ length: 8 }, (_unused, i) => glyphs[(index + i) % glyphs.length]).join("");
  const safeStage = String(stage || "idle").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 18);
  return `${fg("thinkingXhigh", head)} ${fg("customMessageLabel", "PI GFX HEARTBEAT")} ${fg("borderAccent", trail)} ${fg("muted", `// ${safeStage} // ${PI_GRAPHICS_RELOAD_SENTINEL}`)}`;
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

function wrapWords(text, width) {
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) {
      lines.push(line);
      line = word.slice(0, width);
    } else {
      line = next.slice(0, width);
    }
    if (lines.length >= 3) break;
  }
  if (line && lines.length < 3) lines.push(line);
  return lines.length ? lines : ["Pi kitty graphics conversation frame active."];
}

export function buildPiGraphicsConversationFrameLines({ content = "Pi kitty graphics conversation frame active.", role = "assistant", title = "conversation chrome", expanded = false, width = 104 } = {}, theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const cells = Math.max(52, Math.min(180, Math.trunc(width)));
  const inner = Math.max(28, cells - 16);
  const safeRole = String(role || "assistant").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 18);
  const safeTitle = String(title || "conversation chrome").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 32);
  const aurora = "▰▱⬢◆✦✺".repeat(Math.ceil(inner / 6)).slice(0, inner);
  const pulse = "▓▒░".repeat(Math.ceil(inner / 3)).slice(0, inner);
  const body = wrapWords(content, inner - 4).map((line) => bg("customMessageBg", `${fg("borderAccent", "┃")} ${fg("text", line.padEnd(inner - 2, " "))} ${fg("thinkingXhigh", "┃")}`));
  const lines = [
    bg("selectedBg", `${fg("thinkingXhigh", "╔═⬢")} ${fg("customMessageLabel", `PI GFX ${safeRole} // ${safeTitle}`)} ${fg("borderAccent", "⬢═╗")}`),
    bg("customMessageBg", `${fg("borderAccent", "┃")} ${fg("accent", aurora)} ${fg("thinkingXhigh", "┃")}`),
    ...body,
    bg("toolPendingBg", `${fg("borderAccent", "┃")} ${fg("thinkingXhigh", pulse)} ${fg("muted", "deep nordic conversation renderer")} ${fg("borderAccent", "┃")}`),
    bg("selectedBg", `${fg("borderAccent", "╚═")}${fg("muted", PI_GRAPHICS_RELOAD_SENTINEL)}${fg("thinkingXhigh", "═╝")}`),
  ];
  if (expanded) {
    lines.push(bg("customMessageBg", `${fg("accent", "expanded: ordinary transcript messages now have a graphical TypeScript frame renderer")}`));
  }
  return lines;
}

export function buildPiGraphicsConversationFrameComponent(message, options = {}, theme) {
  const details = message?.details && typeof message.details === "object" ? message.details : {};
  return {
    render(width = 120) {
      return boundedLines(buildPiGraphicsConversationFrameLines({
        content: message?.content,
        role: details.role || details.tone || "assistant",
        title: details.title || message?.customType || "conversation chrome",
        expanded: Boolean(options.expanded),
        width,
      }, theme), width);
    },
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
    bg("toolPendingBg", `${fg("muted", "▔".repeat(12))} ${fg("borderAccent", "never-a-normal-terminal mode")} ${fg("thinkingXhigh", PI_GRAPHICS_RELOAD_SENTINEL)}`),
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

export function buildPiGraphicsReloadSentinelLines(theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  return [
    bg("toolPendingBg", `${fg("thinkingXhigh", "⬢")} ${fg("customMessageLabel", "PI GFX RELOAD SENTINEL")} ${fg("borderAccent", PI_GRAPHICS_RELOAD_SENTINEL)}`),
    bg("customMessageBg", `${fg("accent", "If you do not see this exact sentinel, this Pi session is running an older agent-utils package.")}`),
  ];
}

export function buildPiGraphicsThemeDeltaLines(theme) {
  const fg = typeof theme?.fg === "function" ? theme.fg.bind(theme) : (_token, text) => text;
  const bg = typeof theme?.bg === "function" ? theme.bg.bind(theme) : (_token, text) => text;
  const pairs = [
    ["selectedBg", "#006ec0", "#3a3a4a"],
    ["customMessageBg", "#33006b", "#2d2838"],
    ["toolPendingBg", "#020b20", "#282832"],
    ["borderAccent", "#00ffd0", "#00d7ff"],
    ["thinkingXhigh", "#ff4dff", "#d183e8"],
  ];
  return [
    bg("selectedBg", `${fg("thinkingXhigh", "⬢ PI KITTY THEME DELTA REPORT ⬢")} ${fg("muted", PI_GRAPHICS_RELOAD_SENTINEL)}`),
    ...pairs.map(([token, kitty, dark]) => bg("customMessageBg", `${fg("customMessageLabel", token)} ${fg("borderAccent", kitty)} vs dark ${dark} ${fg("thinkingXhigh", `ΔRGB=${rgbDelta(kitty, dark)}`)}`)),
    bg("toolPendingBg", `${fg("accent", "Expected: large cyan/violet/void deltas; if UI looks dark-default, reload package or select /settings → kitty-graphics.")}`),
  ];
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
