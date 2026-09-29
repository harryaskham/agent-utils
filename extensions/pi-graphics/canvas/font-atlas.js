// Glyph atlas for the Pi pixel canvas: locates monospace TrueType faces,
// derives the virtual cell grid from real font metrics at any pixel size, and
// caches anti-aliased glyph coverage masks (with bold/italic synthesis and
// per-codepoint fallback fonts found through fontconfig).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { TrueTypeFont, flattenContours } from "./ttf.js";
import { rasterizePolylines } from "./raster.js";

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

export class GlyphAtlas {
  constructor({ faces, fontSizePx = 14, lineHeight = 1.25, synthesize = true } = {}) {
    this.faces = faces;
    this.fontSizePx = Math.max(6, Number(fontSizePx) || 14);
    this.lineHeight = Math.max(0.8, Math.min(2.5, Number(lineHeight) || 1.25));
    this.synthesize = synthesize;
    const font = faces.regular.font;
    this.scale = this.fontSizePx / font.unitsPerEm;
    const advance = font.advanceWidth(font.glyphIndex(0x4d)) || font.unitsPerEm * 0.6;
    this.cellWidth = Math.max(4, Math.round(advance * this.scale));
    const natural = (font.ascender - font.descender) * this.scale;
    this.cellHeight = Math.max(8, Math.round((natural + Math.max(0, font.lineGap) * this.scale) * this.lineHeight));
    this.baseline = Math.round(font.ascender * this.scale + (this.cellHeight - natural) / 2);
    this.masks = new Map();
    this.fallbackFaces = new Map();
    this.fallbackLookups = 0;
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

  rasterGlyph(face, glyph, { style, cells, fallback }) {
    const font = face.font;
    let scale = this.fontSizePx / font.unitsPerEm;
    const boxWidth = this.cellWidth * cells;
    const advance = font.advanceWidth(glyph) * scale;
    // Fallback / wide glyphs: fit into the cell box while keeping proportions.
    if (fallback || advance > boxWidth * 1.05) {
      const fit = Math.min(1, boxWidth / Math.max(1, advance), (this.cellHeight * 0.92) / Math.max(1, (font.ascender - font.descender) * scale));
      scale *= fit;
    }
    const scaledAdvance = font.advanceWidth(glyph) * scale;
    const originX = Math.round((boxWidth - scaledAdvance) / 2 * 100) / 100;
    const ascent = fallback ? Math.min(this.baseline, font.ascender * scale + (this.cellHeight - (font.ascender - font.descender) * scale) / 2) : this.baseline;
    const synthItalic = (style === "italic" || style === "boldItalic") && !this.faces[style] && this.synthesize;
    const shear = synthItalic ? 0.2 : 0;
    const contours = font.glyphContours(glyph);
    if (!contours.length) return null;
    const polylines = flattenContours(contours, (x, y) => {
      const py = ascent - y * scale;
      return [originX + x * scale + shear * (this.baseline - py), py];
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
    if (synthBold) emboldenMask(mask, Math.max(1, Math.round(this.fontSizePx / 18)));
    return { ...mask, left, top };
  }

  tofu(cells) {
    const w = this.cellWidth * cells; const h = this.cellHeight;
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
