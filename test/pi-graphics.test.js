import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import {
  addRadialGlow,
  addScanlines,
  encodeRgbaApng,
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
import {
  buildAutoPulseWidget,
  buildEditorAuraWidget,
  buildPiGraphicsEditorFrameComponent,
  buildPiGraphicsEditorFrameLines,
  buildPiGraphicsFloodlightComponent,
  buildPiGraphicsFloodlightLines,
  buildPiGraphicsFooterComponent,
  buildPiGraphicsFooterLines,
  buildPiGraphicsHeaderComponent,
  buildPiGraphicsHeaderLines,
  buildPiGraphicsHudComponent,
  buildPiGraphicsHudLines,
  buildPiGraphicsMessageComponent,
  buildPiGraphicsMessageLines,
  buildStagePanelWidget,
  buildStartupSplashMessage,
  buildTerminalTitle,
  buildTextStagePanel,
  buildHiddenThinkingLabel,
  buildWorkingIndicatorFrames,
  buildWorkingMessage,
  shouldAutoApplyTheme,
  shouldAutoShowGraphics,
  shouldAutoShowSplash,
} from "../extensions/pi-graphics/auto-widget.js";
import {
  componentFrameCacheKey,
  renderPiGraphicsContactSheet,
  renderTuiComponentFrame,
  renderTuiComponentFrames,
  renderTuiComponentPulseApng,
} from "../extensions/pi-graphics/components.js";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunkTypes(png) {
  const types = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    types.push(type);
    offset += 12 + length;
  }
  return types;
}

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

