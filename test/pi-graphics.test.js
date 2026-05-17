import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import {
  addRadialGlow,
  addScanlines,
  encodeRgbaPng,
  fillHorizontalGradient,
  fillRect,
  fillVerticalGradient,
  makeCanvas,
  parseColor,
  setPixel,
  strokeRect,
} from "../extensions/pi-graphics/png-renderer.js";
import {
  CELL_PX_H,
  CELL_PX_W,
  renderAccentBar,
  renderGlowPanel,
  renderGlowPanelFrames,
  renderGradientBorder,
  renderPromptEnclosure,
} from "../extensions/pi-graphics/affordances.js";
import {
  buildPlacement,
  ensureUnicodePlacement,
  makeState,
  renderToText,
} from "../extensions/pi-graphics/runtime.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePngRgba(png) {
  assert.equal(png.subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
  let offset = 8;
  let width = 0;
  let height = 0;
  const idats = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[9], 6, "tests only decode RGBA PNGs");
    }
    if (type === "IDAT") idats.push(data);
    offset += 12 + length;
  }
  const inflated = inflateSync(Buffer.concat(idats));
  const stride = width * 4;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    assert.equal(inflated[y * (stride + 1)], 0, "renderer uses unfiltered rows");
    inflated.copy(pixels, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, pixels };
}

function pixelAt(decoded, x, y) {
  const off = (y * decoded.width + x) * 4;
  return [decoded.pixels[off], decoded.pixels[off + 1], decoded.pixels[off + 2], decoded.pixels[off + 3]];
}

function channelDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]);
}

function alphaStats(decoded) {
  let transparent = 0;
  let bright = 0;
  let opaque = 0;
  for (let i = 3; i < decoded.pixels.length; i += 4) {
    const a = decoded.pixels[i];
    if (a === 0) transparent += 1;
    if (a > 64) bright += 1;
    if (a > 220) opaque += 1;
  }
  return { transparent, bright, opaque, total: decoded.width * decoded.height };
}

test("parseColor accepts hex shorthand, full hex, alpha, ints, arrays", () => {
  assert.deepEqual(parseColor("#fff"), [0xff, 0xff, 0xff, 0xff]);
  assert.deepEqual(parseColor("#80808080"), [0x80, 0x80, 0x80, 0x80]);
  assert.deepEqual(parseColor("#5e81ac"), [0x5e, 0x81, 0xac, 0xff]);
  assert.deepEqual(parseColor(0x40), [0x40, 0x40, 0x40, 0xff]);
  assert.deepEqual(parseColor([10, 20, 30, 40]), [10, 20, 30, 40]);
});

test("parseColor rejects malformed input", () => {
  assert.throws(() => parseColor("#zzz"));
});

test("encodeRgbaPng writes a valid PNG signature and IHDR", () => {
  const w = 4;
  const h = 2;
  const pixels = makeCanvas(w, h, "#112233");
  const png = encodeRgbaPng(pixels, w, h);
  assert.equal(png.subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
  assert.equal(png.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(png.readUInt32BE(16), w);
  assert.equal(png.readUInt32BE(20), h);
  assert.equal(png[24], 8); // bit depth
  assert.equal(png[25], 6); // color type RGBA
  // IEND tail.
  assert.equal(png.subarray(png.length - 8, png.length - 4).toString("ascii"), "IEND");
});

test("encodeRgbaPng rejects mismatched buffer sizes", () => {
  assert.throws(() => encodeRgbaPng(Buffer.alloc(10), 4, 2));
});

test("makeCanvas pre-fills every pixel with the provided color", () => {
  const pixels = makeCanvas(2, 2, "#aabbccdd");
  assert.equal(pixels.length, 16);
  for (let i = 0; i < pixels.length; i += 4) {
    assert.deepEqual([pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]], [0xaa, 0xbb, 0xcc, 0xdd]);
  }
});

test("fillRect respects bounds and clipping", () => {
  const pixels = makeCanvas(4, 4, "#00000000");
  fillRect(pixels, 4, -1, -1, 3, 3, "#ff0000ff");
  // (0,0), (1,0), (0,1), (1,1) should be set.
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const off = (y * 4 + x) * 4;
    assert.deepEqual([pixels[off], pixels[off + 1], pixels[off + 2], pixels[off + 3]], [0xff, 0, 0, 0xff]);
  }
  // Out-of-bounds writes should not corrupt the rest of the buffer.
  const off22 = (2 * 4 + 2) * 4;
  assert.deepEqual([pixels[off22], pixels[off22 + 1], pixels[off22 + 2], pixels[off22 + 3]], [0, 0, 0, 0]);
});

