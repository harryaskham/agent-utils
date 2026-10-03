// Parse Pi's composed ANSI screen lines into styled terminal cells for the
// pixel canvas. Covers what Pi and its components emit: SGR (16/256/truecolor,
// bold/dim/italic/underline incl. styles/inverse/strike, underline colour),
// OSC 8 hyperlinks, OSC 133 marks, APC markers and Kitty image commands.

import { charCellWidth } from "../ansi-width.js";

export const DEFAULT = -1;

const BASE16 = [
  [0x3b, 0x42, 0x52], [0xbf, 0x61, 0x6a], [0xa3, 0xbe, 0x8c], [0xeb, 0xcb, 0x8b],
  [0x81, 0xa1, 0xc1], [0xb4, 0x8e, 0xad], [0x88, 0xc0, 0xd0], [0xe5, 0xe9, 0xf0],
  [0x4c, 0x56, 0x6a], [0xbf, 0x61, 0x6a], [0xa3, 0xbe, 0x8c], [0xeb, 0xcb, 0x8b],
  [0x81, 0xa1, 0xc1], [0xb4, 0x8e, 0xad], [0x8f, 0xbc, 0xbb], [0xec, 0xef, 0xf4],
];

function packRgb(r, g, b) { return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255); }

export function xterm256(index, palette16 = BASE16) {
  const n = Math.max(0, Math.min(255, index | 0));
  if (n < 16) { const [r, g, b] = palette16[n]; return packRgb(r, g, b); }
  if (n >= 232) { const v = 8 + (n - 232) * 10; return packRgb(v, v, v); }
  const c = n - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  return packRgb(steps[Math.floor(c / 36)], steps[Math.floor(c / 6) % 6], steps[c % 6]);
}

const segmenter = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
const PLACEHOLDER = 0x10eeee;

function newStyle() {
  return { fg: DEFAULT, bg: DEFAULT, ul: DEFAULT, bold: false, dim: false, italic: false, underline: 0, inverse: false, strike: false, hidden: false, link: "" };
}

// Semantic provenance (see semantics.js) is positional: it applies to the
// cells after the marker and survives SGR resets.
const SEMANTIC_BODY_RE = /^pi:gfx:@([a-z]+):([0-9.]+):(\d+)(:s)?$/;

function applySgr(style, params, palette16) {
  const list = params === "" ? [0] : params.split(/[;:]/).map((v) => (v === "" ? 0 : Number(v)));
  // Colon sub-parameters (4:3 curly underline, 38:2::r:g:b) are normalised by
  // splitting on both separators and consuming known arities below.
  for (let i = 0; i < list.length; i += 1) {
    const p = list[i];
    if (p === 0) Object.assign(style, newStyle(), { link: style.link });
    else if (p === 1) style.bold = true;
    else if (p === 2) style.dim = true;
    else if (p === 3) style.italic = true;
    else if (p === 4) {
      if (params.includes("4:")) { style.underline = list[i + 1] ?? 1; i += 1; } else style.underline = 1;
    } else if (p === 7) style.inverse = true;
    else if (p === 8) style.hidden = true;
    else if (p === 9) style.strike = true;
    else if (p === 21) style.underline = 2;
    else if (p === 22) { style.bold = false; style.dim = false; }
    else if (p === 23) style.italic = false;
    else if (p === 24) style.underline = 0;
    else if (p === 27) style.inverse = false;
    else if (p === 28) style.hidden = false;
    else if (p === 29) style.strike = false;
    else if (p >= 30 && p <= 37) style.fg = xterm256(p - 30, palette16);
    else if (p >= 90 && p <= 97) style.fg = xterm256(p - 90 + 8, palette16);
    else if (p >= 40 && p <= 47) style.bg = xterm256(p - 40, palette16);
    else if (p >= 100 && p <= 107) style.bg = xterm256(p - 100 + 8, palette16);
    else if (p === 39) style.fg = DEFAULT;
    else if (p === 49) style.bg = DEFAULT;
    else if (p === 59) style.ul = DEFAULT;
    else if (p === 38 || p === 48 || p === 58) {
      const mode = list[i + 1];
      let color = DEFAULT;
      if (mode === 5) { color = xterm256(list[i + 2] ?? 0, palette16); i += 2; }
      else if (mode === 2) {
        // 38;2;r;g;b or 38:2::r:g:b (colour-space id empty)
        let r = list[i + 2]; let g = list[i + 3]; let b = list[i + 4];
        if (params.includes(`${p}:2::`)) { r = list[i + 3]; g = list[i + 4]; b = list[i + 5]; i += 1; }
        color = packRgb(r ?? 0, g ?? 0, b ?? 0);
        i += 4;
      }
      if (p === 38) style.fg = color; else if (p === 48) style.bg = color; else style.ul = color;
    }
  }
}

/**
 * Parse one line into `width` cells. Each cell:
 *   { ch, cp, wide, cont, fg, bg, ul, bold, dim, italic, underline, inverse, strike, hidden, link }
 * `cont` marks the right half of a wide glyph. Returns { cells, image } where
 * image describes a Kitty image placement found on the line (Pi inline images).
 */
