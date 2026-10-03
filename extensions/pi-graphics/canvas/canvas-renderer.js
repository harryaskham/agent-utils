// Row renderer for the Pi pixel canvas.
//
// Each virtual screen row is drawn into its own transparent RGBA strip. A
// strip depends only on the row's content plus a small neighbour signature
// (which background runs continue above/below, for rounded panel corners) —
// not on its y position — so scrolling reuses cached strips and only rows that
// genuinely changed are re-rasterized and re-uploaded.

import { DEFAULT, unpackRgb } from "./ansi-cells.js";
import { blendMask, circlePath, fillPaths, fillRectRgba, roundedRectPathCorners, strokeArcPath } from "./raster.js";

// [left, right, up, down]: 1 light, 2 heavy, 3 double.
const BOX = new Map(Object.entries({
  2500: [1, 1, 0, 0], 2501: [2, 2, 0, 0], 2502: [0, 0, 1, 1], 2503: [0, 0, 2, 2],
  "250c": [0, 1, 0, 1], "250d": [0, 2, 0, 1], "250e": [0, 1, 0, 2], "250f": [0, 2, 0, 2],
  2510: [1, 0, 0, 1], 2511: [2, 0, 0, 1], 2512: [1, 0, 0, 2], 2513: [2, 0, 0, 2],
  2514: [0, 1, 1, 0], 2515: [0, 2, 1, 0], 2516: [0, 1, 2, 0], 2517: [0, 2, 2, 0],
  2518: [1, 0, 1, 0], 2519: [2, 0, 1, 0], "251a": [1, 0, 2, 0], "251b": [2, 0, 2, 0],
  "251c": [0, 1, 1, 1], "251d": [0, 2, 1, 1], 2520: [0, 1, 2, 2], 2523: [0, 2, 2, 2],
  2524: [1, 0, 1, 1], 2525: [2, 0, 1, 1], 2528: [1, 0, 2, 2], "252b": [2, 0, 2, 2],
  "252c": [1, 1, 0, 1], "252f": [2, 2, 0, 1], 2530: [1, 1, 0, 2], 2533: [2, 2, 0, 2],
  2534: [1, 1, 1, 0], 2537: [2, 2, 1, 0], 2538: [1, 1, 2, 0], "253b": [2, 2, 2, 0],
  "253c": [1, 1, 1, 1], "253f": [2, 2, 1, 1], 2542: [1, 1, 2, 2], "254b": [2, 2, 2, 2],
  2550: [3, 3, 0, 0], 2551: [0, 0, 3, 3], 2552: [0, 3, 0, 1], 2553: [0, 1, 0, 3],
  2554: [0, 3, 0, 3], 2555: [3, 0, 0, 1], 2556: [1, 0, 0, 3], 2557: [3, 0, 0, 3],
  2558: [0, 3, 1, 0], 2559: [0, 1, 3, 0], "255a": [0, 3, 3, 0], "255b": [3, 0, 1, 0],
  "255c": [1, 0, 3, 0], "255d": [3, 0, 3, 0], "255e": [0, 3, 1, 1], "255f": [0, 1, 3, 3],
  2560: [0, 3, 3, 3], 2561: [3, 0, 1, 1], 2562: [1, 0, 3, 3], 2563: [3, 0, 3, 3],
  2564: [3, 3, 0, 1], 2565: [1, 1, 0, 3], 2566: [3, 3, 0, 3], 2567: [3, 3, 1, 0],
  2568: [1, 1, 3, 0], 2569: [3, 3, 3, 0], "256a": [3, 3, 1, 1], "256b": [1, 1, 3, 3], "256c": [3, 3, 3, 3],
  2574: [1, 0, 0, 0], 2575: [0, 0, 1, 0], 2576: [0, 1, 0, 0], 2577: [0, 0, 0, 1],
  2578: [2, 0, 0, 0], 2579: [0, 0, 2, 0], "257a": [0, 2, 0, 0], "257b": [0, 0, 0, 2],
  "257c": [1, 2, 0, 0], "257d": [0, 0, 1, 2], "257e": [2, 1, 0, 0], "257f": [0, 0, 2, 1],
}).map(([hex, arms]) => [Number.parseInt(hex, 16), arms]));
const ROUND = new Map([[0x256d, "tl"], [0x256e, "tr"], [0x256f, "br"], [0x2570, "bl"]]);
const DASH_H = new Map([[0x2504, [3, 1]], [0x2505, [3, 2]], [0x2508, [4, 1]], [0x2509, [4, 2]], [0x254c, [2, 1]], [0x254d, [2, 2]]]);
const DASH_V = new Map([[0x2506, [3, 1]], [0x2507, [3, 2]], [0x250a, [4, 1]], [0x250b, [4, 2]], [0x254e, [2, 1]], [0x254f, [2, 2]]]);

