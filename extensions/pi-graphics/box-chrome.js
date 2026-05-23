// Box chrome wrapper: monkey-patches built-in Pi message components to wrap
// each rendered row with a non-virtual relative kitty placement anchored to a
// virtual Unicode placeholder cell. The placement renders a Nord-tinted
// translucent backing strip per row (top cap, mid rail, bottom cap), themed
// by the active Pi theme.

import {
  bufferToBase64,
  buildDeleteCommand,
  buildKittyUnicodePlaceholderCell,
  buildRelativePlacementCommand,
  serializeKittyGraphicsChunks,
  serializeKittyGraphicsCommand,
  transparentPixelPngBase64,
} from "../kitty-graphics.js";
import {
  piGraphicsImageId,
  piGraphicsPlacementId,
  piGraphicsPlaceholderPlacementId,
} from "./id-space.js";
import { encodeRgbaPng, makeCanvas } from "./png-renderer.js";
import { buildPlacement } from "./runtime.js";
import { getThemeColorRgb } from "./theme-colors.js";
import { PI_GRAPHICS_Z } from "./z-index.js";

// Keep box chrome inside the Pi graphics reserved z-index band so caco-hosted
// views can clear stale Pi graphics by z-index without touching unrelated
// terminal images. It remains negative so text stays above the chrome.
const BOX_Z_INDEX = PI_GRAPHICS_Z.BOX_CHROME;
const MAX_BOX_CHROME_COLUMNS = 512;
const ESC = "\x1b";

// Type -> primary theme token mapping. Each surface picks one token that drives
// border / pillar color; background fill uses a low-alpha tint of the same.
export const BOX_TYPE_THEME_TOKENS = {
  assistant: "accent",
  tool: "toolTitle",
  bash: "bashMode",
  user: "userMessageText",
  custom: "customMessageLabel",
  skill: "accent",
  branch: "muted",
  compaction: "muted",
  footer: "accent",
  thinking: "thinkingHigh",
  loader: "accent",
  border: "borderAccent",
  input: "accent",
  editor: "accent",
  selector: "accent",
  login: "accent",
  model: "accent",
  oauth: "accent",
  session: "accent",
  settings: "accent",
  image: "accent",
  theme: "borderAccent",
  thinkingSelector: "thinkingHigh",
  tree: "accent",
  userSelector: "userMessageText",
  agent: "accent",
  mascot: "borderAccent",
  customTui: "accent",
  overlay: "borderAccent",
  widget: "accent",
  header: "borderAccent",
};

export const BOX_EFFECT_NAMES = Object.freeze(["glass", "aurora", "scanline", "circuit", "sparkle", "cloud", "prism", "holo", "lattice", "contour", "weave", "glyph", "blueprint", "signal", "halo", "constellation", "orbit", "rune", "fold", "nebula", "waveform"]);

export const BOX_TYPE_EFFECTS = {
  assistant: "contour",
  thinking: "nebula",
  tool: "blueprint",
  bash: "blueprint",
  user: "weave",
  custom: "constellation",
  skill: "rune",
  branch: "signal",
  compaction: "fold",
  footer: "waveform",
  loader: "signal",
  border: "halo",
  input: "prism",
  editor: "halo",
  selector: "glyph",
  login: "weave",
  model: "lattice",
  oauth: "weave",
  session: "holo",
  settings: "lattice",
  image: "glyph",
  theme: "constellation",
  thinkingSelector: "nebula",
  tree: "blueprint",
  userSelector: "weave",
  agent: "orbit",
  mascot: "orbit",
  customTui: "rune",
  overlay: "prism",
  widget: "lattice",
  header: "waveform",
};

function withAlpha([r, g, b], a) {
  return [r, g, b, Math.max(0, Math.min(255, Math.round(a)))];
}

function paintTopStrip(pixels, w, h, color) {
  // Soft translucent fill in lower half + a hard stroke at the bottom edge
  // that meets the row strip below.
  const fillAlpha = 36;
  for (let y = 0; y < h; y += 1) {
    const t = y / Math.max(1, h - 1);
    const a = Math.round(fillAlpha * Math.max(0, t - 0.1));
    if (a <= 0) continue;
    for (let x = 0; x < w; x += 1) {
      const off = (y * w + x) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = a;
    }
  }
  // bottom 2px hard border stroke
  const strokeH = Math.max(1, Math.floor(h * 0.12));
  const strokeY = h - strokeH;
  for (let y = strokeY; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const off = (y * w + x) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = 220;
    }
  }
  // horizontal taper
  taperEdges(pixels, w, h);
}

function paintMidStrip(pixels, w, h, color, cellW) {
  // Translucent fill across the full row, plus pillar strokes at the
  // leftmost and rightmost ~half-cell.
  const fillAlpha = 36;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const off = (y * w + x) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = fillAlpha;
    }
  }
  const pillarW = Math.max(1, Math.floor(cellW * 0.4));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < pillarW; x += 1) {
      const offL = (y * w + x) * 4;
      const offR = (y * w + (w - 1 - x)) * 4;
      const taper = 1 - x / pillarW;
      const a = Math.round(220 * taper + 30);
      for (const off of [offL, offR]) {
        pixels[off] = color[0];
        pixels[off + 1] = color[1];
        pixels[off + 2] = color[2];
        pixels[off + 3] = a;
      }
    }
  }
  taperEdges(pixels, w, h);
}