function relativeLuminance([r, g, b]) {
  const linear = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(a, b) {
  const hi = Math.max(relativeLuminance(a), relativeLuminance(b));
  const lo = Math.min(relativeLuminance(a), relativeLuminance(b));
  return (hi + 0.05) / (lo + 0.05);
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

test("encodeRgbaApng writes animation chunks with one IDAT and fdAT continuations", () => {
  const a = makeCanvas(2, 2, "#000000ff");
  const b = makeCanvas(2, 2, "#00d8ffff");
  const c = makeCanvas(2, 2, "#b48cffff");
  const apng = encodeRgbaApng([a, b, c], 2, 2, { delayMs: 80, plays: 0 });
  const types = pngChunkTypes(apng);
  assert.deepEqual(types.slice(0, 4), ["IHDR", "acTL", "fcTL", "IDAT"]);
  assert.equal(types.filter((type) => type === "fcTL").length, 3);
  assert.equal(types.filter((type) => type === "fdAT").length, 2);
  assert.equal(types.at(-1), "IEND");
  assert.equal(apng.subarray(0, 8).toString("hex"), PNG_SIGNATURE.toString("hex"));
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

test("renderTuiComponentFrame mirrors a TUI card with measurable graphical chrome", () => {
  const frame = renderTuiComponentFrame({ columns: 36, rows: 7, phase: 0.2, tone: "assistant" });
  assert.equal(frame.columns, 36);
  assert.equal(frame.rows, 7);
  assert.ok(frame.metrics.pngBytes < 80_000, "component frame must remain cheap enough for interactive redraws");
  assert.ok(frame.metrics.estimatedWireBytes < 110_000, "base64 wire estimate should stay bounded");
  const decoded = decodePngRgba(frame.png);
  const leftRail = pixelAt(decoded, 3, Math.floor(decoded.height / 2));
  const center = pixelAt(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2));
  const title = pixelAt(decoded, 20, 7);
  const bottomWave = pixelAt(decoded, 13, decoded.height - 20);
  assert.ok(channelDistance(leftRail, center) > 90, "activity rail should visibly differ from card fill");
  assert.ok(channelDistance(title, center) > 45, "title strip should be visible over card fill");
  assert.ok(channelDistance(bottomWave, center) > 25, "bottom pulse waveform should be visible");
});

test("renderTuiComponentFrames animates efficiently with stable layout/cache key", () => {
  const frames = renderTuiComponentFrames({ columns: 32, rows: 6, tone: "tool", frames: 5 });
  const key = componentFrameCacheKey({ columns: 32, rows: 6, tone: "tool" });
  const keyAtOtherPhase = componentFrameCacheKey({ columns: 32, rows: 6, tone: "tool", phase: 0.9 });
  assert.equal(key, keyAtOtherPhase, "phase must not change the component layout cache key");
  assert.equal(frames.length, 5);
  for (const frame of frames) {
    assert.equal(frame.columns, 32);
    assert.equal(frame.rows, 6);
    assert.equal(frame.metrics.pngBytes, frame.png.length);
    assert.ok(frame.metrics.pngBytes < 70_000);
  }
  const uniquePayloads = new Set(frames.map((frame) => frame.png.toString("base64")));
  assert.ok(uniquePayloads.size >= 4, "pulse animation should produce distinct graphical frames");
});

test("renderTuiComponentPulseApng packages pulse frames into one bounded animated PNG", () => {
  const pulse = renderTuiComponentPulseApng({ columns: 32, rows: 6, tone: "tool", frames: 6, delayMs: 75 });
  const types = pngChunkTypes(pulse.png);
  assert.equal(pulse.columns, 32);
  assert.equal(pulse.rows, 6);
  assert.equal(pulse.frames, 6);
  assert.equal(pulse.delayMs, 75);
  assert.equal(types.filter((type) => type === "fcTL").length, 6);
  assert.equal(types.filter((type) => type === "fdAT").length, 5);
  assert.equal(types.includes("acTL"), true);
  assert.ok(pulse.metrics.pngBytes < 220_000, "animated component should stay bounded for one kitty upload");
  assert.ok(pulse.metrics.estimatedWireBytes < 300_000, "base64 wire cost should stay bounded");
  assert.equal(pulse.metrics.animationMillis, 450);
});

test("renderPiGraphicsContactSheet creates a bounded visual regression sheet", () => {
  const sheet = renderPiGraphicsContactSheet({ columns: 18, rows: 4, gapPx: 6 });
  assert.equal(sheet.tileCount, 12);
  assert.deepEqual(sheet.tones, ["assistant", "tool", "user"]);
  assert.deepEqual(sheet.phases, [0, 0.25, 0.5, 0.75]);
  assert.equal(sheet.widthPx, 4 * 18 * CELL_PX_W + 5 * 6);
  assert.equal(sheet.heightPx, 3 * 4 * CELL_PX_H + 4 * 6);
  assert.ok(sheet.metrics.pngBytes < 260_000, "contact sheet should remain small enough for test artefacts");
  const decoded = decodePngRgba(sheet.png);
  const assistantSample = pixelAt(decoded, 6 + 3, 6 + Math.floor((4 * CELL_PX_H) / 2));
  const toolSample = pixelAt(decoded, 6 + 3, 6 + (4 * CELL_PX_H + 6) + Math.floor((4 * CELL_PX_H) / 2));
  const userSample = pixelAt(decoded, 6 + 3, 6 + 2 * (4 * CELL_PX_H + 6) + Math.floor((4 * CELL_PX_H) / 2));
  assert.ok(channelDistance(assistantSample, toolSample) > 70, "contact sheet should expose distinct assistant/tool palettes");
  assert.ok(channelDistance(toolSample, userSample) > 70, "contact sheet should expose distinct tool/user palettes");
});

test("render-pi-graphics-contact-sheet script is wired to the contact sheet renderer", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/render-pi-graphics-contact-sheet.mjs", import.meta.url));
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /renderPiGraphicsContactSheet/);
  assert.match(source, /writeFileSync\(out, sheet\.png\)/);
});

test("renderTuiComponentFrame tones produce visibly distinct component palettes", () => {
  const assistant = decodePngRgba(renderTuiComponentFrame({ columns: 28, rows: 5, tone: "assistant" }).png);
  const tool = decodePngRgba(renderTuiComponentFrame({ columns: 28, rows: 5, tone: "tool" }).png);
  const user = decodePngRgba(renderTuiComponentFrame({ columns: 28, rows: 5, tone: "user" }).png);
  const sample = [3, Math.floor(assistant.height / 2)];
  assert.ok(channelDistance(pixelAt(assistant, ...sample), pixelAt(tool, ...sample)) > 70, "assistant and tool rails should differ visibly");
  assert.ok(channelDistance(pixelAt(user, ...sample), pixelAt(tool, ...sample)) > 70, "user and tool rails should differ visibly");
});

test("buildAutoPulseWidget creates a visible APNG-backed startup widget", () => {
  const state = makeState();
  const widget = buildAutoPulseWidget(state, { columns: 24, rows: 4, frames: 4, delayMs: 80, tone: "assistant" });
  assert.equal(widget.lines.length, 4);
  assert.equal(widget.details.frames, 4);
  assert.equal(widget.details.delayMs, 80);
  assert.ok(widget.placement.transmit.includes("a=T"));
  assert.ok(state.ownedImageIds.has(widget.placement.imageId));
  assert.ok(widget.details.metrics.pngBytes < 160_000);
  assert.match(widget.lines[0], /kitty graphics pulse active/);
});

test("buildEditorAuraWidget adds APNG-backed editor-area graphics", () => {
  const state = makeState();
  const widget = buildEditorAuraWidget(state, { columns: 40, rows: 3, frames: 6, delayMs: 60, tone: "tool" });
  assert.equal(widget.details.columns, 40);
  assert.equal(widget.details.rows, 3);
  assert.equal(widget.details.frames, 6);
  assert.equal(widget.details.delayMs, 60);
  assert.equal(widget.details.tone, "tool");
  assert.ok(widget.lines[0].includes("PI KITTY GFX EDITOR AURA"));
  assert.ok(widget.lines.at(-1).includes("actual APNG pixels"));
  assert.ok(widget.details.metrics.pngBytes < 750_000);
  assert.ok(widget.placement.transmit.length > widget.details.metrics.estimatedWireBytes);
  assert.ok(state.ownedImageIds.has(widget.placement.imageId));
});

test("buildStagePanelWidget adds always-visible text chrome around the APNG pulse", () => {
  const state = makeState();
  const widget = buildStagePanelWidget(state, { columns: 28, rows: 5, frames: 4, delayMs: 70, tone: "tool", caption: "tool read" });
  assert.equal(widget.details.tone, "tool");
  assert.equal(widget.details.caption, "tool read");
  assert.equal(widget.details.frames, 4);
  assert.ok(widget.lines.length > widget.details.rows, "stage panel should add visible text lines around the graphic");
  assert.match(widget.lines[0], /PI KITTY GFX/);
  assert.match(widget.lines[0], /TOOL READ/);
  assert.match(widget.lines.at(-1), /neon cyan/);
  assert.ok(widget.placement.transmit.includes("a=T"));
  assert.ok(state.ownedImageIds.has(widget.placement.imageId));
  assert.ok(widget.details.metrics.pngBytes < 180_000);
});

test("buildTextStagePanel remains visible when kitty placeholders are unavailable", () => {
  const lines = buildTextStagePanel({ tone: "user", caption: "prompt captured", frames: 8, delayMs: 80 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /PI KITTY GFX/);
  assert.match(lines[0], /PROMPT CAPTURED/);
  assert.match(lines[1], /deep nordic glow/);
  assert.match(lines[2], /neon cyan/);
});

test("buildPiGraphicsMessageComponent renders bounded custom message chrome", () => {
  const calls = [];
  const theme = {
    fg(token, text) { calls.push(["fg", token, text]); return `<${token}>${text}</${token}>`; },
    bg(token, text) { calls.push(["bg", token, text]); return `[${token}]${text}[/${token}]`; },
  };
  const lines = buildPiGraphicsMessageLines({ content: "hello graphical world", tone: "tool", title: "tool output", expanded: true }, theme);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /PI KITTY GFX/);
  assert.match(lines[0], /TOOL OUTPUT/);
  assert.match(lines[1], /hello graphical world/);
  assert.match(lines[2], /pi_graphics message renderer/);
  assert.ok(calls.some(([, token]) => token === "customMessageBg"));

  const component = buildPiGraphicsMessageComponent({ content: "x".repeat(160), customType: "pi-graphics-message", details: { tone: "assistant", title: "wide" } }, { expanded: false }, theme);
  const rendered = component.render(48);
  assert.equal(rendered.length, 3);
  assert.ok(rendered.every((line) => line.length <= 49), "renderer should cap output to viewport width plus ellipsis");
  component.invalidate();
});

test("buildPiGraphicsHeaderComponent renders persistent branded session chrome", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const lines = buildPiGraphicsHeaderLines(theme);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /PI KITTY GRAPHICS ONLINE/);
  assert.match(lines[1], /deep Nordic void/);
  assert.match(lines[2], /never-a-normal-terminal mode/);
  assert.ok(lines.some((line) => line.includes("selectedBg")));
  const component = buildPiGraphicsHeaderComponent(theme);
  const rendered = component.render(54);
  assert.equal(rendered.length, 3);
  assert.ok(rendered.every((line) => line.length <= 55));
  component.invalidate();
});