export function isVectorGlyph(cp) {
  return (cp >= 0x2500 && cp <= 0x259f) || (cp >= 0x2800 && cp <= 0x28ff);
}

function mixRgb(a, b, t) {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}

/**
 * Render one row.
 * ctx: { atlas, cols, theme: { fg, bg, accent, selection, link }, cursorCol (or -1),
 *        panels: [{ start, end, fill:[r,g,b], alpha, border:[r,g,b], borderAlpha, top, bottom,
 *                   absorbBg: Set<packed bg> (cell backgrounds the panel replaces),
 *                   chrome: "terminal" (title band + window dots on the top row),
 *                   stripe: [r,g,b] (left accent bar), title: string }],
 *        bgAbove, bgBelow (Int32Array of per-column bg or DEFAULT) }
 * Returns { rgba, width, height, empty }.
 */
// Pick the font atlas for a cell: region roles (editor/footer) first, then
// semantic provenance (thinking/user/tool), then markdown styling heuristics.
export function cellRole(cell, ctx) {
  if (ctx.regionRole) return ctx.regionRole;
  const sem = cell.sem?.role;
  if (sem === "thinking") return "thinking";
  const t = ctx.theme;
  if (t?.headingPacked !== undefined && cell.bold && cell.fg === t.headingPacked) return "heading";
  if (t?.codePacked !== undefined && (cell.fg === t.codePacked || cell.fg === t.codeBlockPacked)) return "code";
  if (sem === "user") return "user";
  if (sem === "tool" || sem === "bash") return cell.sem?.kind === "bash" || sem === "bash" ? "terminal" : "tool";
  return null;
}