function paintEffect(pixels, w, h, color, effect = "glass") {
  if (effect === "cloud") {
    for (let x = 0; x < w; x += 1) {
      const a = Math.round(18 + 18 * ((Math.sin(x / 11) + Math.sin(x / 23 + 1.3) + 2) / 4));
      const y = Math.max(0, Math.min(h - 1, Math.round(h * (0.45 + 0.25 * Math.sin(x / 17)))));
      fillRectAlpha(pixels, w, x, y, 1, Math.min(3, h - y), color, a);
    }
    for (let x = 4; x < w; x += 19) {
      const y = 2 + ((x * 5) % Math.max(1, h - 5));
      fillRectAlpha(pixels, w, x, y, Math.min(10, w - x), 2, color, 42);
    }
  } else if (effect === "scanline") {
    for (let y = 1; y < h; y += 4) fillRectAlpha(pixels, w, 0, y, w, 1, color, 34);
  } else if (effect === "circuit") {
    const y = Math.max(1, Math.floor(h * 0.35));
    for (let x = 0; x < w; x += 17) fillRectAlpha(pixels, w, x, y + ((x / 17) % 2 ? 3 : 0), Math.min(9, w - x), 1, color, 72);
    for (let x = 6; x < w; x += 31) fillRectAlpha(pixels, w, x, 2, 1, Math.max(2, h - 4), color, 50);
  } else if (effect === "sparkle") {
    for (let x = 5; x < w; x += 23) {
      const y = 2 + ((x * 7) % Math.max(1, h - 4));
      fillRectAlpha(pixels, w, x, y, Math.min(3, w - x), 1, color, 105);
      if (y + 1 < h) fillRectAlpha(pixels, w, x + 1, y - 1, 1, 3, color, 70);
    }
  } else if (effect === "aurora") {
    for (let x = 0; x < w; x += 1) {
      const wave = (Math.sin(x / 19) + 1) / 2;
      const y = Math.max(0, Math.min(h - 1, Math.round((h - 1) * wave)));
      fillRectAlpha(pixels, w, x, y, 1, Math.min(2, h - y), color, 36);
    }
  } else if (effect === "prism") {
    const secondary = [
      Math.min(255, Math.round(color[0] * 0.45 + 120)),
      Math.min(255, Math.round(color[1] * 0.35 + 80)),
      Math.min(255, Math.round(color[2] * 0.60 + 120)),
    ];
    // Cheap crystalline facets: a handful of deterministic diagonal bands with
    // alternating theme/secondary tint. O(width * small-band-height), not a full
    // pixel shader, so it stays cheap while reading as more dimensional glass.
    for (let x = -h; x < w; x += 14) {
      const band = Math.floor((x + h) / 14);
      const tint = band % 2 ? secondary : color;
      for (let dx = 0; dx < 7; dx += 1) {
        const xx = x + dx;
        const yy = Math.max(0, Math.min(h - 1, Math.floor((dx * 0.7 + band * 3) % Math.max(1, h))));
        fillRectAlpha(pixels, w, xx, yy, 1, Math.min(4, h - yy), tint, 42 - dx * 3);
      }
    }
    fillRectAlpha(pixels, w, 0, Math.max(0, Math.floor(h * 0.18)), w, 1, secondary, 26);
    fillRectAlpha(pixels, w, 0, Math.max(0, Math.floor(h * 0.72)), w, 1, color, 22);
  } else if (effect === "holo") {
    const cyan = [
      Math.min(255, Math.round(color[0] * 0.45 + 105)),
      Math.min(255, Math.round(color[1] * 0.55 + 120)),
      Math.min(255, Math.round(color[2] * 0.35 + 165)),
    ];
    const violet = [
      Math.min(255, Math.round(color[0] * 0.55 + 120)),
      Math.min(255, Math.round(color[1] * 0.35 + 55)),
      Math.min(255, Math.round(color[2] * 0.70 + 105)),
    ];
    // Holographic header/footer laminate: sparse full-width scan glints plus
    // thin vertical diffraction slivers. It gives a richer UI-chrome read while
    // staying rectangle-only and deterministic, so cached strip PNGs remain tiny.
    for (let y = 1; y < h; y += 5) {
      fillRectAlpha(pixels, w, 0, y, w, 1, y % 10 ? cyan : violet, 18 + (y % 3) * 4);
    }
    for (let x = 3; x < w; x += 16) {
      const band = Math.floor(x / 16);
      const tint = band % 2 ? violet : cyan;
      const y0 = band % 3;
      fillRectAlpha(pixels, w, x, y0, 1, Math.max(2, h - y0 * 2), tint, 38);
      if (x + 4 < w) fillRectAlpha(pixels, w, x + 4, Math.max(0, h - 3 - y0), Math.min(7, w - x - 4), 1, tint, 48);
    }
    for (let x = 10; x < w; x += 37) {
      const y = 2 + ((x * 5) % Math.max(1, h - 5));
      fillRectAlpha(pixels, w, x, y, Math.min(13, w - x), 2, x % 2 ? violet : cyan, 32);
    }
  } else if (effect === "lattice") {
    const node = [
      Math.min(255, Math.round(color[0] * 0.50 + 95)),
      Math.min(255, Math.round(color[1] * 0.75 + 55)),
      Math.min(255, Math.round(color[2] * 0.65 + 80)),
    ];
    // Structural mesh for dialog/control chrome: diagonal struts and small
    // junction nodes imply a rendered UI frame without per-pixel noise. The
    // stride is fixed so work and PNG entropy scale gently with terminal width.
    for (let x = -h; x < w; x += 12) {
      for (let d = 0; d < Math.min(h, 10); d += 1) {
        fillRectAlpha(pixels, w, x + d, d, 1, 1, color, 34);
        fillRectAlpha(pixels, w, x + d, h - 1 - d, 1, 1, node, 30);
      }
    }
    for (let x = 6; x < w; x += 24) {
      const y = 2 + ((x / 6) % Math.max(1, h - 4));
      fillRectAlpha(pixels, w, x, y, 3, 3, node, 58);
      fillRectAlpha(pixels, w, x + 3, y + 1, Math.min(8, w - x - 3), 1, color, 36);
    }
    fillRectAlpha(pixels, w, 0, Math.max(0, Math.floor(h * 0.5)), w, 1, node, 18);
  } else if (effect === "contour") {
    const shadow = [
      Math.min(255, Math.round(color[0] * 0.35 + 70)),
      Math.min(255, Math.round(color[1] * 0.55 + 70)),
      Math.min(255, Math.round(color[2] * 0.85 + 35)),
    ];
    const highlight = [
      Math.min(255, Math.round(color[0] * 0.70 + 90)),
      Math.min(255, Math.round(color[1] * 0.75 + 80)),
      Math.min(255, Math.round(color[2] * 0.45 + 120)),
    ];
    // Topographic message chrome: stepped isolines give assistant/extension
    // boxes a calm rendered-surface feel. Segments are sparse and grid-aligned,
    // so generation stays O(width / stride) and compresses well in PNG strips.
    for (let x = 0; x < w; x += 8) {
      const ridge = Math.max(1, Math.min(h - 2, Math.round(h * (0.52 + 0.28 * Math.sin(x / 24)))));
      fillRectAlpha(pixels, w, x, ridge, Math.min(6, w - x), 1, highlight, 38);
      if (ridge > 2) fillRectAlpha(pixels, w, x + 2, ridge - 3, Math.min(4, w - x - 2), 1, shadow, 26);
      if (ridge + 3 < h) fillRectAlpha(pixels, w, x + 1, ridge + 3, Math.min(5, w - x - 1), 1, color, 24);
    }
    for (let x = 12; x < w; x += 41) {
      const y = 1 + ((x * 3) % Math.max(1, h - 3));
      fillRectAlpha(pixels, w, x, y, Math.min(9, w - x), 2, x % 2 ? highlight : shadow, 30);
    }
  } else if (effect === "weave") {
    const thread = [
      Math.min(255, Math.round(color[0] * 0.55 + 115)),
      Math.min(255, Math.round(color[1] * 0.45 + 90)),
      Math.min(255, Math.round(color[2] * 0.55 + 95)),
    ];
    const under = [
      Math.min(255, Math.round(color[0] * 0.35 + 55)),
      Math.min(255, Math.round(color[1] * 0.55 + 80)),
      Math.min(255, Math.round(color[2] * 0.45 + 70)),
    ];
    // Woven user chrome: alternating short warp/weft strokes suggest a tactile
    // message surface without dense texture. The two coarse passes are cheap,
    // deterministic, and PNG-friendly compared with per-pixel dithering.
    for (let x = 2; x < w; x += 18) {
      const y = 2 + ((x / 2) % Math.max(1, h - 4));
      fillRectAlpha(pixels, w, x, y, Math.min(12, w - x), 1, thread, 42);
      if (y + 3 < h) fillRectAlpha(pixels, w, x + 4, y + 3, Math.min(9, w - x - 4), 1, under, 28);
    }
    for (let x = 9; x < w; x += 18) {
      const y0 = (Math.floor(x / 18) % 2) + 1;
      fillRectAlpha(pixels, w, x, y0, 1, Math.max(3, h - y0 * 2), x % 3 ? under : thread, 34);
    }
    fillRectAlpha(pixels, w, 0, Math.max(0, Math.floor(h * 0.30)), w, 1, thread, 14);
    fillRectAlpha(pixels, w, 0, Math.max(0, Math.floor(h * 0.68)), w, 1, under, 14);
  } else if (effect === "glyph") {
    const accent = [
      Math.min(255, Math.round(color[0] * 0.62 + 95)),
      Math.min(255, Math.round(color[1] * 0.62 + 95)),
      Math.min(255, Math.round(color[2] * 0.38 + 145)),
    ];
    const ghost = [
      Math.min(255, Math.round(color[0] * 0.30 + 75)),
      Math.min(255, Math.round(color[1] * 0.45 + 65)),
      Math.min(255, Math.round(color[2] * 0.70 + 75)),
    ];
    // Selector glyphs: sparse bracket/diamond marks make menus and chooser
    // surfaces feel like graphical controls. The motif is built from tiny rects,
    // so it remains cheap and compressible while reading as deliberate iconwork.
    for (let x = 4; x < w; x += 28) {
      const y = 2 + ((x / 4) % Math.max(1, h - 5));
      fillRectAlpha(pixels, w, x, y, 5, 1, accent, 56);
      fillRectAlpha(pixels, w, x, y, 1, 5, accent, 44);
      fillRectAlpha(pixels, w, x + 6, y + 2, 3, 1, ghost, 38);
      if (y + 4 < h) fillRectAlpha(pixels, w, x + 2, y + 4, 4, 1, ghost, 34);
    }
    for (let x = 18; x < w; x += 42) {
      const y = Math.max(1, Math.min(h - 2, Math.floor(h * 0.5) + ((x / 6) % 3) - 1));
      fillRectAlpha(pixels, w, x, y, 2, 2, accent, 48);
      fillRectAlpha(pixels, w, x + 2, y - 1, 1, 4, ghost, 30);
    }
  } else if (effect === "blueprint") {
    const rule = [
      Math.min(255, Math.round(color[0] * 0.42 + 70)),
      Math.min(255, Math.round(color[1] * 0.70 + 80)),
      Math.min(255, Math.round(color[2] * 0.85 + 70)),
    ];
    const ink = [
      Math.min(255, Math.round(color[0] * 0.25 + 45)),
      Math.min(255, Math.round(color[1] * 0.55 + 60)),
      Math.min(255, Math.round(color[2] * 0.95 + 45)),
    ];
    // Blueprint chrome for tools/bash/tree panes: sparse drafting rules,
    // registration ticks, and little measurement notches imply a technical
    // rendered panel without high-entropy noise or per-pixel grid fills.
    for (let x = 0; x < w; x += 32) fillRectAlpha(pixels, w, x, 1, 1, Math.max(2, h - 2), rule, 26);
    for (let y = 3; y < h; y += 6) fillRectAlpha(pixels, w, 0, y, w, 1, ink, 16);
    for (let x = 7; x < w; x += 23) {
      const y = 2 + ((x * 2) % Math.max(1, h - 4));
      fillRectAlpha(pixels, w, x, y, Math.min(10, w - x), 1, rule, 50);
      fillRectAlpha(pixels, w, x, Math.max(0, y - 2), 1, Math.min(5, h - Math.max(0, y - 2)), ink, 34);
    }
    for (let x = 15; x < w; x += 47) {
      const y = Math.max(1, Math.min(h - 3, Math.floor(h * 0.62) - ((x / 47) % 3)));
      fillRectAlpha(pixels, w, x, y, 5, 1, rule, 44);
      fillRectAlpha(pixels, w, x + 2, y - 2, 1, 5, rule, 36);
    }
  } else if (effect === "signal") {
    const pulse = [
      Math.min(255, Math.round(color[0] * 0.48 + 100)),
      Math.min(255, Math.round(color[1] * 0.80 + 50)),
      Math.min(255, Math.round(color[2] * 0.55 + 90)),
    ];
    const echo = [
      Math.min(255, Math.round(color[0] * 0.30 + 50)),
      Math.min(255, Math.round(color[1] * 0.55 + 70)),
      Math.min(255, Math.round(color[2] * 0.80 + 70)),
    ];
    // Signal chrome for status-like surfaces: beacon pips and echo rails imply
    // live state without animation. Fixed strides keep it deterministic, cheap,
    // and highly compressible while still reading as an active graphical layer.
    const mid = Math.max(1, Math.floor(h * 0.5));
    for (let x = 5; x < w; x += 21) {
      const y = Math.max(1, Math.min(h - 2, mid + ((x / 7) % 3) - 1));
      fillRectAlpha(pixels, w, x, y, 3, 2, pulse, 58);
      fillRectAlpha(pixels, w, x + 4, y, Math.min(6, w - x - 4), 1, echo, 32);
    }
    for (let x = 0; x < w; x += 34) {
      fillRectAlpha(pixels, w, x, Math.max(0, mid - 4), Math.min(13, w - x), 1, echo, 22);
      fillRectAlpha(pixels, w, x + 3, Math.min(h - 1, mid + 4), Math.min(10, w - x - 3), 1, pulse, 24);
    }
    for (let x = 12; x < w; x += 55) {
      const y = Math.max(1, Math.min(h - 3, 2 + ((x * 5) % Math.max(1, h - 5))));
      fillRectAlpha(pixels, w, x, y, 1, 5, pulse, 38);
    }
  } else if (effect === "halo") {
    const inner = [
      Math.min(255, Math.round(color[0] * 0.58 + 105)),
      Math.min(255, Math.round(color[1] * 0.70 + 75)),
      Math.min(255, Math.round(color[2] * 0.80 + 70)),
    ];
    const outer = [
      Math.min(255, Math.round(color[0] * 0.25 + 70)),
      Math.min(255, Math.round(color[1] * 0.55 + 80)),
      Math.min(255, Math.round(color[2] * 0.95 + 60)),
    ];
    // Halo chrome for editor/border surfaces: soft inner/outer guide rails and
    // sparse corner blooms imply focus without repainting a dense glow field.
    // Coarse rectangles keep generation predictable and cached PNGs compact.
    const top = Math.max(1, Math.floor(h * 0.22));
    const bottom = Math.min(h - 2, Math.floor(h * 0.78));
    fillRectAlpha(pixels, w, 0, top, w, 1, inner, 28);
    fillRectAlpha(pixels, w, 0, bottom, w, 1, outer, 22);
    for (let x = 6; x < w; x += 29) {
      const y = x % 2 ? top : bottom;
      fillRectAlpha(pixels, w, x, y, Math.min(11, w - x), 1, x % 3 ? inner : outer, 38);
    }
    for (const x of [2, Math.max(2, w - 15)]) {
      fillRectAlpha(pixels, w, x, Math.max(0, top - 1), Math.min(12, w - x), 2, inner, 46);
      fillRectAlpha(pixels, w, x + 2, Math.min(h - 2, bottom), Math.min(8, w - x - 2), 1, outer, 34);
    }
  } else if (effect === "constellation") {
    const star = [
      Math.min(255, Math.round(color[0] * 0.72 + 90)),
      Math.min(255, Math.round(color[1] * 0.65 + 95)),
      Math.min(255, Math.round(color[2] * 0.70 + 80)),
    ];
    const line = [
      Math.min(255, Math.round(color[0] * 0.32 + 55)),
      Math.min(255, Math.round(color[1] * 0.48 + 65)),
      Math.min(255, Math.round(color[2] * 0.88 + 70)),
    ];
    // Constellation chrome for custom/theme surfaces: sparse nodes connected by
    // short chart lines create a bespoke rendered feel without noisy starfields.
    // Fixed spacing gives O(width / stride) work and small cached strip PNGs.
    for (let x = 6; x < w; x += 31) {
      const y = 2 + ((x * 7) % Math.max(1, h - 5));
      fillRectAlpha(pixels, w, x, y, 2, 2, star, 62);
      if (x + 9 < w) fillRectAlpha(pixels, w, x + 2, y + (y < h / 2 ? 1 : -1), 8, 1, line, 32);
      if (x + 15 < w) fillRectAlpha(pixels, w, x + 11, Math.max(1, Math.min(h - 2, y + ((x / 31) % 2 ? 3 : -3))), 2, 2, star, 42);
    }
    for (let x = 18; x < w; x += 47) {
      const y = Math.max(1, Math.min(h - 2, Math.floor(h * 0.5) + ((x / 47) % 3) - 1));
      fillRectAlpha(pixels, w, x, y, Math.min(12, w - x), 1, line, 22);
    }
  } else if (effect === "orbit") {
    const ring = [
      Math.min(255, Math.round(color[0] * 0.46 + 100)),
      Math.min(255, Math.round(color[1] * 0.62 + 85)),
      Math.min(255, Math.round(color[2] * 0.86 + 65)),
    ];
    const satellite = [
      Math.min(255, Math.round(color[0] * 0.78 + 70)),
      Math.min(255, Math.round(color[1] * 0.50 + 105)),
      Math.min(255, Math.round(color[2] * 0.55 + 105)),
    ];
    // Orbit chrome for agent/mascot surfaces: coarse arc segments and satellite
    // pips imply personality and motion while remaining a static cached strip.
    // No trigonometric per-pixel field: just a few fixed-stride rectangles.
    const mid = Math.max(1, Math.floor(h * 0.5));
    for (let x = 4; x < w; x += 26) {
      const arcTop = Math.max(1, mid - 3 + ((x / 26) % 2));
      const arcBot = Math.min(h - 2, mid + 3 - ((x / 26) % 2));
      fillRectAlpha(pixels, w, x, arcTop, Math.min(12, w - x), 1, ring, 34);
      fillRectAlpha(pixels, w, x + 4, arcBot, Math.min(12, w - x - 4), 1, ring, 28);
      fillRectAlpha(pixels, w, x + 2, mid, 2, 2, satellite, 54);
    }
    for (let x = 16; x < w; x += 53) {
      const y = Math.max(1, Math.min(h - 2, mid + ((x / 53) % 3) - 1));
      fillRectAlpha(pixels, w, x, y, 3, 3, satellite, 48);
      fillRectAlpha(pixels, w, x + 4, y, Math.min(7, w - x - 4), 1, ring, 24);
    }
  } else if (effect === "rune") {
    const stroke = [
      Math.min(255, Math.round(color[0] * 0.64 + 85)),
      Math.min(255, Math.round(color[1] * 0.50 + 110)),
      Math.min(255, Math.round(color[2] * 0.78 + 65)),
    ];
    const ember = [
      Math.min(255, Math.round(color[0] * 0.45 + 115)),
      Math.min(255, Math.round(color[1] * 0.70 + 65)),
      Math.min(255, Math.round(color[2] * 0.40 + 125)),
    ];
    // Rune chrome for skill/custom-TUI surfaces: compact sigils make extension
    // capability panels feel authored rather than generic. The motif is made
    // from coarse rect strokes, avoiding text glyphs and high-entropy textures.
    for (let x = 7; x < w; x += 30) {
      const y = 2 + ((x * 3) % Math.max(1, h - 5));
      fillRectAlpha(pixels, w, x, y, 1, Math.min(7, h - y), stroke, 46);
      fillRectAlpha(pixels, w, x, y, Math.min(7, w - x), 1, stroke, 42);
      if (y + 4 < h) fillRectAlpha(pixels, w, x + 2, y + 4, Math.min(6, w - x - 2), 1, ember, 34);
      if (x + 6 < w) fillRectAlpha(pixels, w, x + 6, Math.max(1, y - 2), 1, Math.min(5, h - Math.max(1, y - 2)), ember, 32);
    }
    for (let x = 20; x < w; x += 45) {
      const y = Math.max(1, Math.min(h - 2, Math.floor(h * 0.5) + ((x / 15) % 3) - 1));
      fillRectAlpha(pixels, w, x, y, Math.min(9, w - x), 1, stroke, 24);
    }
  } else if (effect === "fold") {
    const crease = [
      Math.min(255, Math.round(color[0] * 0.40 + 95)),
      Math.min(255, Math.round(color[1] * 0.55 + 85)),
      Math.min(255, Math.round(color[2] * 0.78 + 55)),
    ];
    const highlight = [
      Math.min(255, Math.round(color[0] * 0.72 + 70)),
      Math.min(255, Math.round(color[1] * 0.72 + 70)),
      Math.min(255, Math.round(color[2] * 0.55 + 110)),
    ];
    // Fold chrome for compaction summaries: accordion creases and tiny page
    // tabs make compressed context look intentionally folded away. It stays
    // sparse and rect-only, so old summaries don't become expensive to render.
    for (let x = 4; x < w; x += 22) {
      const peak = Math.max(1, Math.min(h - 3, 2 + (Math.floor(x / 22) % Math.max(1, h - 4))));
      fillRectAlpha(pixels, w, x, peak, 1, Math.min(8, h - peak), crease, 64);
      fillRectAlpha(pixels, w, x + 1, peak, Math.min(10, w - x - 1), 1, highlight, 46);
      if (peak + 5 < h) fillRectAlpha(pixels, w, x + 4, peak + 5, Math.min(8, w - x - 4), 1, crease, 38);
    }
    for (let x = 14; x < w; x += 44) {
      const y = Math.max(1, Math.min(h - 2, Math.floor(h * 0.68) - (Math.floor(x / 44) % 2)));
      fillRectAlpha(pixels, w, x, y, Math.min(12, w - x), 2, highlight, 38);
    }
  } else if (effect === "nebula") {
    const mist = [
      Math.min(255, Math.round(color[0] * 0.50 + 90)),
      Math.min(255, Math.round(color[1] * 0.38 + 95)),
      Math.min(255, Math.round(color[2] * 0.92 + 40)),
    ];
    const glint = [
      Math.min(255, Math.round(color[0] * 0.76 + 80)),
      Math.min(255, Math.round(color[1] * 0.56 + 105)),
      Math.min(255, Math.round(color[2] * 0.62 + 95)),
    ];
    // Nebula chrome for thinking surfaces: sparse mist lanes and tiny thought
    // glints replace the old generic cloud with a calmer celestial layer. It is
    // static, stride-based, and rectangle-only so thought rows stay cheap.
    const mid = Math.max(1, Math.floor(h * 0.48));
    for (let x = 3; x < w; x += 17) {
      const y = Math.max(1, Math.min(h - 2, mid + (Math.floor(x / 17) % 5) - 2));
      fillRectAlpha(pixels, w, x, y, Math.min(11, w - x), 1, mist, 34);
      if (y + 2 < h) fillRectAlpha(pixels, w, x + 3, y + 2, Math.min(8, w - x - 3), 1, color, 22);
    }
    for (let x = 10; x < w; x += 39) {
      const y = 2 + ((x * 5) % Math.max(1, h - 5));
      fillRectAlpha(pixels, w, x, y, 2, 2, glint, 54);
      if (x + 4 < w) fillRectAlpha(pixels, w, x + 3, Math.max(1, y - 1), 1, 4, mist, 28);
    }
  } else if (effect === "waveform") {
    const crest = [
      Math.min(255, Math.round(color[0] * 0.50 + 105)),
      Math.min(255, Math.round(color[1] * 0.72 + 65)),
      Math.min(255, Math.round(color[2] * 0.60 + 110)),
    ];
    const trough = [
      Math.min(255, Math.round(color[0] * 0.30 + 55)),
      Math.min(255, Math.round(color[1] * 0.52 + 80)),
      Math.min(255, Math.round(color[2] * 0.86 + 70)),
    ];
    // Waveform chrome for persistent header/footer rails: short static signal
    // crests imply a live session status line without APNG or timers. The strip
    // is sparse and fixed-stride, so it remains cheap and PNG-compressible.
    const mid = Math.max(1, Math.floor(h * 0.52));
    for (let x = 2; x < w; x += 10) {
      const phase = Math.floor(x / 10) % 4;
      const y = Math.max(1, Math.min(h - 2, mid + (phase === 0 ? -3 : phase === 1 ? -1 : phase === 2 ? 2 : 0)));
      fillRectAlpha(pixels, w, x, y, Math.min(7, w - x), 1, phase < 2 ? crest : trough, 38);
      if (phase === 0 || phase === 2) fillRectAlpha(pixels, w, x + 2, Math.min(h - 1, y + 1), 1, 3, crest, 28);
    }
    for (let x = 14; x < w; x += 37) {
      fillRectAlpha(pixels, w, x, Math.max(1, mid - 4), Math.min(11, w - x), 1, crest, 24);
      fillRectAlpha(pixels, w, x + 3, Math.min(h - 2, mid + 4), Math.min(9, w - x - 3), 1, trough, 24);
    }
  }
}