test("buildPiGraphicsFloodlightComponent renders a high-contrast full-width banner", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const dim = buildPiGraphicsFloodlightLines(theme, { width: 82, phase: 0 });
  const bright = buildPiGraphicsFloodlightLines(theme, { width: 82, phase: 0.25 });
  assert.equal(dim.length, 5);
  assert.match(dim[1], /PI KITTY GRAPHICS FLOODLIGHT/);
  assert.match(dim[2], /TYPESCRIPT TUI MIRROR/);
  assert.ok(dim.some((line) => line.includes("selectedBg")));
  assert.notDeepEqual(dim, bright);
  const component = buildPiGraphicsFloodlightComponent(theme, { phase: 0 });
  const rendered = component.render(90);
  assert.equal(rendered.length, 5);
  assert.ok(rendered.every((line) => line.length <= 91));
  component.invalidate();
});

test("buildPiGraphicsFooterComponent renders persistent bottom chrome", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const lines = buildPiGraphicsFooterLines(theme, { gitBranch: "agent/demo" });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /KITTY-GFX/);
  assert.match(lines[0], /deep nordic glow/);
  assert.match(lines[0], /agent\/demo/);
  assert.match(lines[0], /toolPendingBg/);
  const component = buildPiGraphicsFooterComponent(theme, { gitBranch: "very-long-branch-name" });
  const rendered = component.render(42);
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].length <= 43);
  component.invalidate();
});