export function parseAnsiLine(line, width, { palette16 = BASE16 } = {}) {
  const cells = new Array(width);
  const style = newStyle();
  let col = 0;
  let image = null;
  let semantic = null;
  const semantics = [];
  const text = String(line ?? "");
  const put = (ch, cp, w) => {
    if (col >= width) return;
    const base = { ch, cp, wide: w === 2, cont: false, fg: style.fg, bg: style.bg, ul: style.ul, bold: style.bold, dim: style.dim, italic: style.italic, underline: style.underline, inverse: style.inverse, strike: style.strike, hidden: style.hidden, link: style.link, sem: semantic };
    cells[col] = base;
    if (w === 2 && col + 1 < width) cells[col + 1] = { ...base, ch: "", cp: 0, wide: false, cont: true };
    col += w;
  };
  let i = 0;
  let plainStart = -1;
  const flushPlain = (end) => {
    if (plainStart < 0) return;
    const chunk = text.slice(plainStart, end);
    plainStart = -1;
    const graphemes = segmenter ? Array.from(segmenter.segment(chunk), (s) => s.segment) : Array.from(chunk);
    for (const g of graphemes) {
      const cp = g.codePointAt(0);
      if (cp === 9) { for (let k = 0; k < 3; k += 1) put(" ", 32, 1); continue; }
      if (cp < 32 || cp === 0x7f) continue;
      if (cp === PLACEHOLDER) { put(" ", 32, 1); continue; }
      let w = charCellWidth(String.fromCodePoint(cp));
      if (g.length > 2 && /\p{Extended_Pictographic}/u.test(g)) w = 2;
      if (w === 0) {
        if (col > 0 && cells[col - 1]) cells[col - 1].ch += g; // combining mark
        continue;
      }
      put(g, cp, w);
    }
  };
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c !== 0x1b) {
      if (plainStart < 0) plainStart = i;
      i += 1;
      continue;
    }
    flushPlain(i);
    const next = text[i + 1];
    if (next === "[") {
      let j = i + 2;
      while (j < text.length && !(text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e)) j += 1;
      const final = text[j];
      const params = text.slice(i + 2, j);
      if (final === "m") applySgr(style, params, palette16);
      i = j + 1;
    } else if (next === "]") {
      let j = i + 2;
      let end = -1; let termLen = 1;
      while (j < text.length) {
        if (text[j] === "\x07") { end = j; termLen = 1; break; }
        if (text[j] === "\x1b" && text[j + 1] === "\\") { end = j; termLen = 2; break; }
        j += 1;
      }
      if (end < 0) break;
      const body = text.slice(i + 2, end);
      if (body.startsWith("8;")) {
        const url = body.slice(body.indexOf(";", 2) + 1);
        style.link = url;
      }
      i = end + termLen;
    } else if (next === "_" || next === "P" || next === "^") {
      let j = i + 2;
      let end = -1; let termLen = 2;
      while (j < text.length) {
        if (next === "_" && text[j] === "\x07") { end = j; termLen = 1; break; }
        if (text[j] === "\x1b" && text[j + 1] === "\\") { end = j; termLen = 2; break; }
        j += 1;
      }
      if (end < 0) break;
      const body = text.slice(i + 2, end);
      const sem = next === "_" && body.startsWith("pi:gfx:@") ? SEMANTIC_BODY_RE.exec(body) : null;
      if (sem) {
        semantic = { role: sem[1], block: sem[2], line: Number(sem[3]), streaming: Boolean(sem[4]), col };
        semantics.push(semantic);
      }
      if (next === "_" && body.startsWith("G") && !image) {
        const semi = body.indexOf(";");
        const controls = Object.fromEntries((semi < 0 ? body.slice(1) : body.slice(1, semi)).split(",").filter(Boolean).map((kv) => kv.split("=")));
        if (controls.a === "T" || controls.a === "p") image = { col, controls, payload: semi < 0 ? "" : body.slice(semi + 1) };
        else if (image && controls.m !== undefined) image.payload += semi < 0 ? "" : body.slice(semi + 1);
      } else if (next === "_" && body.startsWith("G") && image && /(?:^|,)m=/.test(body)) {
        const semi = body.indexOf(";");
        image.payload += semi < 0 ? "" : body.slice(semi + 1);
      }
      i = end + termLen;
    } else {
      i += 2;
    }
  }
  flushPlain(text.length);
  const blankStyle = newStyle();
  for (let k = 0; k < width; k += 1) {
    if (!cells[k]) cells[k] = { ch: " ", cp: 32, wide: false, cont: false, fg: blankStyle.fg, bg: DEFAULT, ul: DEFAULT, bold: false, dim: false, italic: false, underline: 0, inverse: false, strike: false, hidden: false, link: "", sem: semantic };
  }
  return { cells, image, semantics };
}

export function unpackRgb(value) {
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}