function paintTypeIcon(pixels, w, h, color, { type = "assistant", rowIndex = 0, cellWidthPx = 8 } = {}) {
  if (rowIndex < 0 || rowIndex >= 3) return;
  const iconW = Math.max(8, Math.round(cellWidthPx * 6));
  const iconH = h * 3;
  const yBase = -rowIndex * h;
  const cx = Math.floor(iconW * 0.45);
  const cy = Math.floor(iconH * 0.5);
  const typeKey = type === "thinking" ? "cloud" : type;
  const mark = (x, y, a = 30, rw = 1, rh = 1) => fillRectAlpha(pixels, w, 2 + x, yBase + y, rw, rh, color, a);
  if (typeKey === "cloud") {
    for (let y = 0; y < iconH; y += 1) for (let x = 0; x < iconW; x += 1) {
      const d1 = ((x - cx) / 18) ** 2 + ((y - cy) / 8) ** 2;
      const d2 = ((x - cx + 12) / 13) ** 2 + ((y - cy + 3) / 7) ** 2;
      const d3 = ((x - cx - 10) / 14) ** 2 + ((y - cy + 2) / 9) ** 2;
      const density = Math.max(0, 1 - Math.min(d1, d2, d3));
      if (density > 0) mark(x, y, Math.round(18 + density * 42));
    }
  } else if (typeKey === "tool" || typeKey === "circuit") {
    for (let x = 3; x < iconW - 4; x += 8) mark(x, cy, 48, 5, 1);
    for (let y = 5; y < iconH - 4; y += 8) mark(cx, y, 38, 1, 5);
  } else if (typeKey === "bash") {
    mark(5, cy - 5, 55, 10, 2); mark(13, cy - 2, 55, 8, 2); mark(5, cy + 5, 42, 28, 2);
  } else if (typeKey === "user") {
    mark(cx - 4, cy - 9, 45, 8, 8); mark(cx - 12, cy + 1, 34, 24, 9);
  } else if (typeKey === "branch") {
    mark(cx, 5, 40, 2, iconH - 10); mark(cx - 12, cy, 45, 14, 2); mark(cx - 12, cy - 5, 35, 2, 10);
  } else {
    for (let i = 0; i < 6; i += 1) mark(cx - i * 3, cy - i, 24 + i * 4, i * 6 + 3, 1);
    mark(cx - 2, cy - 8, 42, 4, 16);
  }
}