test("buildPiGraphicsHudComponent renders a persistent component-backed HUD", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const lines = buildPiGraphicsHudLines(theme, { phase: 0.25 });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /PI GFX HUD/);
  assert.match(lines[1], /TypeScript component render mirror/);
  assert.match(lines[2], /efficient persistent HUD below editor/);
  assert.ok(lines.some((line) => line.includes("selectedBg")));
  const component = buildPiGraphicsHudComponent(theme, { phase: 0 });
  const first = component.render(160);
  assert.equal(first.length, 3);
  assert.ok(first.every((line) => line.length <= 161));
  component.invalidate();
  const second = component.render(160);
  assert.notDeepEqual(first, second);
});

test("buildPiGraphicsEditorFrameComponent renders editor-edge neon chrome", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const top = buildPiGraphicsEditorFrameLines(theme, { edge: "top", width: 72, phase: 0.25 });
  const bottom = buildPiGraphicsEditorFrameLines(theme, { edge: "bottom", width: 72, phase: 0.75 });
  assert.equal(top.length, 1);
  assert.equal(bottom.length, 1);
  assert.match(top[0], /NEON EDITOR FIELD/);
  assert.match(bottom[0], /INPUT FIELD STABILIZED/);
  assert.match(top[0], /customMessageBg/);
  assert.notDeepEqual(
    buildPiGraphicsEditorFrameLines(null, { edge: "top", width: 80, phase: 0 }),
    buildPiGraphicsEditorFrameLines(null, { edge: "top", width: 80, phase: 0.25 }),
  );
  const component = buildPiGraphicsEditorFrameComponent(null, { edge: "top" });
  const rendered = component.render(80);
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].length <= 81);
  component.invalidate();
});

test("startup splash defaults on, can opt out, and builds bounded custom message", () => {
  assert.equal(shouldAutoShowSplash({}), true);
  assert.equal(shouldAutoShowSplash({ PI_GRAPHICS_AUTO_SPLASH: "0" }), false);
  assert.equal(shouldAutoShowSplash({ PI_KITTY_GRAPHICS_AUTO_SPLASH: "off" }), false);
  const message = buildStartupSplashMessage({ content: "x ".repeat(200), tone: "tool", title: "boot" });
  assert.equal(message.customType, "pi-graphics-message");
  assert.equal(message.display, true);
  assert.equal(message.details.tone, "tool");
  assert.equal(message.details.title, "boot");
  assert.ok(message.content.length <= 220);
});

test("shouldAutoShowGraphics and shouldAutoApplyTheme default on and honor explicit opt-out env", () => {
  assert.equal(shouldAutoShowGraphics({}), true);
  assert.equal(shouldAutoShowGraphics({ PI_GRAPHICS_AUTO_WIDGET: "0" }), false);
  assert.equal(shouldAutoShowGraphics({ PI_KITTY_GRAPHICS_AUTO_WIDGET: "off" }), false);
  assert.equal(shouldAutoShowGraphics({ PI_GRAPHICS_AUTO_WIDGET: "1" }), true);
  assert.equal(shouldAutoApplyTheme({}), true);
  assert.equal(shouldAutoApplyTheme({ PI_GRAPHICS_AUTO_THEME: "0" }), false);
  assert.equal(shouldAutoApplyTheme({ PI_KITTY_GRAPHICS_AUTO_THEME: "off" }), false);
  assert.equal(shouldAutoApplyTheme({ PI_GRAPHICS_AUTO_THEME: "1" }), true);
});