export function renderRow(cells, ctx) {
  const { cols, theme } = ctx;
  const fonts = ctx.fonts || null;
  const baseAtlas = fonts ? fonts.base : ctx.atlas;
  const atlasFor = (cell) => (fonts ? fonts.forRole(cellRole(cell, ctx)) : baseAtlas);
  // S: supersample factor. Everything is drawn in device pixels = logical * S;
  // atlases already produce S-scaled masks.
  const S = Math.max(1, Math.trunc(ctx.scale || baseAtlas.supersample || 1));
  const cw = baseAtlas.cellWidth * S; const ch = baseAtlas.cellHeight * S;
  const baselineS = baseAtlas.baseline * S;
  // marginX: extra transparent pixels either side so panels can breathe
  // outside the text grid; all cell x positions are offset by it.
  const mx = Math.max(0, Math.round((ctx.marginX || 0) * S));
  const width = cols * cw + mx * 2; const height = ch;
  const hidden = ctx.hiddenCols || null;
  const fb = Buffer.alloc(width * height * 4);
  let drawn = false;
  const radius = Math.max(2, Math.round(Math.min(cw, ch) * 0.55));

  // 1. Panels (editor card, footer bar) supplied by the canvas controller.
  for (const panel of ctx.panels || []) {
    const inset = Math.min(mx, Math.round(cw * 0.8));
    const x = mx + panel.start * cw - inset; const w = (panel.end - panel.start) * cw + inset * 2;
    const line = Math.max(1, Math.round(S));
    const radii = [panel.top ? radius * 1.4 : 0, panel.top ? radius * 1.4 : 0, panel.bottom ? radius * 1.4 : 0, panel.bottom ? radius * 1.4 : 0];
    // flush panels (overlays) cover their whole first/last rows: their first
    // line carries content, not padding.
    const y0 = panel.top && !panel.flush ? Math.round(ch * 0.45) : 0;
    const y1 = panel.bottom && !panel.flush ? Math.round(ch * 0.55) : ch;
    fillPaths(fb, width, height, [roundedRectPathCorners(x + 0.5, y0, w - 1, y1 - y0, radii)], ...panel.fill, Math.round(255 * panel.alpha));
    if (panel.chrome === "terminal" && panel.top) {
      // Title band with window dots: reads as a terminal pane, not a box.
      const band = panel.titleFill || mixRgb(panel.fill, [255, 255, 255], 0.06);
      fillPaths(fb, width, height, [roundedRectPathCorners(x + 0.5, y0, w - 1, ch - y0, [radii[0], radii[1], 0, 0])], ...band, 235);
      fillRectRgba(fb, width, height, x + line, ch - line, w - line * 2, line, ...mixRgb(band, [0, 0, 0], 0.35), 200);
      const dotR = Math.max(2, ch * 0.13);
      const dotY = y0 + (ch - y0) / 2;
      const dots = panel.dots || [[191, 97, 106], [235, 203, 139], [163, 190, 140]];
      dots.forEach((rgb, i) => {
        fillPaths(fb, width, height, [circlePath(x + w - inset - cw * 0.9 - i * dotR * 3, dotY, dotR)], ...rgb, 230);
      });
    }
    if (panel.stripe) {
      const sy0 = panel.top ? y0 + radii[0] * 0.6 : 0; const sy1 = panel.bottom ? y1 - radii[3] * 0.6 : ch;
      fillRectRgba(fb, width, height, x + line, sy0, Math.max(2, Math.round(2 * S)), sy1 - sy0, ...panel.stripe, 210);
    }
    if (panel.border) {
      const ba = Math.round(255 * (panel.borderAlpha ?? 0.6));
      const edge = (x0, y, len) => fillRectRgba(fb, width, height, x0, y, len, line, ...panel.border, ba);
      if (panel.top) edge(x + radii[0], y0, w - radii[0] - radii[1]);
      if (panel.bottom) edge(x + radii[3], y1 - line, w - radii[2] - radii[3]);
      const sideTop = panel.top ? y0 + radii[0] : 0; const sideBottom = panel.bottom ? y1 - radii[3] : ch;
      fillRectRgba(fb, width, height, x, sideTop, line, sideBottom - sideTop, ...panel.border, ba);
      fillRectRgba(fb, width, height, x + w - line, sideTop, line, sideBottom - sideTop, ...panel.border, ba);
      if (panel.top) {
        fillPaths(fb, width, height, [strokeArcPath(x + radii[0] + 0.5, y0 + radii[0] + 0.5, radii[0], Math.PI, Math.PI * 1.5, line)], ...panel.border, ba);
        fillPaths(fb, width, height, [strokeArcPath(x + w - radii[1] - 0.5, y0 + radii[1] + 0.5, radii[1], Math.PI * 1.5, Math.PI * 2, line)], ...panel.border, ba);
      }
      if (panel.bottom) {
        fillPaths(fb, width, height, [strokeArcPath(x + w - radii[2] - 0.5, y1 - radii[2] - 0.5, radii[2], 0, Math.PI / 2, line)], ...panel.border, ba);
        fillPaths(fb, width, height, [strokeArcPath(x + radii[3] + 0.5, y1 - radii[3] - 0.5, radii[3], Math.PI / 2, Math.PI, line)], ...panel.border, ba);
      }
    }
    drawn = true;
  }

  // 2. Background runs → rounded panels (corners where the run ends
  //    vertically), then 2b. selection/inverse highlight above them.
  const isSelected = (cell, c) => cell.inverse && c !== ctx.cursorCol;
  // Panels that absorb a cell background (tool/terminal boxes) replace those
  // per-cell runs with their own rounded fill.
  const absorbed = new Map();
  for (const panel of ctx.panels || []) if (panel.absorbBg?.size) for (let k = panel.start; k < panel.end && k < cols; k += 1) absorbed.set(k, panel.absorbBg);
  const bgOf = (cell, col) => (absorbed.get(col)?.has(cell.bg) ? DEFAULT : cell.bg);
  let c = 0;
  while (c < cols) {
    const cell = cells[c];
    const bg = bgOf(cell, c);
    if (bg === DEFAULT) { c += 1; continue; }
    let end = c + 1;
    while (end < cols && bgOf(cells[end], end) === bg) end += 1;
    const above = ctx.bgAboveRaw || ctx.bgAbove; const below = ctx.bgBelowRaw || ctx.bgBelow;
    const same = (arr, col) => arr && arr[col] === bg;
    const tl = !same(above, c); const tr = !same(above, end - 1);
    const bl = !same(below, c); const br = !same(below, end - 1);
    fillPaths(fb, width, height, [roundedRectPathCorners(mx + c * cw, 0, (end - c) * cw, ch, [tl ? radius : 0, tr ? radius : 0, br ? radius : 0, bl ? radius : 0])], ...unpackRgb(bg), 255);
    drawn = true;
    c = end;
  }
  c = 0;
  while (c < cols) {
    if (!isSelected(cells[c], c)) { c += 1; continue; }
    let end = c + 1;
    while (end < cols && isSelected(cells[end], end)) end += 1;
    const above = ctx.bgAbove; const below = ctx.bgBelow;
    const sel = (arr, col) => arr && arr[col] === -2;
    const r = radius * 0.7;
    fillPaths(fb, width, height, [roundedRectPathCorners(mx + c * cw, 0, (end - c) * cw, ch, [sel(above, c) ? 0 : r, sel(above, end - 1) ? 0 : r, sel(below, end - 1) ? 0 : r, sel(below, c) ? 0 : r])], ...theme.selection, 150);
    drawn = true;
    c = end;
  }

  // 3. Glyphs.
  for (let col = 0; col < cols; col += 1) {
    const cell = cells[col];
    if (cell.cont || cell.hidden || (hidden && hidden.has(col))) continue;
    const atlas = atlasFor(cell);
    const cp = cell.cp;
    const selected = cell.inverse && col !== ctx.cursorCol;
    let fg = cell.fg === DEFAULT ? theme.fg : unpackRgb(cell.fg);
    if (cell.inverse && !selected) fg = cell.fg === DEFAULT ? theme.fg : fg; // editor cursor cell: caret overlay draws the cursor
    let alpha = 255;
    if (cell.dim) alpha = 150;
    const x = mx + col * cw;
    if (cp === 32 || cp === 0) {
      // spaces still carry underline/strike decorations
    } else if (isVectorGlyph(cp)) {
      if (drawVectorGlyph(fb, width, height, cp, x, cw, ch, fg, alpha, cell.bold)) drawn = true;
      else {
        const mask = atlas.mask(cp, { bold: cell.bold, italic: cell.italic, cells: cell.wide ? 2 : 1 });
        if (mask) { blendMask(fb, width, height, mask, x + mask.left, mask.top, ...fg, alpha); drawn = true; }
      }
    } else {
      const mask = atlas.mask(cp, { bold: cell.bold, italic: cell.italic, cells: cell.wide ? 2 : 1 });
      if (mask) { blendMask(fb, width, height, mask, x + mask.left, mask.top, ...fg, alpha); drawn = true; }
    }
    if (cell.underline || cell.link) {
      const ul = cell.ul === DEFAULT ? fg : unpackRgb(cell.ul);
      const y = Math.min(ch - 2, baselineS + Math.max(1, Math.round(ch * 0.08)));
      const w = cell.wide ? cw * 2 : cw;
      const t = Math.max(1, Math.round(ch / 18));
      if (cell.underline === 3) {
        for (let dx = 0; dx < w; dx += 1) {
          const yy = y + Math.round(Math.sin(((x + dx) / cw) * Math.PI * 2) * Math.max(1, ch * 0.06));
          fillRectRgba(fb, width, height, x + dx, yy, 1, t, ...ul, alpha);
        }
      } else if (cell.underline) {
        fillRectRgba(fb, width, height, x, y, w, t, ...ul, alpha);
        if (cell.underline === 2) fillRectRgba(fb, width, height, x, y + t + 1, w, t, ...ul, alpha);
      } else {
        for (let dx = 0; dx < w; dx += 3) fillRectRgba(fb, width, height, x + dx, y, 1, t, ...ul, Math.round(alpha * 0.5));
      }
      drawn = true;
    }
    if (cell.strike) {
      fillRectRgba(fb, width, height, x, Math.round(ch * 0.52), cell.wide ? cw * 2 : cw, Math.max(1, Math.round(ch / 18)), ...fg, alpha);
      drawn = true;
    }
  }
  return { rgba: fb, width, height, empty: !drawn };
}