function fillRectAlpha(pixels, w, x, y, rw, rh, color, alpha) {
  for (let yy = Math.max(0, y); yy < Math.min(Math.ceil(y + rh), pixels.length / 4 / w); yy += 1) {
    for (let xx = Math.max(0, x); xx < Math.min(Math.ceil(x + rw), w); xx += 1) {
      const off = (yy * w + xx) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = Math.max(pixels[off + 3], alpha);
    }
  }
}

function paintSideStrip(pixels, w, h, color, side = "left", verticalKind = "mid") {
  const fillAlpha = 28;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const edgeDist = side === "right" ? w - 1 - x : x;
      const fade = Math.max(0, 1 - edgeDist / Math.max(1, w - 1));
      const off = (y * w + x) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = Math.max(pixels[off + 3], Math.round(fillAlpha * fade));
    }
  }
  const strokeW = Math.max(1, Math.floor(w * 0.35));
  const x0 = side === "right" ? w - strokeW : 0;
  fillRectAlpha(pixels, w, x0, 0, strokeW, h, color, 190);
  if (verticalKind === "top") fillRectAlpha(pixels, w, 0, h - Math.max(1, Math.floor(h * 0.18)), w, Math.max(1, Math.floor(h * 0.18)), color, 150);
  if (verticalKind === "bot") fillRectAlpha(pixels, w, 0, 0, w, Math.max(1, Math.floor(h * 0.18)), color, 150);
}