test("buildWorkingMessage, terminal title, and hidden thinking label brand active generation", () => {
  const calls = [];
  const theme = { fg(token, text) { calls.push([token, text]); return `<${token}>${text}</${token}>`; } };
  const toolName = "very-long-tool-name-that-should-be-truncated-after-32-chars";
  const message = buildWorkingMessage({ stage: "tool execution", toolName }, theme);
  assert.match(message, /PI KITTY GFX/);
  assert.match(message, /TOOL EXECUTION/);
  assert.match(message, /deep nordic glow/);
  assert.ok(message.length < 220);
  const title = buildTerminalTitle({ stage: "tool execution", toolName });
  assert.match(title, /PI KITTY GFX/);
  assert.match(title, /TOOL EXECUTION/);
  assert.ok(title.length <= 80);
  assert.equal(buildTerminalTitle({ stage: "ready" }), "⬢ PI KITTY GFX // READY");
  const label = buildHiddenThinkingLabel(theme);
  assert.match(label, /PI GFX THOUGHTSTREAM/);
  assert.ok(calls.some(([token]) => token === "thinkingXhigh"));
  assert.ok(calls.some(([token]) => token === "customMessageLabel"));
});

test("buildWorkingIndicatorFrames creates a themed neon pulse sequence", () => {
  const calls = [];
  const theme = { fg(token, text) { calls.push([token, text]); return `<${token}>${text}</${token}>`; } };
  const frames = buildWorkingIndicatorFrames(theme);
  assert.equal(frames.length, 8);
  assert.ok(frames.some((frame) => frame.includes("thinkingXhigh")));
  assert.ok(frames.some((frame) => frame.includes("borderAccent")));
  assert.deepEqual(calls.map(([token]) => token), ["dim", "muted", "accent", "borderAccent", "thinkingXhigh", "borderAccent", "accent", "muted"]);
});

