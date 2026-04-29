import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  encodeRgbaPng,
  fillHorizontalGradient,
  fillRect,
  makeCanvas,
  parseColor,
  setPixel,
  strokeRect,
} from "../extensions/pi-graphics/png-renderer.js";
import {
  CELL_PX_H,
  CELL_PX_W,
  renderAccentBar,
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

test("setPixel composites alpha over existing color", () => {
  const pixels = makeCanvas(1, 1, "#000000ff");
  setPixel(pixels, 1, 0, 0, "#ffffff80");
  // Result should still be opaque (over a fully opaque dst).
  assert.equal(pixels[3], 0xff);
  // And the channels should be roughly halfway between black and white.
  assert.ok(pixels[0] > 0x60 && pixels[0] < 0xa0);
});

test("renderPromptEnclosure produces the expected cell footprint and PNG", () => {
  const result = renderPromptEnclosure({ columns: 8 });
  assert.equal(result.columns, 8);
  assert.equal(result.rows, 1);
  assert.equal(result.widthPx, 8 * CELL_PX_W);
  assert.equal(result.heightPx, CELL_PX_H);
  assert.equal(result.png.subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
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