function paintBottomStrip(pixels, w, h, color) {
  // Mirror of top.
  const fillAlpha = 36;
  for (let y = 0; y < h; y += 1) {
    const t = 1 - y / Math.max(1, h - 1);
    const a = Math.round(fillAlpha * Math.max(0, t - 0.1));
    if (a <= 0) continue;
    for (let x = 0; x < w; x += 1) {
      const off = (y * w + x) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = a;
    }
  }
  const strokeH = Math.max(1, Math.floor(h * 0.12));
  for (let y = 0; y < strokeH; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const off = (y * w + x) * 4;
      pixels[off] = color[0];
      pixels[off + 1] = color[1];
      pixels[off + 2] = color[2];
      pixels[off + 3] = 220;
    }
  }
  taperEdges(pixels, w, h);
}

function taperEdges(pixels, w, h) {
  const taperPx = Math.max(4, Math.round(w * 0.04));
  for (let x = 0; x < w; x += 1) {
    const distLeft = x;
    const distRight = w - 1 - x;
    const hDist = Math.min(distLeft, distRight);
    if (hDist >= taperPx) continue;
    const hFactor = (hDist / taperPx) ** 2;
    for (let y = 0; y < h; y += 1) {
      const off = (y * w + x) * 4 + 3;
      pixels[off] = Math.round(pixels[off] * hFactor);
    }
  }
}