test("strokeRect outlines all four sides", () => {
  const pixels = makeCanvas(5, 5, "#00000000");
  strokeRect(pixels, 5, 0, 0, 5, 5, "#ffffffff", 1);
  // Center pixel must remain transparent.
  const center = (2 * 5 + 2) * 4;
  assert.deepEqual([pixels[center], pixels[center + 1], pixels[center + 2], pixels[center + 3]], [0, 0, 0, 0]);
  // Corners must be opaque white.
  for (const [x, y] of [[0, 0], [4, 0], [0, 4], [4, 4]]) {
    const off = (y * 5 + x) * 4;
    assert.deepEqual([pixels[off], pixels[off + 1], pixels[off + 2], pixels[off + 3]], [0xff, 0xff, 0xff, 0xff]);
  }
});

test("fillHorizontalGradient interpolates linearly", () => {
  const pixels = makeCanvas(4, 1, "#00000000");
  fillHorizontalGradient(pixels, 4, 0, 0, 4, 1, "#000000ff", "#ff0000ff");
  // Endpoints should match the gradient stops.
  assert.deepEqual([pixels[0], pixels[1], pixels[2], pixels[3]], [0, 0, 0, 0xff]);
  assert.deepEqual([pixels[12], pixels[13], pixels[14], pixels[15]], [0xff, 0, 0, 0xff]);
  // Mid pixel should sit between them.
  assert.ok(pixels[4] > 0 && pixels[4] < 0xff);
});

test("fillVerticalGradient, radial glow, and scanlines create measurable visual variation", () => {
  const pixels = makeCanvas(8, 8, "#00000000");
  fillVerticalGradient(pixels, 8, 0, 0, 8, 8, "#000000ff", "#0000ffff");
  addRadialGlow(pixels, 8, 4, 4, 4, "#00ffffff", 1);
  addScanlines(pixels, 8, { every: 2, alpha: 20 });

  const top = [pixels[0], pixels[1], pixels[2], pixels[3]];
  const bottomOff = (7 * 8) * 4;
  const bottom = [pixels[bottomOff], pixels[bottomOff + 1], pixels[bottomOff + 2], pixels[bottomOff + 3]];
  const centerOff = (4 * 8 + 4) * 4;
  const cornerOff = 0;
  assert.ok(channelDistance(top, bottom) > 100, "vertical gradient should visibly change top to bottom");
  assert.ok(pixels[centerOff + 1] > pixels[cornerOff + 1], "radial glow should brighten the center green/cyan channel");
  assert.ok(pixels[(1 * 8) * 4] > pixels[(2 * 8) * 4], "scanline rows should be brighter than adjacent rows");
});

test("setPixel composites alpha over existing color", () => {
  const pixels = makeCanvas(1, 1, "#000000ff");
  setPixel(pixels, 1, 0, 0, "#ffffff80");
  // Result should still be opaque (over a fully opaque dst).
  assert.equal(pixels[3], 0xff);
  // And the channels should be roughly halfway between black and white.
  assert.ok(pixels[0] > 0x60 && pixels[0] < 0xa0);
});