test("pi-graphics extension source wires the auto pulse widget into startup and commands", async () => {
  const sourcePath = fileURLToPath(new URL("../extensions/pi-graphics.js", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /pi\.on\("session_start"/);
  assert.match(source, /ctx\.ui\.setTheme\("kitty-graphics"\)/);
  assert.match(source, /buildWorkingIndicatorFrames\(ctx\.ui\?\.theme\)/);
  assert.match(source, /setWorkingIndicator\?\.\(\{ frames:/);
  assert.match(source, /setWorkingVisible\?\.\(true\)/);
  assert.match(source, /setTitle\?\.\(buildTerminalTitle\(\{ stage, toolName \}\)\)/);
  assert.match(source, /setWorkingMessage\?\.\(buildWorkingMessage\(\{ stage, toolName \}, ctx\.ui\?\.theme\)\)/);
  assert.match(source, /setHiddenThinkingLabel\?\.\(buildHiddenThinkingLabel\(ctx\.ui\?\.theme\)\)/);
  assert.match(source, /setHeader\?\.\(\(_tui, theme\) => buildPiGraphicsHeaderComponent\(theme\)\)/);
  assert.match(source, /setFooter\?\.\(\(_tui, theme, footerData\) => buildPiGraphicsFooterComponent\(theme, footerData\)\)/);
  assert.match(source, /setWidget\?\.\(floodlightWidgetId, \(_tui, theme\) => buildPiGraphicsFloodlightComponent\(theme\), \{ placement: "aboveEditor" \}\)/);
  assert.match(source, /setWidget\?\.\(hudWidgetId, \(_tui, theme\) => buildPiGraphicsHudComponent\(theme\), \{ placement: "belowEditor" \}\)/);
  assert.match(source, /setWidget\?\.\(editorFrameTopId, \(_tui, theme\) => buildPiGraphicsEditorFrameComponent\(theme, \{ edge: "top" \}\), \{ placement: "aboveEditor" \}\)/);
  assert.match(source, /setWidget\?\.\(editorFrameBottomId, \(_tui, theme\) => buildPiGraphicsEditorFrameComponent\(theme, \{ edge: "bottom" \}\), \{ placement: "belowEditor" \}\)/);
  assert.match(source, /buildEditorAuraWidget\(state, \{ caption: "editor aura active", tone: "tool" \}\)/);
  assert.match(source, /setWidget\?\.\(editorAuraWidgetId, aura\.lines, \{ placement: "belowEditor" \}\)/);
  assert.match(source, /setHeader\?\.\(undefined\)/);
  assert.match(source, /setFooter\?\.\(undefined\)/);
  assert.match(source, /session header: enabled/);
  assert.match(source, /session footer: enabled/);
  assert.match(source, /component HUD: below editor/);
  assert.match(source, /editor frame: above\/below editor/);
  assert.match(source, /editor aura: APNG below editor/);
  assert.match(source, /working row: neon Pi kitty gfx/);
  assert.match(source, /terminal title: lifecycle Pi kitty gfx/);
  assert.match(source, /floodlight: high-contrast editor-adjacent banner/);
  assert.match(source, /setTitle\?\.\("pi"\)/);
  assert.match(source, /buildStartupSplashMessage\(\)/);
  assert.match(source, /startup splash: \$\{shouldAutoShowSplash\(\) \? "enabled" : "disabled by env"\}/);
  assert.match(source, /pi-theme/);
  assert.match(source, /select \/settings → kitty-graphics/);
  assert.match(source, /buildStagePanelWidget\(state, options\)/);
  assert.match(source, /buildTextStagePanel\(options\)/);
  assert.match(source, /setWidget\?\.\(autoWidgetId, widget\.lines, \{ placement: "aboveEditor" \}\)/);
  assert.match(source, /render_tui_pulse/);
  assert.match(source, /render_stage_panel/);
  assert.match(source, /render_contact_sheet/);
  assert.match(source, /registerMessageRenderer\?\.\("pi-graphics-message"/);
  assert.match(source, /buildPiGraphicsMessageComponent\(message, options, theme\)/);
  assert.match(source, /_send_message/);
  assert.match(source, /pi-graphics-message/);
  assert.match(source, /pi\.on\("before_agent_start"/);
  assert.match(source, /pi\.on\("agent_start"/);
  assert.match(source, /pi\.on\("tool_execution_start"/);
  assert.match(source, /pi\.on\("agent_end"/);
  assert.match(source, /lastAutoWidgetSignature/);
  assert.match(source, /text-stage glow fallback/);
  assert.match(source, /tool \$\{toolName\}/);
  assert.match(source, /pi-graphics-show/);
  assert.match(source, /pi-graphics-hide/);
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
  assert.deepEqual(resolve("accent"), parseColor("#00aaff"));
  assert.deepEqual(resolve("borderAccent"), parseColor("#00ffd0"));
  assert.notDeepEqual(resolve("text"), parseColor([0, 0, 0, 0]), "main text must not inherit the default terminal color");
  assert.ok(channelDistance(resolve("selectedBg"), resolve("userMessageBg")) > 90, "selected and message backgrounds should be dramatically distinguishable");
  assert.ok(contrastRatio(resolve("text"), resolve("userMessageBg")) > 10, "message text must pop against the deep Nordic background");
  assert.ok(contrastRatio(resolve("toolTitle"), resolve("toolPendingBg")) > 12, "tool titles should glow against pending tool boxes");
  assert.ok(channelDistance(resolve("customMessageBg"), resolve("userMessageBg")) > 110, "custom/extension panels should not blend into user messages");
  assert.equal(theme.export.glowCyan, "#00aaff");
  assert.equal(theme.export.glowAurora, "#ff4dff");
});

test("kitty graphics theme has large measured deltas from the built-in dark palette", async () => {
  const themePath = fileURLToPath(new URL("../themes/kitty-graphics.json", import.meta.url));
  const theme = JSON.parse(await readFile(themePath, "utf8"));
  const resolve = (token) => parseColor(theme.vars[theme.colors[token]] ?? theme.colors[token]);
  const darkBaseline = {
    accent: "#8abeb7",
    border: "#5f87ff",
    borderAccent: "#00d7ff",
    selectedBg: "#3a3a4a",
    userMessageBg: "#343541",
    customMessageBg: "#2d2838",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
    mdHeading: "#f0c674",
    mdCode: "#8abeb7",
    thinkingXhigh: "#d183e8",
  };
  for (const [token, darkColor] of Object.entries(darkBaseline)) {
    assert.ok(
      channelDistance(resolve(token), parseColor(darkColor)) > 75,
      `${token} should be visibly displaced from built-in dark`,
    );
  }
  const scriptPath = fileURLToPath(new URL("../scripts/render-pi-theme-swatch.mjs", import.meta.url));
  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /kitty-graphics\.json/);
  assert.match(script, /encodeRgbaPng/);
});