export function renderBoxStripPng({ kind, columns, cellWidthPx = 8, cellHeightPx = 16, color, effect = "glass", type = "assistant", rowIndex = 0 }) {
  const w = Math.max(8, Math.round(columns * cellWidthPx));
  const h = cellHeightPx;
  const pixels = makeCanvas(w, h, [0, 0, 0, 0]);
  if (kind === "top") paintTopStrip(pixels, w, h, color);
  else if (kind === "bot") paintBottomStrip(pixels, w, h, color);
  else if (kind === "left" || kind === "top-left" || kind === "bot-left") paintSideStrip(pixels, w, h, color, "left", kind.startsWith("top") ? "top" : kind.startsWith("bot") ? "bot" : "mid");
  else if (kind === "right" || kind === "top-right" || kind === "bot-right") paintSideStrip(pixels, w, h, color, "right", kind.startsWith("top") ? "top" : kind.startsWith("bot") ? "bot" : "mid");
  else paintMidStrip(pixels, w, h, color, cellWidthPx);
  paintEffect(pixels, w, h, color, effect);
  paintTypeIcon(pixels, w, h, color, { type, rowIndex, cellWidthPx });
  taperEdges(pixels, w, h);
  return { png: encodeRgbaPng(pixels, w, h), widthPx: w, heightPx: h };
}

function truecolorSgr(prefix, id) {
  const low24 = id % 0x1000000;
  const r = (low24 >> 16) & 0xff;
  const g = (low24 >> 8) & 0xff;
  const b = low24 & 0xff;
  return `${ESC}[${prefix};2;${r};${g};${b}m`;
}

function placeholderSgr({ imageId, placementId }) {
  return `${truecolorSgr(38, imageId)}${placementId ? truecolorSgr(58, placementId) : ""}`;
}