function drawVectorGlyph(fb, width, height, cp, x, cw, ch, rgb, alpha, bold) {
  const cx = x + cw / 2; const cy = ch / 2;
  const light = Math.max(1, Math.round(Math.min(cw, ch) * 0.09 * (bold ? 1.5 : 1)));
  const heavy = Math.max(light + 1, light * 2);
  const rect = (x0, y0, w, h) => fillRectRgba(fb, width, height, x0, y0, w, h, ...rgb, alpha);
  const hLine = (x0, x1, weight) => {
    if (weight === 3) {
      const gap = light + 1;
      rect(x0, Math.round(cy - gap - light / 2), x1 - x0, light);
      rect(x0, Math.round(cy + gap - light / 2), x1 - x0, light);
    } else {
      const t = weight === 2 ? heavy : light;
      rect(x0, Math.round(cy - t / 2), x1 - x0, t);
    }
  };
  const vLine = (y0, y1, weight) => {
    if (weight === 3) {
      const gap = light + 1;
      rect(Math.round(cx - gap - light / 2), y0, light, y1 - y0);
      rect(Math.round(cx + gap - light / 2), y0, light, y1 - y0);
    } else {
      const t = weight === 2 ? heavy : light;
      rect(Math.round(cx - t / 2), y0, t, y1 - y0);
    }
  };
  const arms = BOX.get(cp);
  if (arms) {
    const [l, r, u, d] = arms;
    const half = (w) => (w === 3 ? light + 1 + light : (w === 2 ? heavy : light)) / 2;
    const vExt = Math.max(half(u), half(d)); const hExt = Math.max(half(l), half(r));
    if (l) hLine(x, Math.round(cx + (u || d ? vExt : 0)), l);
    if (r) hLine(Math.round(cx - (u || d ? vExt : 0)), x + cw, r);
    if (u) vLine(0, Math.round(cy + (l || r ? hExt : 0)), u);
    if (d) vLine(Math.round(cy - (l || r ? hExt : 0)), ch, d);
    return true;
  }
  const round = ROUND.get(cp);
  if (round) {
    const rad = Math.max(2, Math.min(cw, ch) / 2);
    const t = light;
    if (round === "tl") { hLine(Math.round(cx + rad), x + cw, 1); vLine(Math.round(cy + rad), ch, 1); fillPaths(fb, width, height, [strokeArcPath(cx + rad, cy + rad, rad, Math.PI, Math.PI * 1.5, t)], ...rgb, alpha); }
    if (round === "tr") { hLine(x, Math.round(cx - rad), 1); vLine(Math.round(cy + rad), ch, 1); fillPaths(fb, width, height, [strokeArcPath(cx - rad, cy + rad, rad, Math.PI * 1.5, Math.PI * 2, t)], ...rgb, alpha); }
    if (round === "br") { hLine(x, Math.round(cx - rad), 1); vLine(0, Math.round(cy - rad), 1); fillPaths(fb, width, height, [strokeArcPath(cx - rad, cy - rad, rad, 0, Math.PI / 2, t)], ...rgb, alpha); }
    if (round === "bl") { hLine(Math.round(cx + rad), x + cw, 1); vLine(0, Math.round(cy - rad), 1); fillPaths(fb, width, height, [strokeArcPath(cx + rad, cy - rad, rad, Math.PI / 2, Math.PI, t)], ...rgb, alpha); }
    return true;
  }
  const dashH = DASH_H.get(cp);
  if (dashH) {
    const [n, weight] = dashH; const seg = cw / n;
    for (let k = 0; k < n; k += 1) hLine(Math.round(x + k * seg), Math.round(x + k * seg + seg * 0.6), weight);
    return true;
  }
  const dashV = DASH_V.get(cp);
  if (dashV) {
    const [n, weight] = dashV; const seg = ch / n;
    for (let k = 0; k < n; k += 1) vLine(Math.round(k * seg), Math.round(k * seg + seg * 0.6), weight);
    return true;
  }
  if (cp >= 0x2580 && cp <= 0x259f) {
    const q = (fx, fy, fw, fh) => rect(Math.round(x + fx * cw), Math.round(fy * ch), Math.round(fw * cw), Math.round(fh * ch));
    if (cp === 0x2580) q(0, 0, 1, 0.5);
    else if (cp >= 0x2581 && cp <= 0x2588) { const f = (cp - 0x2580) / 8; q(0, 1 - f, 1, f); }
    else if (cp >= 0x2589 && cp <= 0x258f) { const f = (0x2590 - cp) / 8; q(0, 0, f, 1); }
    else if (cp === 0x2590) q(0.5, 0, 0.5, 1);
    else if (cp >= 0x2591 && cp <= 0x2593) fillRectRgba(fb, width, height, x, 0, cw, ch, ...rgb, Math.round(alpha * (cp - 0x2590) * 0.25));
    else if (cp === 0x2594) q(0, 0, 1, 0.125);
    else if (cp === 0x2595) q(0.875, 0, 0.125, 1);
    else {
      const quads = { 0x2596: "l", 0x2597: "r", 0x2598: "u", 0x2599: "ulr", 0x259a: "uR", 0x259b: "uUl", 0x259c: "uUr", 0x259d: "U", 0x259e: "Ul", 0x259f: "Ulr" }[cp] || "";
      // u=upper-left U=upper-right l=lower-left r=lower-right
      if (quads.includes("u")) q(0, 0, 0.5, 0.5);
      if (quads.includes("U")) q(0.5, 0, 0.5, 0.5);
      if (quads.includes("l")) q(0, 0.5, 0.5, 0.5);
      if (quads.includes("r") || quads.includes("R")) q(0.5, 0.5, 0.5, 0.5);
    }
    return true;
  }
  if (cp >= 0x2800 && cp <= 0x28ff) {
    const bits = cp - 0x2800;
    const dots = [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [0, 3], [1, 3]];
    const dot = Math.max(1, Math.round(Math.min(cw / 4, ch / 8)));
    dots.forEach(([dx, dy], k) => {
      if (!(bits & (1 << k))) return;
      const px = x + (dx + 0.5) * (cw / 2) - dot / 2;
      const py = (dy + 0.5) * (ch / 4) - dot / 2;
      rect(Math.round(px), Math.round(py), dot, dot);
    });
    return true;
  }
  return false;
}

export function mixColor(a, b, t) { return mixRgb(a, b, t); }
