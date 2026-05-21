// Resolve theme color tokens to RGB tuples by parsing the ANSI emitted by
// `Theme.getFgAnsi(token)`. Falls back to a sane default if the theme uses
// 256-color or 16-color mode (we only decode truecolor reliably).

const TRUECOLOR_RE = /\x1b\[38;2;(\d+);(\d+);(\d+)m/;
const PALETTE_256_RE = /\x1b\[38;5;(\d+)m/;
const ANSI_16_RE = /\x1b\[(\d+)m/;

// Standard xterm 256 palette approximation; we only need the 16 ANSI base
// colors here. Anything outside that maps to a midline neutral.
const ANSI_16_RGB = {
  30: [0, 0, 0],
  31: [205, 0, 0],
  32: [0, 205, 0],
  33: [205, 205, 0],
  34: [0, 0, 238],
  35: [205, 0, 205],
  36: [0, 205, 205],
  37: [229, 229, 229],
  90: [127, 127, 127],
  91: [255, 0, 0],
  92: [0, 255, 0],
  93: [255, 255, 0],
  94: [92, 92, 255],
  95: [255, 0, 255],
  96: [0, 255, 255],
  97: [255, 255, 255],
};

export function parseAnsiTruecolorRgb(ansi) {
  if (!ansi || typeof ansi !== "string") return null;
  const m = TRUECOLOR_RE.exec(ansi);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const m256 = PALETTE_256_RE.exec(ansi);
  if (m256) return ansi256ToRgb(Number(m256[1]));
  const m16 = ANSI_16_RE.exec(ansi);
  if (m16 && ANSI_16_RGB[m16[1]]) return ANSI_16_RGB[m16[1]];
  return null;
}

function ansi256ToRgb(index) {
  if (index < 16) return ANSI_16_RGB[index >= 8 ? 90 + (index - 8) : 30 + index] ?? [127, 127, 127];
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return [gray, gray, gray];
  }
  const c = index - 16;
  const r = Math.floor(c / 36);
  const g = Math.floor((c % 36) / 6);
  const b = c % 6;
  const cube = (v) => (v === 0 ? 0 : 55 + v * 40);
  return [cube(r), cube(g), cube(b)];
}

export function rgbToHex([r, g, b]) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function getThemeColorRgb(theme, token, fallbackHex = "#88c0d0") {
  if (theme && typeof theme.getFgAnsi === "function") {
    try {
      const ansi = theme.getFgAnsi(token);
      const rgb = parseAnsiTruecolorRgb(ansi);
      if (rgb) return rgb;
    } catch {}
  }
  const fb = String(fallbackHex || "#88c0d0").replace(/^#/, "");
  if (fb.length === 3) {
    const r = parseInt(fb[0] + fb[0], 16);
    const g = parseInt(fb[1] + fb[1], 16);
    const b = parseInt(fb[2] + fb[2], 16);
    return [r, g, b];
  }
  if (fb.length === 6) {
    return [parseInt(fb.slice(0, 2), 16), parseInt(fb.slice(2, 4), 16), parseInt(fb.slice(4, 6), 16)];
  }
  return [136, 192, 208];
}

export function getThemeColorHex(theme, token, fallbackHex = "#88c0d0") {
  return rgbToHex(getThemeColorRgb(theme, token, fallbackHex));
}
