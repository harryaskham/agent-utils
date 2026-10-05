// Glyph atlas for the Pi pixel canvas: locates monospace TrueType faces,
// derives the virtual cell grid from real font metrics at any pixel size, and
// caches anti-aliased glyph coverage masks (with bold/italic synthesis and
// per-codepoint fallback fonts found through fontconfig).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { TrueTypeFont, flattenContours } from "./ttf.js";
import { blurMask, rasterizePolylines } from "./raster.js";

const STYLE_QUERIES = {
  regular: ["monospace:style=Regular", "monospace"],
  bold: ["monospace:style=Bold", "monospace:weight=bold"],
  italic: ["monospace:style=Italic", "monospace:slant=italic"],
  boldItalic: ["monospace:style=Bold Italic", "monospace:weight=bold:slant=italic"],
};

function fcMatch(pattern, field = "file") {
  try {
    const result = spawnSync("fc-match", ["-f", `%{${field}}`, pattern], { encoding: "utf8", timeout: 1500 });
    return result.status === 0 ? String(result.stdout || "").trim() : "";
  } catch {
    return "";
  }
}

const fontFileCache = new Map();
export function loadFontFile(path) {
  if (!path) return null;
  if (fontFileCache.has(path)) return fontFileCache.get(path);
  let font = null;
  try {
    if (existsSync(path) && /\.(ttf|ttc|otf)$/i.test(path)) font = new TrueTypeFont(readFileSync(path));
  } catch {
    font = null;
  }
  fontFileCache.set(path, font);
  return font;
}

/** Resolve the four style faces. Missing styles fall back to synthesis. */
export function resolveFontFaces({ family = "", regular, bold, italic, boldItalic } = {}) {
  const explicit = { regular, bold, italic, boldItalic };
  const faces = {};
  for (const [style, queries] of Object.entries(STYLE_QUERIES)) {
    let path = explicit[style];
    if (!path) {
      for (const query of queries) {
        const pattern = family ? query.replace(/^monospace/, family) : query;
        const candidate = fcMatch(pattern);
        if (candidate && loadFontFile(candidate)) { path = candidate; break; }
      }
    }
    const font = loadFontFile(path);
    faces[style] = font ? { path, font } : null;
  }
  if (!faces.regular) {
    // Known locations as a last resort (fontconfig missing).
    for (const candidate of ["/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/usr/share/fonts/TTF/DejaVuSansMono.ttf", "/System/Library/Fonts/Menlo.ttc"]) {
      const font = loadFontFile(candidate);
      if (font) { faces.regular = { path: candidate, font }; break; }
    }
  }
  if (!faces.regular) throw new Error("no TrueType monospace font found (set piGraphics.full.font)");
  // A style resolving to the same file as regular means fontconfig substituted
  // it: synthesize instead of reusing the upright face.
  for (const style of ["bold", "italic", "boldItalic"]) {
    if (faces[style] && faces[style].path === faces.regular.path) faces[style] = null;
  }
  return faces;
}

// Coverage → alpha transfer. Linear coverage makes light-on-dark text look
// thin and grainy at small sizes; a gamma < 1 on coverage (stem darkening)
// matches what native terminal text rendering looks like.
function gammaTable(gamma) {
  const g = Math.max(0.3, Math.min(3, Number(gamma) || 1));
  const table = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) table[i] = Math.round(255 * (i / 255) ** (1 / g));
  return table;
}

