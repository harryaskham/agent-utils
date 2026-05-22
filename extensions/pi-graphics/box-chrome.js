// Box chrome wrapper: monkey-patches built-in Pi message components to wrap
// each rendered row with a non-virtual relative kitty placement anchored to a
// virtual Unicode placeholder cell. The placement renders a Nord-tinted
// translucent backing strip per row (top cap, mid rail, bottom cap), themed
// by the active Pi theme.

import {
  bufferToBase64,
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
import { getThemeColorRgb } from "./theme-colors.js";

// Use a shallow negative z-index: under text, but above terminal cell
// backgrounds/non-default SGR bg fills. The previous very-negative value hid
// chrome behind Pi's colored cell backgrounds.
const BOX_Z_INDEX = -1;
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
};

export const BOX_TYPE_EFFECTS = {
  assistant: "aurora",
  tool: "circuit",
  bash: "scanline",
  user: "glass",
  custom: "sparkle",
  skill: "aurora",
  branch: "scanline",
  compaction: "glass",
  footer: "circuit",
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
  if (effect === "scanline") {
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

export function renderBoxStripPng({ kind, columns, cellWidthPx = 8, cellHeightPx = 16, color, effect = "glass" }) {
  const w = Math.max(8, Math.round(columns * cellWidthPx));
  const h = cellHeightPx;
  const pixels = makeCanvas(w, h, [0, 0, 0, 0]);
  if (kind === "top") paintTopStrip(pixels, w, h, color);
  else if (kind === "bot") paintBottomStrip(pixels, w, h, color);
  else paintMidStrip(pixels, w, h, color, cellWidthPx);
  paintEffect(pixels, w, h, color, effect);
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
} = {}) {
  // Cache: stripKey -> imageId already uploaded
  const uploadedStrips = new Set();
  const anchorsUploaded = new Set();
  const relativePlacements = new Set();

  function ensureStripUploaded({ kind, type, width, colorRgb, effect }) {
    const stripKey = `box-strip-${type}-${kind}-${effect}-${width}-${colorRgb.join(",")}-${cellWidthPx}x${cellHeightPx}`;
    const imageId = piGraphicsImageId(stripKey);
    if (uploadedStrips.has(imageId)) return imageId;
    const { png } = renderBoxStripPng({ kind, columns: width, cellWidthPx, cellHeightPx, color: colorRgb, effect });
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
    const relKey = `${stripImageId}.${anchorImageId}.${anchorPlacementId}.${instanceId}.${rowIndex}.${width}`;
    if (relativePlacements.has(relKey)) return;
    const relPlacementId = piGraphicsPlacementId(`box-relative-strip.${relKey}`);
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
    // Replace the first visible cell of the line with the placeholder so the
    // rendered visible width remains unchanged. Preserve leading terminal
    // controls (CSI SGR and OSC 133 shell-integration markers) before the
    // placeholder; otherwise OSC payload bytes like "]133;A" become visible.
    const text = String(lineText || "");
    const leadingEsc = (text.match(/^(?:(?:\x1b\[[0-9;?]*[ -/]*[@-~])|(?:\x1b\][^\x07]*(?:\x07|\x1b\\)))+/) || [""])[0];
    const afterEsc = text.slice(leadingEsc.length);
    const rest = Array.from(afterEsc).slice(1).join("");
    return `${leadingEsc}${sgr}${cell}${ESC}[39;59m${rest}`;
  }

  function applyToRows({ type, instanceId, lines }) {
    if (!Array.isArray(lines) || lines.length === 0) return lines;
    const themeTokens = resolveTheme?.({ type }) || {};
    const colorRgb = themeTokens.colorRgb || [136, 192, 208];
    const width = computeMaxVisibleWidth(lines);
    if (width <= 2) return lines;
    const effect = BOX_TYPE_EFFECTS[type] || "glass";
    const stripIdTop = ensureStripUploaded({ kind: "top", type, width, colorRgb, effect });
    const stripIdMid = ensureStripUploaded({ kind: "mid", type, width, colorRgb, effect });
    const stripIdBot = ensureStripUploaded({ kind: "bot", type, width, colorRgb, effect });
    const wrapped = lines.map((line, i) => {
      const kind = i === 0 ? "top" : i === lines.length - 1 ? "bot" : "mid";
      const stripId = kind === "top" ? stripIdTop : kind === "bot" ? stripIdBot : stripIdMid;
      const { anchorImageId, anchorPlacementId } = ensureAnchor({ instanceId, rowIndex: i });
      ensureRelativeStrip({ stripImageId: stripId, anchorImageId, anchorPlacementId, instanceId, rowIndex: i, width });
      return wrapRowText({ lineText: line, anchorImageId, anchorPlacementId });
    });
    return wrapped;
  }

  return { applyToRows };
}

function computeMaxVisibleWidth(lines) {
  let max = 0;
  for (const line of lines) {
    const stripped = String(line || "").replace(/\x1b\[[0-9;]*m/g, "");
    // simple visible-cell estimate; not perfect for wide chars but good enough
    if (stripped.length > max) max = stripped.length;
  }
  return max;
}

// Idempotent monkey-patcher for built-in Pi message component classes.
export function installBoxChromeMonkeyPatch({ components, runtime, onWrap = () => {}, onCall = () => {} }) {
  let instanceCounter = 0;
  const wrappedClasses = new Set();
  for (const [type, ComponentCls] of Object.entries(components)) {
    if (!ComponentCls || typeof ComponentCls !== "function") continue;
    if (ComponentCls.__piGraphicsBoxChromeWrapped) continue;
    if (typeof ComponentCls.prototype?.render !== "function") continue;
    const original = ComponentCls.prototype.render;
    ComponentCls.prototype.render = function (width) {
      const lines = original.call(this, width);
      if (!Array.isArray(lines)) return lines;
      if (this.__piGraphicsInstanceId === undefined) {
        instanceCounter = (instanceCounter + 1) & 0xffff;
        this.__piGraphicsInstanceId = instanceCounter;
      }
      try {
        onCall(type);
        return runtime.applyToRows({ type, instanceId: this.__piGraphicsInstanceId, lines });
      } catch {
        return lines;
      }
    };
    ComponentCls.__piGraphicsBoxChromeWrapped = true;
    wrappedClasses.add(ComponentCls);
    try { onWrap(type, ComponentCls?.name); } catch {}
  }
  return { wrappedClasses };
}