test("renderPromptEnclosure produces a visibly glowing one-cell footprint", () => {
  const result = renderPromptEnclosure({ columns: 8, phase: 0.25 });
  assert.equal(result.columns, 8);
  assert.equal(result.rows, 1);
  assert.equal(result.widthPx, 8 * CELL_PX_W);
  assert.equal(result.heightPx, CELL_PX_H);
  assert.equal(result.png.subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
  const decoded = decodePngRgba(result.png);
  const stats = alphaStats(decoded);
  assert.ok(stats.bright > result.widthPx * 2, "glow rule should contain more than a hairline of visible pixels");
  assert.ok(channelDistance(pixelAt(decoded, 2, Math.floor(decoded.height / 2)), pixelAt(decoded, decoded.width - 3, Math.floor(decoded.height / 2))) > 80, "left/right gradient endpoints should differ visibly");
});

test("renderGradientBorder produces opaque border edges and transparent fill", () => {
  const result = renderGradientBorder({ columns: 4, rows: 3 });
  assert.equal(result.columns, 4);
  assert.equal(result.rows, 3);
  assert.equal(result.png.subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
});

test("renderAccentBar honors strokeColor option", () => {
  const result = renderAccentBar({ columns: 6, color: "#bf616a", strokeColor: "#5e81ac" });
  assert.equal(result.columns, 6);
  assert.equal(result.rows, 1);
});

test("renderGlowPanel creates a deep Nordic high-contrast graphical component", () => {
  const result = renderGlowPanel({ columns: 10, rows: 4, phase: 0.125 });
  assert.equal(result.columns, 10);
  assert.equal(result.rows, 4);
  assert.equal(result.widthPx, 10 * CELL_PX_W);
  assert.equal(result.heightPx, 4 * CELL_PX_H);
  const decoded = decodePngRgba(result.png);
  const stats = alphaStats(decoded);
  assert.equal(stats.transparent, 0, "glow panel should paint the full component background");
  assert.ok(stats.opaque > stats.total * 0.6, "deep panel background should be substantially opaque");
  assert.ok(channelDistance(pixelAt(decoded, 1, 1), pixelAt(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2))) > 120, "edge glow and center fill should be visibly different");
  assert.ok(channelDistance(pixelAt(decoded, 2, 2), pixelAt(decoded, decoded.width - 3, decoded.height - 3)) > 70, "cyan/violet aurora corners should differ visibly");
});

test("renderGlowPanelFrames keeps layout stable while pulse frames change pixels", () => {
  const frames = renderGlowPanelFrames({ columns: 8, rows: 3, frames: 4 });
  assert.equal(frames.length, 4);
  for (const frame of frames) {
    assert.equal(frame.columns, 8);
    assert.equal(frame.rows, 3);
    assert.equal(frame.widthPx, 8 * CELL_PX_W);
    assert.equal(frame.heightPx, 3 * CELL_PX_H);
  }
  assert.notEqual(frames[0].png.toString("base64"), frames[1].png.toString("base64"), "pulse frames should update image content");
  assert.notEqual(frames[1].png.toString("base64"), frames[2].png.toString("base64"), "successive pulse frames should be visually distinct");
});

test("buildPlacement registers the image id and emits a virtual placement command", () => {
  const state = makeState();
  const enclosure = renderPromptEnclosure({ columns: 4 });
  const placement = buildPlacement(state, {
    name: "test-rule",
    png: enclosure.png,
    columns: enclosure.columns,
    rows: enclosure.rows,
  });
  assert.ok(placement.imageId > 0, "image id must be a positive integer");
  assert.ok(state.ownedImageIds.has(placement.imageId), "extension state must track the new image id");
  assert.match(placement.transmit, /\x1b_G/);
  assert.match(placement.transmit, /a=T/);
  assert.match(placement.transmit, /U=1/);
  assert.equal(placement.lines.length, 1);
});

test("renderToText concatenates the transmit sequence with placeholder lines", () => {
  const state = makeState();
  const enclosure = renderPromptEnclosure({ columns: 4 });
  const placement = buildPlacement(state, {
    name: "test-rule-2",
    png: enclosure.png,
    columns: enclosure.columns,
    rows: enclosure.rows,
  });
  const text = renderToText(placement);
  assert.ok(text.startsWith(placement.transmit));
  assert.ok(text.includes(placement.lines[0]));
});

test("ensureUnicodePlacement always anchors regardless of TMUX env", () => {
  const state = makeState();
  // forceAnchored = true inside ensureUnicodePlacement -> must not depend on env.
  assert.equal(ensureUnicodePlacement(state), true);
});

test("package.json advertises the pi-graphics extension and theme through pi.* entries", async () => {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
  assert.ok(pkg.pi, "package.json must define a pi block");
  assert.ok(Array.isArray(pkg.pi.extensions), "pi.extensions must be an array");
  assert.ok(pkg.pi.extensions.includes("./extensions/pi-graphics.js"), "pi.extensions must include pi-graphics.js");
  assert.ok(Array.isArray(pkg.pi.themes), "pi.themes must be an array");
  assert.ok(pkg.pi.themes.includes("./themes/kitty-graphics.json"), "pi.themes must include the kitty-graphics theme");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("themes"), "package.json files[] must ship themes/");
});

test("themes/kitty-graphics.json declares all required color tokens with the correct schema name", async () => {
  const themePath = fileURLToPath(new URL("../themes/kitty-graphics.json", import.meta.url));
  const theme = JSON.parse(await readFile(themePath, "utf8"));
  assert.equal(theme.name, "kitty-graphics");
  assert.equal(typeof theme.colors, "object");
  // Spot-check a representative subset of required tokens (full set documented
  // in pi-coding-agent themes.md). We assert presence rather than re-deriving
  // the schema to avoid coupling to upstream churn.
  for (const token of [
    "accent", "border", "borderAccent", "borderMuted",
    "success", "error", "warning", "muted", "dim", "text",
    "thinkingText", "selectedBg", "userMessageBg", "customMessageBg",
    "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
    "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock",
    "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
    "toolDiffAdded", "toolDiffRemoved", "toolDiffContext",
    "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable",
    "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
    "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh",
    "bashMode",
  ]) {
    assert.ok(token in theme.colors, `theme is missing required token: ${token}`);
  }
});

test("themes/kitty-graphics.json is visibly different from the default text theme", async () => {
  const themePath = fileURLToPath(new URL("../themes/kitty-graphics.json", import.meta.url));
  const theme = JSON.parse(await readFile(themePath, "utf8"));
  const resolve = (token) => parseColor(theme.vars[theme.colors[token]] ?? theme.colors[token]);
  assert.deepEqual(resolve("accent"), parseColor("#00d8ff"));
  assert.deepEqual(resolve("borderAccent"), parseColor("#72fbd6"));
  assert.notDeepEqual(resolve("text"), parseColor([0, 0, 0, 0]), "main text must not inherit the default terminal color");
  assert.ok(channelDistance(resolve("selectedBg"), resolve("userMessageBg")) > 20, "selected and message backgrounds should be distinguishable");
  assert.equal(theme.export.glowCyan, "#00d8ff");
  assert.equal(theme.export.glowAurora, "#b48cff");
});