export class GlyphAtlas {
  /**
   * grid: optional { cellWidth, cellHeight, baseline } shared with another
   * atlas so several fonts (per UI role) can sit on one monospace grid; the
   * face is then scaled so its advance fills the shared cell width.
   */
  constructor({ faces, fontSizePx = 14, lineHeight = 1.25, synthesize = true, grid = null, gamma = 1.35, supersample = 1, cellHeight = 0 } = {}) {
    this.faces = faces;
    this.fontSizePx = Math.max(6, Number(fontSizePx) || 14);
    this.lineHeight = Math.max(0.8, Math.min(2.5, Number(lineHeight) || 1.25));
    this.synthesize = synthesize;
    this.supersample = Math.max(1, Math.min(4, Math.trunc(Number(supersample) || 1)));
    this.gamma = gammaTable(gamma);
    const font = faces.regular.font;
    const advanceUnits = font.advanceWidth(font.glyphIndex(0x4d)) || font.unitsPerEm * 0.6;
    if (grid) {
      this.cellWidth = grid.cellWidth;
      this.cellHeight = grid.cellHeight;
      this.baseline = grid.baseline;
      const byWidth = this.cellWidth / advanceUnits;
      const byHeight = (this.cellHeight * 0.96) / Math.max(1, font.ascender - font.descender);
      this.scale = Math.min(byWidth, byHeight);
      this.fontSizePx = this.scale * font.unitsPerEm;
    } else {
      this.scale = this.fontSizePx / font.unitsPerEm;
      this.cellWidth = Math.max(4, Math.round(advanceUnits * this.scale));
      const natural = (font.ascender - font.descender) * this.scale;
      // cellHeight forces the line pitch (HiDPI mode snaps it to the real
      // terminal rows); the glyphs stay at fontSizePx, centred in the row.
      this.cellHeight = cellHeight > 0 ? Math.round(cellHeight) : Math.max(8, Math.round((natural + Math.max(0, font.lineGap) * this.scale) * this.lineHeight));
      this.baseline = Math.round(font.ascender * this.scale + (this.cellHeight - natural) / 2);
    }
    this.masks = new Map();
    this.fallbackFaces = new Map();
    this.fallbackLookups = 0;
  }

  get grid() {
    return { cellWidth: this.cellWidth, cellHeight: this.cellHeight, baseline: this.baseline };
  }

  faceFor(style) {
    return this.faces[style] || (style === "boldItalic" ? (this.faces.bold || this.faces.italic) : null) || this.faces.regular;
  }

  fallbackFor(codepoint) {
    if (this.fallbackFaces.has(codepoint)) return this.fallbackFaces.get(codepoint);
    let face = null;
    if (this.fallbackLookups < 512) {
      this.fallbackLookups += 1;
      const path = fcMatch(`:charset=${codepoint.toString(16)}`);
      const font = loadFontFile(path);
      if (font && font.hasGlyph(codepoint)) face = { path, font };
    }
    this.fallbackFaces.set(codepoint, face);
    return face;
  }

  /**
   * Coverage mask for one grapheme's base codepoint, positioned relative to
   * the top-left of its cell. `cells` is 1 or 2 (wide glyphs are centred).
   */
  mask(codepoint, { bold = false, italic = false, cells = 1 } = {}) {
    const style = bold && italic ? "boldItalic" : bold ? "bold" : italic ? "italic" : "regular";
    const key = `${style}:${codepoint}:${cells}`;
    const hit = this.masks.get(key);
    if (hit !== undefined) return hit;
    let face = this.faceFor(style);
    let glyph = face.font.glyphIndex(codepoint);
    let fallback = false;
    if (!glyph && face !== this.faces.regular) { face = this.faces.regular; glyph = face.font.glyphIndex(codepoint); }
    if (!glyph) {
      const alt = this.fallbackFor(codepoint);
      if (alt) { face = alt; glyph = alt.font.glyphIndex(codepoint); fallback = true; }
    }
    const result = glyph ? this.rasterGlyph(face, glyph, { style, cells, fallback }) : this.tofu(cells);
    this.masks.set(key, result);
    if (this.masks.size > 8192) this.masks.delete(this.masks.keys().next().value);
    return result;
  }

  /** Blurred (shadow/glow) mask for a glyph mask, cached per mask + radius. */
  blurred(mask, radius) {
    if (!mask) return null;
    if (!this.blurCache) this.blurCache = new WeakMap();
    let byRadius = this.blurCache.get(mask);
    if (!byRadius) this.blurCache.set(mask, (byRadius = new Map()));
    let hit = byRadius.get(radius);
    if (!hit) { hit = blurMask(mask, radius); byRadius.set(radius, hit); }
    return hit;
  }