export function createBoxChromeRuntime({
  emitGraphicsCommand,
  state,
  passthrough = "auto",
  cellWidthPx = 8,
  cellHeightPx = 16,
  resolveTheme,
  boxEffect,
  boxMode = "relative",
} = {}) {
  state.ownedImageIds ||= new Set();
  state.transmittedImageIds ||= new Set();
  state.placementByImage ||= new Map();
  state.config ||= { passthrough };
  state.config.passthrough ||= passthrough;
  // Cache: stripKey -> imageId already uploaded
  const uploadedStrips = new Set();
  const anchorsUploaded = new Set();
  const relativePlacements = new Set();
  const relativeByAnchorRow = new Map();

  function ensureStripUploaded({ kind, type, width, colorRgb, effect, rowIndex }) {
    const stripKey = `box-strip-${type}-${kind}-${effect}-${rowIndex}-${width}-${colorRgb.join(",")}-${cellWidthPx}x${cellHeightPx}`;
    const imageId = piGraphicsImageId(stripKey);
    if (uploadedStrips.has(imageId)) return imageId;
    const { png } = renderBoxStripPng({ kind, columns: width, cellWidthPx, cellHeightPx, color: colorRgb, effect, type, rowIndex });
    const upload = serializeKittyGraphicsChunks({
      a: "t",
      f: 100,
      t: "d",
      i: imageId,
      q: 2,
    }, bufferToBase64(png), { passthrough });
    emitGraphicsCommand(upload);
    state.ownedImageIds.add(imageId);
    uploadedStrips.add(imageId);
    return imageId;
  }

  function ensureAnchor({ instanceId, rowIndex }) {
    const anchorKey = `box-anchor.${instanceId}.${rowIndex}`;
    const anchorImageId = piGraphicsImageId(anchorKey);
    const placementId = piGraphicsPlaceholderPlacementId(`box-anchor-placement.${instanceId}.${rowIndex}`);
    if (anchorsUploaded.has(anchorImageId)) return { anchorImageId, anchorPlacementId: placementId };
    const upload = serializeKittyGraphicsChunks({
      a: "t",
      f: 100,
      t: "d",
      i: anchorImageId,
      q: 2,
    }, transparentPixelPngBase64(), { passthrough });
    const place = serializeKittyGraphicsCommand({
      a: "p",
      i: anchorImageId,
      p: placementId,
      U: 1,
      c: 1,
      r: 1,
      z: BOX_Z_INDEX,
      q: 2,
    }, "", { passthrough });
    emitGraphicsCommand(`${upload}${place}`);
    state.ownedImageIds.add(anchorImageId);
    anchorsUploaded.add(anchorImageId);
    return { anchorImageId, anchorPlacementId: placementId };
  }

  function ensureRelativeStrip({ stripImageId, anchorImageId, anchorPlacementId, instanceId, rowIndex, width }) {
    const anchorRowKey = `${anchorImageId}.${anchorPlacementId}.${instanceId}.${rowIndex}`;
    const relKey = `${stripImageId}.${anchorRowKey}.${width}`;
    if (relativePlacements.has(relKey)) return;
    const relPlacementId = piGraphicsPlacementId(`box-relative-strip.${anchorRowKey}`);
    const previous = relativeByAnchorRow.get(anchorRowKey);
    if (previous && (previous.stripImageId !== stripImageId || previous.relPlacementId !== relPlacementId)) {
      emitGraphicsCommand(buildDeleteCommand({ imageId: previous.stripImageId, placementId: previous.relPlacementId, deleteMode: "p", passthrough }));
    }
    const cmd = buildRelativePlacementCommand({
      imageId: stripImageId,
      placementId: relPlacementId,
      parentImageId: anchorImageId,
      parentPlacementId: anchorPlacementId,
      columns: width,
      rows: 1,
      zIndex: BOX_Z_INDEX,
      passthrough,
    });
    emitGraphicsCommand(cmd);
    relativePlacements.add(relKey);
    relativeByAnchorRow.set(anchorRowKey, { stripImageId, relPlacementId });
  }

  function wrapRowText({ lineText, anchorImageId, anchorPlacementId }) {
    const sgr = placeholderSgr({ imageId: anchorImageId, placementId: anchorPlacementId });
    const cell = buildKittyUnicodePlaceholderCell({
      imageId: anchorImageId,
      placementId: anchorPlacementId,
      row: 0,
      column: 0,
      includeColumn: true,
    });
    // Insert the placeholder after leading terminal controls without corrupting
    // ANSI/OSC sequences. If the line starts with visible text, remove the last
    // visible cell ANSI-safely so the visible width remains stable while the
    // readable prefix is preserved.
    return prefixPlaceholderCell(String(lineText || ""), `${sgr}${cell}${ESC}[39;59m`);
  }

  function componentLooksLikeThinking(component) {
    try {
      return !!component?.lastMessage?.content?.some?.((c) => c?.type === "thinking" && String(c.thinking || "").trim());
    } catch { return false; }
  }

  function applyUnicodeBoxRows({ type, instanceId, lines, colorRgb, width, effect }) {
    const makeCell = (side, rowIndex, kind) => {
      const rendered = renderBoxStripPng({ kind, columns: 1, cellWidthPx, cellHeightPx, color: colorRgb, effect, type, rowIndex });
      const placement = buildPlacement(state, {
        name: `box-unicode-cell-${type}-${side}-${kind}-${effect}-${instanceId}-${rowIndex}`,
        png: rendered.png,
        columns: 1,
        rows: 1,
        width: 1,
        zIndex: BOX_Z_INDEX,
      });
      return `${placement.transmit}${placement.lines[0] || ""}`;
    };
    return lines.map((line, i) => {
      if (hasKittyPlaceholder(line)) return line;
      const verticalKind = lines.length === 1 ? "mid" : i === 0 ? "top" : i === lines.length - 1 ? "bot" : "mid";
      const leftKind = verticalKind === "top" ? "top-left" : verticalKind === "bot" ? "bot-left" : "left";
      const rightKind = verticalKind === "top" ? "top-right" : verticalKind === "bot" ? "bot-right" : "right";
      const left = makeCell("left", i, leftKind);
      const right = makeCell("right", i, rightKind);
      const plainWidth = Math.max(0, width - 2);
      const trimmed = truncateAnsiToVisibleWidth(String(line || ""), plainWidth);
      const pad = " ".repeat(Math.max(0, plainWidth - visibleCellWidth(trimmed)));
      return `${left}${trimmed}${pad}${right}`;
    });
  }

  function applyToRows({ type, instanceId, lines, component, renderWidth }) {
    if (!Array.isArray(lines) || lines.length === 0) return lines;
    const effectiveType = componentLooksLikeThinking(component) ? "thinking" : type;
    const themeTokens = resolveTheme?.({ type: effectiveType }) || {};
    const colorRgb = themeTokens.colorRgb || [136, 192, 208];
    const contentWidth = computeMaxVisibleWidth(lines);
    const requestedWidth = Math.trunc(Number(renderWidth));
    // Some Pi containers pass a render width that includes outer padding/margins;
    // returning that full width plus placeholder side borders can trip pi-tui's
    // hard line-width guard (for example /settings at 186 cols receiving 188).
    // Unicode mode is text-cell replacement, not an independent overlay, so keep
    // two cells of render-width slack while still honoring genuinely wider content.
    const renderWidthHint = Number.isFinite(requestedWidth) && requestedWidth > 0
      ? (boxMode === "unicode" ? Math.max(0, requestedWidth - 2) : requestedWidth)
      : 0;
    const unclampedWidth = Math.max(contentWidth, renderWidthHint);
    const width = Math.min(MAX_BOX_CHROME_COLUMNS, unclampedWidth);
    if (width <= 2) return lines;
    const effect = BOX_EFFECT_NAMES.includes(boxEffect) ? boxEffect : (BOX_TYPE_EFFECTS[effectiveType] || "glass");
    if (boxMode === "unicode") return applyUnicodeBoxRows({ type: effectiveType, instanceId, lines, colorRgb, width, effect });
    const wrapped = lines.map((line, i) => {
      if (hasKittyPlaceholder(line)) return line;
      const kind = lines.length === 1 ? "mid" : i === 0 ? "top" : i === lines.length - 1 ? "bot" : "mid";
      const stripId = ensureStripUploaded({ kind, type: effectiveType, width, colorRgb, effect, rowIndex: i });
      const { anchorImageId, anchorPlacementId } = ensureAnchor({ instanceId, rowIndex: i });
      ensureRelativeStrip({ stripImageId: stripId, anchorImageId, anchorPlacementId, instanceId, rowIndex: i, width });
      return wrapRowText({ lineText: line, anchorImageId, anchorPlacementId });
    });
    return wrapped;
  }

  function resetCaches() {
    uploadedStrips.clear();
    anchorsUploaded.clear();
    relativePlacements.clear();
    relativeByAnchorRow.clear();
  }

  return { applyToRows, resetCaches };
}