  rasterGlyph(face, glyph, { style, cells, fallback }) {
    const font = face.font;
    const S = this.supersample;
    let scale = (face === this.faces.regular || this.faces[style] === face ? this.scale : this.fontSizePx / font.unitsPerEm) * S;
    const boxWidth = this.cellWidth * cells * S;
    const cellHeightS = this.cellHeight * S;
    const baselineS = this.baseline * S;
    const advance = font.advanceWidth(glyph) * scale;
    // Fallback / wide glyphs: fit into the cell box while keeping proportions.
    if (fallback || advance > boxWidth * 1.05) {
      const fit = Math.min(1, boxWidth / Math.max(1, advance), (cellHeightS * 0.92) / Math.max(1, (font.ascender - font.descender) * scale));
      scale *= fit;
    }
    const scaledAdvance = font.advanceWidth(glyph) * scale;
    const originX = Math.round((boxWidth - scaledAdvance) / 2 * 100) / 100;
    const ascent = fallback ? Math.min(baselineS, font.ascender * scale + (cellHeightS - (font.ascender - font.descender) * scale) / 2) : baselineS;
    const synthItalic = (style === "italic" || style === "boldItalic") && !this.faces[style] && this.synthesize;
    const shear = synthItalic ? 0.2 : 0;
    const contours = font.glyphContours(glyph);
    if (!contours.length) return null;
    const polylines = flattenContours(contours, (x, y) => {
      const py = ascent - y * scale;
      return [originX + x * scale + shear * (baselineS - py), py];
    });
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const poly of polylines) {
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i]); maxX = Math.max(maxX, poly[i]);
        minY = Math.min(minY, poly[i + 1]); maxY = Math.max(maxY, poly[i + 1]);
      }
    }
    if (!Number.isFinite(minX)) return null;
    const left = Math.floor(minX) - 1; const top = Math.floor(minY) - 1;
    const local = polylines.map((poly) => poly.map((v, i) => (i % 2 === 0 ? v - left : v - top)));
    const mask = rasterizePolylines(local, Math.ceil(maxX) - left + 2, Math.ceil(maxY) - top + 2);
    const synthBold = (style === "bold" || style === "boldItalic") && !this.faces[style] && !this.faces.bold && this.synthesize;
    if (synthBold) emboldenMask(mask, Math.max(1, Math.round((this.fontSizePx * S) / 18)));
    const table = this.gamma;
    for (let i = 0; i < mask.alpha.length; i += 1) mask.alpha[i] = table[mask.alpha[i]];
    return { ...mask, left, top };
  }

  tofu(cells) {
    const w = this.cellWidth * cells * this.supersample; const h = this.cellHeight * this.supersample;
    const alpha = new Uint8Array(w * h);
    const inset = Math.max(1, Math.round(w * 0.15));
    for (let y = Math.round(h * 0.22); y < Math.round(h * 0.82); y += 1) {
      for (let x = inset; x < w - inset; x += 1) {
        const edge = y === Math.round(h * 0.22) || y === Math.round(h * 0.82) - 1 || x === inset || x === w - inset - 1;
        if (edge) alpha[y * w + x] = 150;
      }
    }
    return { alpha, width: w, height: h, left: 0, top: 0 };
  }
}

function emboldenMask(mask, radius) {
  const { alpha, width, height } = mask;
  const src = alpha.slice();
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let best = src[y * width + x];
      for (let d = 1; d <= radius && x - d >= 0; d += 1) best = Math.max(best, src[y * width + x - d]);
      alpha[y * width + x] = best;
    }
  }
}

// ------------------------------------------------------------------ fonts
// Role → font family chains. Every family is placed on the default font's
// grid, so mixing faces never breaks monospace alignment. Families that are
// not installed fall back along the chain, then to the default face.
export const DEFAULT_ROLE_FONTS = Object.freeze({
  default: ["FiraCode Nerd Font Mono", "FiraCode Nerd Font", "JetBrainsMono Nerd Font Mono", "Fira Code", "monospace"],
  thinking: ["JetBrainsMono Nerd Font Mono", "JetBrains Mono", "Victor Mono", "Monaspace Radon", "Liberation Mono:style=Italic", "DejaVu Sans Mono:style=Oblique"],
  heading: [],
  code: [],
  user: [],
  tool: [],
  terminal: [], // Bash panes; falls back to `tool`
  editor: [],
  footer: [],
});