function hasKittyPlaceholder(text) {
  return String(text || "").includes("\u{10eeee}");
}

const CONTROL_RE = /(?:\x1b\[[0-9;?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1b[_P][\s\S]*?\x1b\\)/g;

function readControlAt(text, index) {
  CONTROL_RE.lastIndex = index;
  const match = CONTROL_RE.exec(text);
  return match && match.index === index ? match[0] : null;
}

function stripTerminalControls(text) {
  return String(text || "").replace(CONTROL_RE, "");
}

function charCellWidth(ch) {
  if (!ch) return 0;
  const code = ch.codePointAt(0) || 0;
  if (code === 0) return 0;
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if ((code >= 0x300 && code <= 0x36f) || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    code >= 0x1100 && (
      code <= 0x115f || code === 0x2329 || code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1faff)
    )
  ) return 2;
  return 1;
}

function visibleCellWidth(text) {
  const source = String(text || "");
  let width = 0;
  for (let i = 0; i < source.length;) {
    const control = readControlAt(source, i);
    if (control) { i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    width += charCellWidth(ch);
    i += ch.length;
  }
  return width;
}

function splitLeadingControls(text) {
  const source = String(text || "");
  let i = 0;
  while (i < source.length) {
    const control = readControlAt(source, i);
    if (!control) break;
    i += control.length;
  }
  return [source.slice(0, i), source.slice(i)];
}

function removeLastVisibleCell(text) {
  const source = String(text || "");
  const tokens = [];
  for (let i = 0; i < source.length;) {
    const control = readControlAt(source, i);
    if (control) { tokens.push({ text: control, width: 0 }); i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    tokens.push({ text: ch, width: charCellWidth(ch) });
    i += ch.length;
  }
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i].width > 0) { tokens.splice(i, 1); break; }
  }
  return tokens.map((token) => token.text).join("");
}

function prefixPlaceholderCell(text, placeholder) {
  const [leading, rest] = splitLeadingControls(text);
  if (!rest) return `${leading}${placeholder}`;
  const first = String.fromCodePoint(rest.codePointAt(0));
  if (/\s/.test(first)) return `${leading}${placeholder}${rest.slice(first.length)}`;
  return `${leading}${placeholder}${removeLastVisibleCell(rest)}`;
}

function truncateAnsiToVisibleWidth(text, maxWidth) {
  const limit = Math.max(0, Math.trunc(Number(maxWidth) || 0));
  const source = String(text || "");
  let out = "";
  let width = 0;
  let i = 0;
  for (; i < source.length;) {
    const control = readControlAt(source, i);
    if (control) { out += control; i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    const w = charCellWidth(ch);
    if (w > 0 && width + w > limit) break;
    out += ch;
    width += w;
    i += ch.length;
  }
  // Preserve trailing controls (especially SGR resets) after truncating visible
  // cells so styles from clipped content cannot bleed into padding/borders.
  for (; i < source.length;) {
    const control = readControlAt(source, i);
    if (control) { out += control; i += control.length; continue; }
    const ch = String.fromCodePoint(source.codePointAt(i));
    i += ch.length;
  }
  return out;
}

function computeMaxVisibleWidth(lines) {
  let max = 0;
  for (const line of lines) {
    const width = visibleCellWidth(line);
    if (width > max) max = width;
  }
  return max;
}

// Idempotent, reload-safe monkey-patcher for built-in Pi message/component classes.
// Component prototypes are process-global, so the wrapper must not close over a
// stale runtime. Reinstalling updates class-owned runtime metadata, and the
// returned restore function only unpatches classes still owned by this install.
let globalInstanceCounter = 0;

export function installBoxChromeMonkeyPatch({ components, runtime, onWrap = () => {}, onCall = () => {} }) {
  const wrappedClasses = new Set();
  for (const [type, ComponentCls] of Object.entries(components)) {
    if (!ComponentCls || typeof ComponentCls !== "function") continue;
    if (typeof ComponentCls.prototype?.render !== "function") continue;
    if (ComponentCls.__piGraphicsBoxChromeWrapped) {
      ComponentCls.__piGraphicsBoxChromeRuntime = runtime;
      ComponentCls.__piGraphicsBoxChromeType = type;
      ComponentCls.__piGraphicsBoxChromeOnCall = onCall;
      wrappedClasses.add(ComponentCls);
      continue;
    }
    const original = ComponentCls.prototype.render;
    ComponentCls.__piGraphicsBoxChromeOriginalRender = original;
    ComponentCls.__piGraphicsBoxChromeRuntime = runtime;
    ComponentCls.__piGraphicsBoxChromeType = type;
    ComponentCls.__piGraphicsBoxChromeOnCall = onCall;
    ComponentCls.prototype.render = function (width) {
      const lines = original.call(this, width);
      if (!Array.isArray(lines)) return lines;
      if (this.__piGraphicsInstanceId === undefined) {
        globalInstanceCounter = (globalInstanceCounter + 1) & 0xffff;
        this.__piGraphicsInstanceId = globalInstanceCounter;
      }
      const cls = this.constructor || ComponentCls;
      const activeRuntime = cls.__piGraphicsBoxChromeRuntime || ComponentCls.__piGraphicsBoxChromeRuntime;
      const activeType = cls.__piGraphicsBoxChromeType || ComponentCls.__piGraphicsBoxChromeType || type;
      const activeOnCall = cls.__piGraphicsBoxChromeOnCall || ComponentCls.__piGraphicsBoxChromeOnCall || onCall;
      if (!activeRuntime || typeof activeRuntime.applyToRows !== "function") return lines;
      try {
        activeOnCall(activeType);
        return activeRuntime.applyToRows({ type: activeType, instanceId: this.__piGraphicsInstanceId, lines, component: this, renderWidth: width });
      } catch {
        return lines;
      }
    };
    ComponentCls.__piGraphicsBoxChromeWrapped = true;
    wrappedClasses.add(ComponentCls);
    try { onWrap(type, ComponentCls?.name); } catch {}
  }
  const restore = () => {
    for (const ComponentCls of wrappedClasses) {
      if (!ComponentCls?.__piGraphicsBoxChromeWrapped) continue;
      if (ComponentCls.__piGraphicsBoxChromeRuntime !== runtime) continue;
      const original = ComponentCls.__piGraphicsBoxChromeOriginalRender;
      if (typeof original === "function") ComponentCls.prototype.render = original;
      delete ComponentCls.__piGraphicsBoxChromeWrapped;
      delete ComponentCls.__piGraphicsBoxChromeOriginalRender;
      delete ComponentCls.__piGraphicsBoxChromeRuntime;
      delete ComponentCls.__piGraphicsBoxChromeType;
      delete ComponentCls.__piGraphicsBoxChromeOnCall;
    }
  };
  return { wrappedClasses, restore };
}