const ROLE_FALLBACK = Object.freeze({ terminal: "tool" });

function familyCandidates(value, fallback) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value === "string" && value.trim()) return value.split(/\s*,\s*/).filter(Boolean);
  return fallback;
}

/** Resolve one family chain to faces, or null when nothing in the chain exists. */
export function resolveFamilyChain(chain) {
  for (const family of chain) {
    if (/\.(ttf|ttc)$/i.test(family)) {
      const font = loadFontFile(family);
      if (font) return { family, faces: { regular: { path: family, font }, bold: null, italic: null, boldItalic: null } };
      continue;
    }
    const [name, styleHint] = family.split(":style=");
    const path = fcMatch(`${name}${styleHint ? `:style=${styleHint}` : ""}`);
    const resolvedFamily = fcMatch(`${name}${styleHint ? `:style=${styleHint}` : ""}`, "family").split(",")[0];
    // fontconfig substitutes silently; accept only when the family matches.
    if (!path || (name !== "monospace" && resolvedFamily.toLowerCase().replace(/\s+/g, "") !== name.toLowerCase().replace(/\s+/g, ""))) continue;
    if (!loadFontFile(path)) continue;
    try {
      const faces = styleHint ? { regular: { path, font: loadFontFile(path) }, bold: null, italic: null, boldItalic: null } : resolveFontFaces({ family: name });
      return { family: resolvedFamily || name, faces };
    } catch { continue; }
  }
  return null;
}

/** A default atlas plus per-role atlases sharing its grid. */
export class FontSet {
  constructor({ fonts = {}, fontSizePx, lineHeight, gamma, supersample, cellHeight = 0 } = {}) {
    const defaultChain = familyCandidates(fonts.default, DEFAULT_ROLE_FONTS.default);
    const base = resolveFamilyChain(defaultChain) || { family: "monospace", faces: resolveFontFaces({}) };
    this.base = new GlyphAtlas({ faces: base.faces, fontSizePx, lineHeight, gamma, supersample, cellHeight });
    this.resolved = { default: { family: base.family, path: base.faces.regular.path } };
    this.roles = new Map();
    for (const role of Object.keys(DEFAULT_ROLE_FONTS)) {
      if (role === "default") continue;
      const chain = familyCandidates(fonts[role], DEFAULT_ROLE_FONTS[role]);
      if (!chain.length) continue;
      const found = resolveFamilyChain(chain);
      if (!found || found.faces.regular.path === base.faces.regular.path) {
        this.resolved[role] = { family: found ? found.family : `${base.family} (fallback)`, path: base.faces.regular.path, missing: !found ? chain[0] : undefined };
        continue;
      }
      this.roles.set(role, new GlyphAtlas({ faces: found.faces, lineHeight, gamma, supersample, grid: this.base.grid }));
      this.resolved[role] = { family: found.family, path: found.faces.regular.path };
    }
  }

  get cellWidth() { return this.base.cellWidth; }
  get cellHeight() { return this.base.cellHeight; }
  get baseline() { return this.base.baseline; }
  get supersample() { return this.base.supersample; }

  forRole(role) {
    if (!role) return this.base;
    return this.roles.get(role) || (ROLE_FALLBACK[role] && this.roles.get(ROLE_FALLBACK[role])) || this.base;
  }
}

/** Monospace TrueType families available through fontconfig (for settings UIs). */
export function listMonospaceFamilies() {
  try {
    const result = spawnSync("fc-list", [":spacing=mono:fontformat=TrueType", "family"], { encoding: "utf8", timeout: 2000 });
    const families = new Set();
    for (const line of String(result.stdout || "").split("\n")) {
      const family = line.split(",")[0].trim();
      if (family) families.add(family);
    }
    return [...families].sort();
  } catch {
    return [];
  }
}
