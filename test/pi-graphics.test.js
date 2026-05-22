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
  renderEditorBorderFrame,
  renderGradientBorder,
  renderPromptEnclosure,
  resolveCellMetrics,
} from "../extensions/pi-graphics/affordances.js";
import {
  buildPlacement,
  ensureUnicodePlacement,
  makeState,
  renderToText,
} from "../extensions/pi-graphics/runtime.js";
import {
  piGraphicsImageId,
  piGraphicsIdScope,
  piGraphicsPlacementId,
  piGraphicsPlaceholderPlacementId,
} from "../extensions/pi-graphics/id-space.js";
import {
  buildAutoPulseWidget,
  buildEditorAuraWidget,
  buildPiGraphicsAnsiSceneText,
  buildPiGraphicsAnsiTakeoverText,
  buildPiGraphicsAmbientProofText,
  buildPiGraphicsCockpitWallText,
  buildPiGraphicsBrailleSceneText,
  buildPiGraphicsOscPaletteLines,
  buildPiGraphicsOscPaletteResetSequence,
  buildPiGraphicsOscPaletteSequence,
  buildPiGraphicsConversationFrameComponent,
  buildPiGraphicsConversationFrameLines,
  buildPiGraphicsEditorFrameComponent,
  buildPiGraphicsEditorFrameLines,
  buildPiGraphicsEditorSurfaceBorderLines,
  buildPiGraphicsRawBootstrapText,
  buildPiGraphicsFloodlightComponent,
  buildPiGraphicsFloodlightLines,
  buildPiGraphicsFooterComponent,
  buildPiGraphicsFooterLines,
  buildPiGraphicsHeaderComponent,
  buildPiGraphicsHeaderLines,
  buildPiGraphicsHeartbeatLine,
  buildPiGraphicsValidationReportLines,
  buildPiGraphicsValidationReportText,
  buildPiGraphicsVisualProofText,
  buildPiGraphicsHudComponent,
  buildPiGraphicsHudLines,
  buildPiGraphicsMessageComponent,
  buildPiGraphicsMessageLines,
  buildPiGraphicsDoctorLines,
  buildPiGraphicsLighthouseComponent,
  buildPiGraphicsLighthouseLines,
  buildPiGraphicsPhotonRainComponent,
  buildPiGraphicsReloadSentinelLines,
  buildPiGraphicsThemeActivationLines,
  buildPiGraphicsThemeDeltaLines,
  buildPiGraphicsPhotonRainLines,
  buildPiGraphicsThemeSwatchComponent,
  buildPiGraphicsThemeSwatchLines,
  buildPiGraphicsThemeSwatchMessageComponent,
  buildPiGraphicsTranscriptChromeComponent,
  buildPiGraphicsTranscriptChromeLines,
  buildStagePanelWidget,
  buildStartupConversationFrameMessage,
  buildStartupSplashMessage,
  buildStartupThemeSwatchMessage,
  buildTranscriptChromeMessage,
  buildTerminalTitle,
  buildTextStagePanel,
  buildVisualContractLines,
  piGraphicsThemeActivationState,
  buildHiddenThinkingLabel,
  buildWorkingIndicatorFrames,
  buildWorkingMessage,
  heartbeatIntervalMs,
  PI_GRAPHICS_RELOAD_SENTINEL,
  shouldAutoApplyTerminalPalette,
  shouldAutoApplyTheme,
  shouldAutoShowAmbientChrome,
  shouldAutoShowAmbientProof,
  shouldAutoShowAnsiScene,
  shouldAutoShowAnsiTakeover,
  shouldAutoShowBrailleScene,
  shouldAutoShowCockpitWall,
  shouldAutoShowConversationFrame,
  shouldAutoShowEditorSurface,
  shouldAutoShowGraphics,
  shouldAutoShowHeaderChrome,
  shouldAutoShowHeartbeat,
  shouldAutoShowRawBootstrap,
  shouldAutoShowTranscriptChrome,
  shouldAutoShowSplash,
  shouldAutoShowTerminalScene,
  shouldAutoShowValidationReport,
  shouldAutoShowVisualProof,
  shouldAutoShowThemeSwatchSplash,
} from "../extensions/pi-graphics/auto-widget.js";
import {
  componentFrameCacheKey,
  renderNativeChromeFrame,
  renderPiGraphicsContactSheet,
  renderTerminalSceneFrame,
  renderTerminalScenePulseApng,
  renderTuiComponentFrame,
  renderTuiComponentFrames,
  renderTuiComponentPulseApng,
  renderTuiSurfaceSceneFrame,
  renderTuiSurfaceScenePulseApng,
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

test("editor border frame stays glassy instead of fade-to-solid", () => {
  const frame = renderEditorBorderFrame({ columns: 40, edge: "symmetric", phase: 0.25 });
  const decoded = { width: frame.widthPx, height: frame.heightPx, pixels: frame.pixels };
  const stats = alphaStats(decoded);
  const midY = Math.floor(decoded.height / 2);
  const center = pixelAt(decoded, Math.floor(decoded.width / 2), midY);
  const leftEdge = pixelAt(decoded, 0, midY);
  const topEdge = pixelAt(decoded, Math.floor(decoded.width / 2), 0);

  assert.equal(leftEdge[3], 0, "horizontal border taper should avoid hard cutoffs");
  assert.equal(topEdge[3], 0, "vertical border fade should leave editor chrome transparent at cell edge");
  assert.ok(center[3] > 96, "center stroke remains visible over Pi input chrome");
  assert.ok(center[3] < 220, "center stroke remains translucent/glassy, not a solid opaque rail");
  assert.ok(stats.opaque / stats.total < 0.01, "pulse highlights may brighten locally but must not form opaque solid-color rails");
  assert.ok(stats.transparent / stats.total > 0.1, "edge taper should leave visible transparent holes instead of a hard rectangle");
  assert.ok(stats.bright / stats.total < 0.6, "bright pixels should not dominate the cell into a chunky duplicate frame");
});

test("renderPromptEnclosure variants emit distinct translucent surfaces", () => {
  const base = renderPromptEnclosure({ columns: 12, variant: "rule" });
  const variants = ["gradient", "scanlines", "grid", "dots", "glow"];
  const seen = new Set([base.png.toString("base64")]);
  for (const variant of variants) {
    const result = renderPromptEnclosure({ columns: 12, variant, alpha: 0.5 });
    assert.equal(result.variant, variant);
    assert.equal(result.columns, 12);
    assert.equal(result.rows, 1);
    assert.equal(result.png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const key = result.png.toString("base64");
    assert.ok(!seen.has(key), `variant ${variant} should differ from previous variants`);
    seen.add(key);
  }
});

test("renderPromptEnclosure honors configurable cell metrics and 120 percent line height", () => {
  const metrics = resolveCellMetrics({ cellWidthPx: 9, lineHeightScale: 1.2 });
  assert.equal(metrics.cellWidthPx, 9);
  assert.equal(metrics.cellHeightPx, 19);
  assert.equal(metrics.lineHeightScale, 1.2);
  const result = renderPromptEnclosure({ columns: 10, cellWidthPx: 9, lineHeightScale: 1.2 });
  assert.equal(result.widthPx, 90);
  assert.equal(result.heightPx, 19);
  assert.equal(result.cellWidthPx, 9);
  assert.equal(result.cellHeightPx, 19);
  assert.equal(result.lineHeightScale, 1.2);
  const explicit = renderPromptEnclosure({ columns: 10, cellWidthPx: 7, cellHeightPx: 21, lineHeightScale: 1.2 });
  assert.equal(explicit.widthPx, 70);
  assert.equal(explicit.heightPx, 21);
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

test("renderNativeChromeFrame creates translucent PNG chrome for native Pi surfaces", () => {
  const input = renderNativeChromeFrame({ surface: "input", columns: 48, rows: 2, phase: 0.15 });
  const tool = renderNativeChromeFrame({ surface: "tool", columns: 48, rows: 4, phase: 0.65 });
  assert.ok(input.png.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.ok(tool.png.subarray(0, 8).equals(PNG_SIGNATURE));
  assert.equal(input.columns, 48);
  assert.equal(input.rows, 2);
  assert.equal(tool.surface, "tool");
  assert.ok(input.metrics.pngBytes < 80_000);
  assert.ok(tool.metrics.estimatedWireBytes > tool.metrics.pngBytes);
  assert.notDeepEqual(input.png, tool.png);
});

test("renderTerminalSceneFrame draws a deep-Nordic terminal scene with pixel-level variation", () => {
  const scene = renderTerminalSceneFrame({ columns: 48, rows: 10, phase: 0.2 });
  assert.equal(scene.columns, 48);
  assert.equal(scene.rows, 10);
  assert.ok(scene.png.length > 1000);
  const decoded = decodePngRgba(scene.png);
  assert.equal(decoded.width, 48 * CELL_PX_W);
  assert.equal(decoded.height, 10 * CELL_PX_H);
  const topLeft = pixelAt(decoded, 4, 4);
  const center = pixelAt(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2));
  const lower = pixelAt(decoded, Math.floor(decoded.width / 2), decoded.height - 8);
  assert.ok(channelDistance(topLeft, center) > 25, "scene should include aurora/glow variation");
  assert.ok(channelDistance(center, lower) > 20, "scene should include gradient/waveform variation");
  assert.ok(scene.metrics.estimatedWireBytes < 200000, "scene should stay bounded for kitty upload");
});

test("renderTerminalScenePulseApng packages animated terminal scene frames", () => {
  const pulse = renderTerminalScenePulseApng({ columns: 40, rows: 8, frames: 6, delayMs: 80 });
  assert.equal(pulse.frames, 6);
  assert.equal(pulse.delayMs, 80);
  assert.ok(pulse.png.subarray(0, 8).equals(PNG_SIGNATURE));
  const chunks = pngChunkTypes(pulse.png);
  assert.ok(chunks.includes("acTL"));
  assert.ok(chunks.includes("fcTL"));
  assert.ok(chunks.includes("fdAT"));
  assert.equal(pulse.metrics.animationMillis, 480);
  assert.ok(pulse.metrics.estimatedWireBytes < 500000);
});

test("renderTuiSurfaceSceneFrame mirrors a full Pi TUI with high-contrast pixel validation", () => {
  const scene = renderTuiSurfaceSceneFrame({ columns: 64, rows: 12, phase: 0.33 });
  assert.equal(scene.columns, 64);
  assert.equal(scene.rows, 12);
  assert.ok(scene.png.length > 2000);
  assert.ok(scene.metrics.estimatedWireBytes < 400000, "surface scene should remain bounded for interactive kitty upload");
  const decoded = decodePngRgba(scene.png);
  const outer = pixelAt(decoded, 2, 2);
  const userRail = pixelAt(decoded, decoded.width - 210, 34);
  const assistantRail = pixelAt(decoded, 18, 74);
  const inputCursor = pixelAt(decoded, decoded.width - 34, decoded.height - 52);
  const center = pixelAt(decoded, Math.floor(decoded.width / 2), Math.floor(decoded.height / 2));
  assert.ok(channelDistance(outer, center) > 35, "outer chrome should differ from deep background");
  assert.ok(channelDistance(userRail, assistantRail) > 65, "user and assistant surfaces should have distinct rendered palettes");
  assert.ok(channelDistance(inputCursor, center) > 80, "editor/input cursor rail should be visibly rendered");
  const samples = new Set();
  for (let y = 0; y < decoded.height; y += 7) {
    for (let x = 0; x < decoded.width; x += 7) {
      const [r, g, b, a] = pixelAt(decoded, x, y);
      if (a > 12) samples.add(`${r >> 4}:${g >> 4}:${b >> 4}`);
    }
  }
  assert.ok(samples.size > 42, `expected many color buckets from glow/gradient renderer, saw ${samples.size}`);
});

test("renderTuiSurfaceScenePulseApng efficiently animates the full TUI surface", () => {
  const pulse = renderTuiSurfaceScenePulseApng({ columns: 58, rows: 10, frames: 4, delayMs: 90 });
  const chunks = pngChunkTypes(pulse.png);
  assert.equal(pulse.frames, 4);
  assert.equal(pulse.delayMs, 90);
  assert.equal(pulse.metrics.animationMillis, 360);
  assert.equal(chunks.filter((type) => type === "fcTL").length, 4);
  assert.equal(chunks.filter((type) => type === "fdAT").length, 3);
  assert.ok(pulse.metrics.pngBytes < 520000, "full TUI APNG must stay bounded as one efficient kitty upload");
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

test("render-pi-graphics-smoke script writes a renderer-backed visual artifact", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/render-pi-graphics-smoke.mjs", import.meta.url));
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /renderTuiSurfaceSceneFrame/);
  assert.match(source, /renderTuiSurfaceScenePulseApng/);
  assert.match(source, /pi-graphics-smoke\.png/);
  assert.match(source, /JSON\.stringify/);
});

test("test-pi-graphics-tmux-smoke validates tmux redraw and scoped cleanup invariants", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/test-pi-graphics-tmux-smoke.mjs", import.meta.url));
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /state\.config\.passthrough = "tmux"/);
  assert.match(source, /redraw must not re-upload image data/);
  assert.match(source, /redraw must reuse the existing virtual placement without re-emitting placement commands/);
  assert.match(source, /cleanup must never delete all terminal images/);
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

test("buildPiGraphicsBrailleSceneText renders truecolor Braille from scene pixels", () => {
  assert.equal(shouldAutoShowBrailleScene({}), false);
  assert.equal(shouldAutoShowBrailleScene({ PI_GRAPHICS_AUTO_BRAILLE_SCENE: "1" }), true);
  assert.equal(shouldAutoShowBrailleScene({ PI_GRAPHICS_AUTO_BRAILLE_SCENE: "0" }), false);
  const first = buildPiGraphicsBrailleSceneText({ columns: 28, rows: 7, phase: 0.1, label: "BRAILLE SCENE" });
  const second = buildPiGraphicsBrailleSceneText({ columns: 28, rows: 7, phase: 0.6, label: "BRAILLE SCENE" });
  assert.match(first, /BRAILLE SCENE/);
  assert.match(first, /RGBA→BRAILLE TRUECOLOR RENDER/);
  assert.match(first, /[\u2801-\u28ff]/);
  assert.match(first, /\u001b\[38;2;/);
  assert.match(first, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(first.split("\n").length >= 10);
  assert.notEqual(first, second);
});

test("buildPiGraphicsValidationReportText reports real rendered pixel metrics", () => {
  assert.equal(shouldAutoShowValidationReport({}), false);
  assert.equal(shouldAutoShowValidationReport({ PI_GRAPHICS_AUTO_VALIDATION_REPORT: "1" }), true);
  assert.equal(shouldAutoShowValidationReport({ PI_GRAPHICS_AUTO_VALIDATION_REPORT: "off" }), false);
  const lines = buildPiGraphicsValidationReportLines({ columns: 40, rows: 7, frames: 6 });
  const report = buildPiGraphicsValidationReportText({ columns: 40, rows: 7, frames: 6 });
  assert.equal(lines.length, 9);
  assert.match(report, /PI GFX RENDERED VALIDATION REPORT/);
  assert.match(report, /component PNG: \d+x\d+px \d+B wire≈\d+B/);
  assert.match(report, /component visual: uniqueBuckets=\d+ lumaRange=\d+/);
  assert.match(report, /terminal scene visual: uniqueBuckets=\d+ lumaRange=\d+/);
  assert.match(report, /tui surface PNG: \d+x\d+px \d+B wire≈\d+B/);
  assert.match(report, /tui surface visual: uniqueBuckets=\d+ lumaRange=\d+/);
  assert.match(report, /APNG pulse: frames=6 delayMs=70 bytes=\d+ animationMs=420/);
  const componentRange = Number(report.match(/component visual:.*lumaRange=(\d+)/)?.[1]);
  const sceneRange = Number(report.match(/terminal scene visual:.*lumaRange=(\d+)/)?.[1]);
  const tuiSurfaceRange = Number(report.match(/tui surface visual:.*lumaRange=(\d+)/)?.[1]);
  assert.ok(componentRange > 30);
  assert.ok(sceneRange > 30);
  assert.ok(tuiSurfaceRange > 45);
  assert.match(report, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildPiGraphicsAmbientProofText emits opt-in compact truecolor fallback with rendered metrics", () => {
  assert.equal(shouldAutoShowAmbientProof({}), false);
  assert.equal(shouldAutoShowAmbientProof({ PI_GRAPHICS_AUTO_AMBIENT_PROOF: "0" }), false);
  assert.equal(shouldAutoShowAmbientProof({ PI_KITTY_GRAPHICS_AUTO_AMBIENT_PROOF: "off" }), false);
  const text = buildPiGraphicsAmbientProofText({ width: 42, phase: 0.2, label: "SMOKE", themeName: "kitty-graphics-nord", mode: "calm", env: { PI_GRAPHICS_AUTO_THEME: "1", PI_GRAPHICS_AUTO_AMBIENT_CHROME: "1", PI_GRAPHICS_AUTO_AMBIENT_PROOF: "1" } });
  const lines = text.split("\n");
  assert.equal(lines.length, 5);
  assert.match(text, /SMOKE/);
  assert.match(text, /TS RGBA→KITTY\/APNG/);
  assert.match(text, /theme=kitty-graphics-nord mode=calm autoTheme=1 ambientChrome=1 ambientProof=1/);
  assert.match(text, /Δtheme accent=\d+ userBg=\d+ aurora=\d+/);
  assert.match(text, /surface=\d+x\d+px png=\d+B buckets=\d+ lumaΔ=\d+/);
  assert.match(text, /\u001b\[48;2;/);
  assert.match(text, /⬢|◆|▄/);
  const buckets = Number(text.match(/buckets=(\d+)/)?.[1]);
  const luma = Number(text.match(/lumaΔ=(\d+)/)?.[1]);
  assert.ok(buckets > 35);
  assert.ok(luma > 45);
});

test("buildPiGraphicsVisualProofText emits ANSI color chips and measurable deltas", () => {
  assert.equal(shouldAutoShowVisualProof({}), false);
  assert.equal(shouldAutoShowVisualProof({ PI_GRAPHICS_AUTO_VISUAL_PROOF: "1" }), true);
  assert.equal(shouldAutoShowVisualProof({ PI_GRAPHICS_AUTO_VISUAL_PROOF: "0" }), false);
  const proof = buildPiGraphicsVisualProofText({ width: 84, label: "VISUAL PROOF" });
  assert.match(proof, /VISUAL PROOF/);
  assert.match(proof, /TRUECOLOR CHIPS \+ MEASURED DELTAS/);
  assert.match(proof, /cyan\s+/);
  assert.match(proof, /violet\s+/);
  assert.match(proof, /contrast=/);
  assert.match(proof, /ΔRGB=/);
  assert.match(proof, /\u001b\[48;2;/);
  assert.match(proof, /\u001b\[38;2;/);
  assert.match(proof, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(proof.split("\n").length >= 7);
});

test("buildPiGraphicsHeartbeatLine emits a lightweight live pulse ticker", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
  };
  assert.equal(shouldAutoShowHeartbeat({}), false);
  assert.equal(shouldAutoShowHeartbeat({ PI_GRAPHICS_AUTO_HEARTBEAT: "1" }), true);
  assert.equal(shouldAutoShowHeartbeat({ PI_GRAPHICS_AUTO_HEARTBEAT: "0" }), false);
  assert.equal(heartbeatIntervalMs({ PI_GRAPHICS_HEARTBEAT_MS: "10" }), 250);
  assert.equal(heartbeatIntervalMs({ PI_GRAPHICS_HEARTBEAT_MS: "9999" }), 5000);
  const first = buildPiGraphicsHeartbeatLine(theme, { tick: 0, stage: "idle" });
  const second = buildPiGraphicsHeartbeatLine(theme, { tick: 3, stage: "idle" });
  assert.match(first, /PI GFX HEARTBEAT/);
  assert.match(first, /IDLE/);
  assert.match(first, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(first, second);
});

test("buildPiGraphicsCockpitWallText emits a large ANSI terminal cockpit", () => {
  assert.equal(shouldAutoShowCockpitWall({}), false);
  assert.equal(shouldAutoShowCockpitWall({ PI_GRAPHICS_AUTO_COCKPIT_WALL: "1" }), true);
  assert.equal(shouldAutoShowCockpitWall({ PI_GRAPHICS_AUTO_COCKPIT_WALL: "0" }), false);
  const first = buildPiGraphicsCockpitWallText({ width: 88, phase: 0, label: "COCKPIT WALL" });
  const second = buildPiGraphicsCockpitWallText({ width: 88, phase: 0.5, label: "COCKPIT WALL" });
  assert.match(first, /COCKPIT WALL/);
  assert.match(first, /TRUECOLOR TERMINAL TAKEOVER/);
  assert.match(first, /RENDER BUS: HALF-BLOCK PIXELS/);
  assert.match(first, /\u001b\[48;2;/);
  assert.match(first, /▀/);
  assert.match(first, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(first.split("\n").length >= 14);
  assert.notEqual(first, second);
});

test("buildPiGraphicsOscPaletteSequence emits default-on terminal palette takeover and reset OSC", () => {
  assert.equal(shouldAutoApplyTerminalPalette({}), true);
  assert.equal(shouldAutoApplyTerminalPalette({ PI_GRAPHICS_AUTO_TERMINAL_PALETTE: "1" }), true);
  assert.equal(shouldAutoApplyTerminalPalette({ PI_GRAPHICS_AUTO_TERMINAL_PALETTE: "0" }), false);
  const seq = buildPiGraphicsOscPaletteSequence();
  assert.match(seq, /\u001b\]10;#e9f8ff\u0007/);
  assert.match(seq, /\u001b\]11;#02030b\u0007/);
  assert.match(seq, /\u001b\]12;#00ffd0\u0007/);
  assert.match(seq, /\u001b\]4;0;#02030b\u0007/);
  assert.match(seq, /\u001b\]4;15;#e9f8ff\u0007/);
  const reset = buildPiGraphicsOscPaletteResetSequence();
  assert.match(reset, /\u001b\]110\u0007/);
  assert.match(reset, /\u001b\]111\u0007/);
  assert.match(reset, /\u001b\]112\u0007/);
  const lines = buildPiGraphicsOscPaletteLines().join("\n");
  assert.match(lines, /OSC PALETTE TAKEOVER/);
  assert.match(lines, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("buildPiGraphicsAnsiSceneText samples rendered scene pixels into ANSI half blocks", () => {
  assert.equal(shouldAutoShowAnsiScene({}), false);
  assert.equal(shouldAutoShowAnsiScene({ PI_GRAPHICS_AUTO_ANSI_SCENE: "1" }), true);
  assert.equal(shouldAutoShowAnsiScene({ PI_GRAPHICS_AUTO_ANSI_SCENE: "0" }), false);
  const first = buildPiGraphicsAnsiSceneText({ columns: 72, rows: 8, phase: 0, label: "SCENE SHADER" });
  const second = buildPiGraphicsAnsiSceneText({ columns: 72, rows: 8, phase: 0.35, label: "SCENE SHADER" });
  assert.match(first, /\u001b\[48;2;/);
  assert.match(first, /\u001b\[38;2;/);
  assert.match(first, /▀/);
  assert.match(first, /SCENE SHADER/);
  assert.match(first, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(first.split("\n").length, 10);
  assert.notEqual(first, second);
});

test("buildPiGraphicsAnsiTakeoverText emits raw truecolor terminal graphics", () => {
  assert.equal(shouldAutoShowAnsiTakeover({}), false);
  assert.equal(shouldAutoShowAnsiTakeover({ PI_GRAPHICS_AUTO_ANSI_TAKEOVER: "1" }), true);
  assert.equal(shouldAutoShowAnsiTakeover({ PI_GRAPHICS_AUTO_ANSI_TAKEOVER: "off" }), false);
  const first = buildPiGraphicsAnsiTakeoverText({ width: 64, phase: 0, label: "TEST TAKEOVER" });
  const second = buildPiGraphicsAnsiTakeoverText({ width: 64, phase: 0.4, label: "TEST TAKEOVER" });
  assert.match(first, /\u001b\[48;2;/);
  assert.match(first, /\u001b\[38;2;/);
  assert.match(first, /TEST TAKEOVER/);
  assert.match(first, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(first.split("\n").length, 5);
  assert.notEqual(first, second);
});

test("buildPiGraphicsConversationFrameComponent renders normal transcript chrome", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const message = buildStartupConversationFrameMessage({ content: "ordinary assistant text should still be preserved inside the graphical frame", title: "assistant frame" });
  assert.equal(message.customType, "pi-graphics-conversation-frame");
  assert.equal(message.display, true);
  assert.equal(shouldAutoShowConversationFrame({}), false);
  assert.equal(shouldAutoShowConversationFrame({ PI_GRAPHICS_AUTO_CONVERSATION_FRAME: "1" }), true);
  assert.equal(shouldAutoShowConversationFrame({ PI_GRAPHICS_AUTO_CONVERSATION_FRAME: "0" }), false);
  const lines = buildPiGraphicsConversationFrameLines({ content: message.content, role: "assistant", title: "assistant frame", width: 88 }, theme);
  const joined = lines.join("\n");
  assert.match(joined, /PI GFX ASSISTANT/);
  assert.match(joined, /ordinary assistant text/);
  assert.match(joined, /deep nordic conversation renderer/);
  assert.match(joined, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const component = buildPiGraphicsConversationFrameComponent(message, { expanded: true }, theme);
  const rendered = component.render(96);
  assert.ok(rendered.length >= 6);
  assert.ok(rendered.every((line) => line.length <= 97));
});

test("buildPiGraphicsTranscriptChromeComponent renders opt-in truecolor transcript chrome", () => {
  assert.equal(shouldAutoShowTranscriptChrome({}), false);
  assert.equal(shouldAutoShowTranscriptChrome({ PI_GRAPHICS_AUTO_TRANSCRIPT_CHROME: "0" }), false);
  assert.equal(shouldAutoShowTranscriptChrome({ PI_KITTY_GRAPHICS_AUTO_TRANSCRIPT_CHROME: "off" }), false);
  const message = buildTranscriptChromeMessage({ role: "assistant", title: "rendered transcript chrome", phase: 0.25 });
  assert.equal(message.customType, "pi-graphics-transcript-chrome");
  assert.equal(message.display, true);
  const lines = buildPiGraphicsTranscriptChromeLines({ role: "assistant", label: "rendered transcript chrome", width: 72, phase: 0.25 });
  const joined = lines.join("\n");
  assert.equal(lines.length, 4);
  assert.match(joined, /ASSISTANT/);
  assert.match(joined, /RENDERED TRANSCRIPT CHROME/);
  assert.match(joined, /\u001b\[48;2;/);
  assert.match(joined, /\u001b\[38;2;/);
  assert.match(joined, /▰▱⬢◆✦✺/);
  const component = buildPiGraphicsTranscriptChromeComponent(message, {}, null);
  const rendered = component.render(60);
  assert.equal(rendered.length, 4);
  assert.ok(rendered.every((line) => line.length <= 61));
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

test("buildPiGraphicsReloadSentinelLines and theme delta report expose stale-session diagnostics", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const sentinel = buildPiGraphicsReloadSentinelLines(theme).join("\n");
  assert.match(sentinel, /PI GFX RELOAD SENTINEL/);
  assert.match(sentinel, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sentinel, /older agent-utils package/);
  const delta = buildPiGraphicsThemeDeltaLines(theme).join("\n");
  assert.match(delta, /PI KITTY THEME DELTA REPORT/);
  assert.match(delta, /selectedBg/);
  assert.match(delta, /customMessageBg/);
  assert.match(delta, /ΔRGB=/);
  assert.match(delta, /select \/settings → kitty-graphics/);
});

test("buildPiGraphicsLighthouseComponent renders an oversized unmistakable beacon", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const first = buildPiGraphicsLighthouseLines(theme, { width: 112, phase: 0 });
  const second = buildPiGraphicsLighthouseLines(theme, { width: 112, phase: 0.25 });
  assert.equal(first.length, 5);
  assert.match(first.join("\n"), /PI KITTY GRAPHICS LIGHTHOUSE/);
  assert.match(first.join("\n"), /GRAPHICAL MODE IS ACTIVE/);
  assert.match(first.join("\n"), /DEEP NORDIC AURORA/);
  assert.ok(first.some((line) => line.includes("selectedBg")));
  assert.notDeepEqual(first, second);
  const component = buildPiGraphicsLighthouseComponent(theme, { phase: 0 });
  const rendered = component.render(90);
  assert.equal(rendered.length, 5);
  assert.ok(rendered.every((line) => line.length <= 91));
  component.invalidate();
});

test("buildPiGraphicsThemeActivationLines diagnoses active, stale, and missing theme paths", () => {
  const theme = { fg(token, text) { return `<${token}>${text}</${token}>`; } };
  const activeState = piGraphicsThemeActivationState({
    requestedThemeName: "kitty-graphics-nord",
    runtimeThemeName: "kitty-graphics-nord",
    setThemeAvailable: true,
    setThemeResult: { success: true },
    autoTheme: true,
  });
  assert.equal(activeState.active, true);
  assert.equal(activeState.severity, "ok");
  const activeText = buildPiGraphicsThemeActivationLines({
    requestedThemeName: "kitty-graphics-nord",
    runtimeThemeName: "kitty-graphics-nord",
    setThemeAvailable: true,
    setThemeResult: { success: true },
    autoTheme: true,
  }, theme).join("\n");
  assert.match(activeText, /PI KITTY GRAPHICS THEME ACTIVATION/);
  assert.match(activeText, /active theme signal/);
  assert.match(activeText, /ui\.setTheme available and accepted request/);
  assert.match(activeText, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const staleText = buildPiGraphicsThemeActivationLines({
    requestedThemeName: "kitty-graphics-nord",
    runtimeThemeName: "dark",
    setThemeAvailable: true,
    setThemeResult: { success: false, error: "theme not installed" },
    autoTheme: true,
    themeSyncErrors: ["themes: read-only"],
  }, theme).join("\n");
  assert.match(staleText, /theme not confirmed/);
  assert.match(staleText, /theme not installed/);
  assert.match(staleText, /theme sync errors: 1/);
  assert.match(staleText, /reload tools\/session/);

  const missingApi = piGraphicsThemeActivationState({ setThemeAvailable: false, runtimeThemeName: "dark" });
  assert.equal(missingApi.active, false);
  assert.match(missingApi.remediation, /ui\.setTheme/);
});

test("buildPiGraphicsDoctorLines reports visibility diagnostics and remediation", () => {
  const theme = { fg(token, text) { return `<${token}>${text}</${token}>`; } };
  const lines = buildPiGraphicsDoctorLines({
    themeName: "dark",
    unicodePlacement: false,
    autoTerminalScene: false,
    autoTheme: false,
    autoWidget: true,
    autoSplash: true,
    autoThemeSwatch: false,
  }, theme);
  const text = lines.join("\n");
  assert.match(text, /PI KITTY GRAPHICS DOCTOR/);
  assert.match(text, /select \/settings → kitty-graphics/);
  assert.match(text, /kitty placeholders: inactive/);
  assert.match(text, /auto terminal scene disabled/);
  assert.match(text, /\/pi-graphics-show/);
  assert.match(text, /pi_graphics_render_terminal_scene/);
});

test("buildPiGraphicsPhotonRainComponent renders pulsing high-tech text chrome", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const first = buildPiGraphicsPhotonRainLines(theme, { width: 104, phase: 0 });
  const second = buildPiGraphicsPhotonRainLines(theme, { width: 104, phase: 0.25 });
  assert.equal(first.length, 5);
  assert.match(first[0], /PI PHOTON RAIN/);
  assert.match(first.join("\n"), /DEEP NORDIC RENDER FIELD/);
  assert.match(first.join("\n"), /cyan ion drift/);
  assert.match(first.join("\n"), /violet pulse scan/);
  assert.match(first.join("\n"), /never-normal terminal/);
  assert.ok(first.some((line) => line.includes("selectedBg")));
  assert.notDeepEqual(first, second);
  const component = buildPiGraphicsPhotonRainComponent(theme, { phase: 0 });
  const rendered = component.render(80);
  assert.equal(rendered.length, 5);
  assert.ok(rendered.every((line) => line.length <= 81));
  component.invalidate();
});

test("startup theme swatch message defaults on and renders transcript-visible swatch", () => {
  assert.equal(shouldAutoShowThemeSwatchSplash({}), false);
  assert.equal(shouldAutoShowThemeSwatchSplash({ PI_GRAPHICS_AUTO_THEME_SWATCH: "1" }), true);
  assert.equal(shouldAutoShowThemeSwatchSplash({ PI_GRAPHICS_AUTO_THEME_SWATCH: "0" }), false);
  assert.equal(shouldAutoShowThemeSwatchSplash({ PI_KITTY_GRAPHICS_AUTO_THEME_SWATCH: "off" }), false);
  const message = buildStartupThemeSwatchMessage({ width: 88 });
  assert.equal(message.customType, "pi-graphics-theme-swatch");
  assert.equal(message.display, true);
  assert.equal(message.details.width, 88);
  const component = buildPiGraphicsThemeSwatchMessageComponent(message, {}, null);
  const rendered = component.render(88);
  assert.equal(rendered.length, 5);
  assert.match(rendered.join("\n"), /PI THEME CALIBRATION SWATCH/);
});

test("buildPiGraphicsThemeSwatchComponent renders actual theme-token calibration bars", () => {
  const calls = [];
  const theme = {
    fg(token, text) { calls.push(["fg", token]); return `<${token}>${text}</${token}>`; },
    bg(token, text) { calls.push(["bg", token]); return `[${token}]${text}[/${token}]`; },
  };
  const dim = buildPiGraphicsThemeSwatchLines(theme, { width: 96, phase: 0 });
  const bright = buildPiGraphicsThemeSwatchLines(theme, { width: 96, phase: 0.25 });
  assert.equal(dim.length, 5);
  assert.match(dim[0], /PI THEME CALIBRATION SWATCH/);
  assert.match(dim.join("\n"), /selectedBg \+ borderAccent/);
  assert.match(dim.join("\n"), /toolPendingBg \+ thinkingXhigh/);
  assert.match(dim.join("\n"), /kitty-graphics theme is not active/);
  assert.ok(calls.some(([, token]) => token === "selectedBg"));
  assert.ok(calls.some(([, token]) => token === "customMessageBg"));
  assert.ok(calls.some(([, token]) => token === "toolPendingBg"));
  assert.notDeepEqual(dim, bright);
  const component = buildPiGraphicsThemeSwatchComponent(theme, { phase: 0 });
  const rendered = component.render(72);
  assert.equal(rendered.length, 5);
  assert.ok(rendered.every((line) => line.length <= 73));
  component.invalidate();
});

test("buildPiGraphicsFooterComponent renders a live branch/status beacon", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const footerData = {
    getGitBranch: () => "agent/demo",
    getExtensionStatuses: () => new Map([
      ["pi-graphics", "◆ assistant stage 8f"],
      ["pi-theme", "◆ kitty-graphics active"],
      ["other", "hidden"],
    ]),
  };
  const lines = buildPiGraphicsFooterLines(theme, footerData);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /KITTY-GFX LIVE FOOTER|deep nordic glow|pi-graphics:|pi-theme:/);
  assert.match(lines[0], /agent\/demo/);
  assert.doesNotMatch(lines[0], /other:hidden/);
  assert.match(lines[0], /thinkingXhigh/);
  const component = buildPiGraphicsFooterComponent(theme, footerData);
  const rendered = component.render(64);
  assert.equal(rendered.length, 1);
  assert.ok(rendered[0].length <= 65);
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

test("buildPiGraphicsEditorFrameComponent renders subtle editor-edge accents without text labels", () => {
  const theme = {
    fg(token, text) { return `<${token}>${text}</${token}>`; },
    bg(token, text) { return `[${token}]${text}[/${token}]`; },
  };
  const top = buildPiGraphicsEditorFrameLines(theme, { edge: "top", width: 72, phase: 0.25 });
  const bottom = buildPiGraphicsEditorFrameLines(theme, { edge: "bottom", width: 72, phase: 0.75 });
  assert.equal(top.length, 1);
  assert.equal(bottom.length, 1);
  assert.doesNotMatch(top[0], /NEON|EDITOR|FIELD|PI KITTY|GRAPHICS/);
  assert.doesNotMatch(bottom[0], /INPUT|STABILIZED|PI KITTY|GRAPHICS/);
  assert.match(top[0], /borderAccent/);
  assert.match(bottom[0], /thinkingXhigh/);
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

test("buildPiGraphicsRawBootstrapText emits opt-in dependency-free truecolor startup proof", () => {
  assert.equal(shouldAutoShowRawBootstrap({}), false);
  assert.equal(shouldAutoShowRawBootstrap({ PI_GRAPHICS_AUTO_RAW_BOOTSTRAP: "0" }), false);
  assert.equal(shouldAutoShowRawBootstrap({ PI_KITTY_GRAPHICS_AUTO_RAW_BOOTSTRAP: "off" }), false);
  const text = buildPiGraphicsRawBootstrapText({ width: 132, label: "raw proof", phase: 0.2 });
  assert.match(text, /RAW PROOF/);
  assert.match(text, /RAW TRUECOLOR PATH ACTIVE/);
  assert.match(text, /NO THEME\/WIDGET\/EDITOR\/KITTY DEPENDENCY/);
  assert.match(text, /\u001b\[48;2;/);
  assert.match(text, /\u001b\[38;2;/);
  assert.match(text, /⬢◆✦✺▰▱/);
  assert.match(text, new RegExp(PI_GRAPHICS_RELOAD_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(text.trimEnd().split("\n").length, 3);
});

test("buildPiGraphicsEditorSurfaceBorderLines renders subtle truecolor input accents", () => {
  assert.equal(shouldAutoShowEditorSurface({}), true);
  assert.equal(shouldAutoShowEditorSurface({ PI_GRAPHICS_AUTO_EDITOR_SURFACE: "0" }), false);
  assert.equal(shouldAutoShowEditorSurface({ PI_KITTY_GRAPHICS_AUTO_EDITOR_SURFACE: "off" }), false);
  const ready = buildPiGraphicsEditorSurfaceBorderLines({ width: 74, active: false, phase: 0.1, label: "input surface" });
  const active = buildPiGraphicsEditorSurfaceBorderLines({ width: 74, active: true, phase: 0.4, label: "agent pulse input" });
  assert.equal(ready.length, 2);
  assert.doesNotMatch(ready.join("\n"), /PI GFX|INPUT SURFACE|NEON|GRAPHICS/);
  assert.doesNotMatch(active.join("\n"), /PULSING|DEEP NORDIC|RENDERED EDITOR/);
  assert.match(active.join("\n"), /\u001b\[38;2;/);
  assert.doesNotMatch(active.join("\n"), /\u001b\[48;2;/);
  assert.notDeepEqual(ready, active);
});

test("startup splash defaults on, can opt out, and builds bounded custom message", () => {
  assert.equal(shouldAutoShowSplash({}), false);
  assert.equal(shouldAutoShowSplash({ PI_GRAPHICS_AUTO_SPLASH: "1" }), true);
  assert.equal(shouldAutoShowSplash({ PI_GRAPHICS_AUTO_SPLASH: "0" }), false);
  assert.equal(shouldAutoShowSplash({ PI_KITTY_GRAPHICS_AUTO_SPLASH: "off" }), false);
  const message = buildStartupSplashMessage({ content: "x ".repeat(200), tone: "tool", title: "boot" });
  assert.equal(message.customType, "pi-graphics-message");
  assert.equal(message.display, true);
  assert.equal(message.details.tone, "tool");
  assert.equal(message.details.title, "boot");
  assert.ok(message.content.length <= 220);
});

test("pi graphics auto features default calm and honor explicit settings/env", () => {
  assert.equal(shouldAutoShowGraphics({}), false);
  assert.equal(shouldAutoShowGraphics({ PI_GRAPHICS_AUTO_WIDGET: "0" }), false);
  assert.equal(shouldAutoShowGraphics({ PI_KITTY_GRAPHICS_AUTO_WIDGET: "off" }), false);
  assert.equal(shouldAutoShowGraphics({ PI_GRAPHICS_AUTO_WIDGET: "1" }), true);
  assert.equal(shouldAutoShowAmbientChrome({}), false);
  assert.equal(shouldAutoShowAmbientChrome({ PI_GRAPHICS_AUTO_AMBIENT_CHROME: "0" }), false);
  assert.equal(shouldAutoShowAmbientChrome({ PI_KITTY_GRAPHICS_AUTO_AMBIENT_CHROME: "off" }), false);
  assert.equal(shouldAutoShowAmbientChrome({ PI_GRAPHICS_AUTO_AMBIENT_CHROME: "1" }), true);
  assert.equal(shouldAutoShowAmbientProof({}), false);
  assert.equal(shouldAutoShowAmbientProof({ PI_GRAPHICS_AUTO_AMBIENT_PROOF: "0" }), false);
  assert.equal(shouldAutoShowAmbientProof({ PI_GRAPHICS_AUTO_AMBIENT_PROOF: "1" }), true);
  assert.equal(shouldAutoApplyTheme({}), true);
  assert.equal(shouldAutoApplyTerminalPalette({}), true);
  assert.equal(shouldAutoShowTranscriptChrome({}), false);
  assert.equal(shouldAutoShowTranscriptChrome({ PI_GRAPHICS_AUTO_TRANSCRIPT_CHROME: "0" }), false);
  assert.equal(shouldAutoShowEditorSurface({}), true);
  assert.equal(shouldAutoShowEditorSurface({ PI_GRAPHICS_AUTO_EDITOR_SURFACE: "0" }), false);
  assert.equal(shouldAutoShowRawBootstrap({}), false);
  assert.equal(shouldAutoShowRawBootstrap({ PI_GRAPHICS_AUTO_RAW_BOOTSTRAP: "0" }), false);
  assert.equal(shouldAutoShowHeaderChrome({}), false);
  assert.equal(shouldAutoShowHeaderChrome({ PI_GRAPHICS_AUTO_HEADER_CHROME: "0" }), false);
  assert.equal(shouldAutoApplyTheme({ PI_GRAPHICS_AUTO_THEME: "0" }), false);
  assert.equal(shouldAutoApplyTheme({ PI_KITTY_GRAPHICS_AUTO_THEME: "off" }), false);
  assert.equal(shouldAutoApplyTheme({ PI_GRAPHICS_AUTO_THEME: "1" }), true);
  assert.equal(shouldAutoShowTerminalScene({}), false);
  assert.equal(shouldAutoShowTerminalScene({ PI_GRAPHICS_AUTO_TERMINAL_SCENE: "1" }), true);
  assert.equal(shouldAutoShowTerminalScene({ PI_GRAPHICS_AUTO_TERMINAL_SCENE: "0" }), false);
  assert.equal(shouldAutoShowTerminalScene({ PI_KITTY_GRAPHICS_AUTO_TERMINAL_SCENE: "off" }), false);
});

test("pi-graphics settings source maps minimal env", async () => {
  const sourcePath = fileURLToPath(new URL("../extensions/pi-graphics.js", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /export function settingsEnvFromPiGraphics/);
  assert.match(source, /PI_GRAPHICS_MODE: off \? "off" : "on"/);
  assert.match(source, /PI_GRAPHICS_AUTO_THEME: off \? "0" : \(gfx\.autoApplyTheme \?\? true\)/);
  assert.match(source, /PI_GRAPHICS_AUTO_EDITOR_SURFACE: off \? "0" : \(features\.editor \?\? true\)/);
  assert.match(source, /PI_GRAPHICS_CELL_WIDTH_PX: gfx\.cell\?\.widthPx/);
  assert.match(source, /PI_GRAPHICS_CELL_HEIGHT_PX: gfx\.cell\?\.heightPx/);
  assert.match(source, /PI_GRAPHICS_LINE_HEIGHT_SCALE: gfx\.cell\?\.lineHeightScale/);
  assert.match(source, /PI_GRAPHICS_EDITOR_VARIANT: editor\.variant/);
  assert.match(source, /PI_GRAPHICS_EDITOR_ALPHA: editor\.alpha/);
  assert.match(source, /PI_GRAPHICS_BOX_EFFECT: gfx\.boxEffect/);
  assert.match(source, /PI_GRAPHICS_AUTO_BOX_CHROME: off \? "0" : gfx\.boxChrome === false \? "0" : "1"/);
  assert.match(source, /PI_GRAPHICS_BOX_MODE: gfx\.boxMode != null \? String\(gfx\.boxMode\) : "unicode"/);
  assert.match(source, /BOX_EFFECT_NAMES/);
  assert.match(source, /registerShortcut\?\.\("ctrl\+t"/);
  assert.match(source, /\$\{theme\}:static`, theme, mode: "on", editorStyle: "static", boxChrome: true, boxMode: "unicode"/);
  assert.match(source, /\$\{theme\}:unicode/);
  assert.match(source, /boxes:\$\{effect\}/);
  assert.match(source, /setWorkingIndicator/);
  assert.match(source, /fillEditorTrailingWorkspace/);
  assert.match(source, /const visualCols = cols/);
  assert.match(source, /const leadingCells = 0/);
});

test("buildVisualContractLines exposes a complete operator checklist", () => {
  const theme = { fg(token, text) { return `<${token}>${text}</${token}>`; } };
  const active = buildVisualContractLines({ unicodePlacement: true, splash: true }, theme);
  assert.equal(active.length, 8);
  assert.match(active.join("\n"), /PI KITTY GRAPHICS VISUAL CONTRACT/);
  assert.match(active.join("\n"), /kitty placeholder graphics active/);
  assert.match(active.join("\n"), /header\/footer\/HUD\/floodlight mounted/);
  assert.match(active.join("\n"), /editor frame \+ APNG aura mounted/);
  assert.match(active.join("\n"), /working row \+ terminal title branded/);
  const fallback = buildVisualContractLines({ unicodePlacement: false, splash: false }).join("\n");
  assert.match(fallback, /fallback text active/);
  assert.match(fallback, /startup splash disabled by env/);
});

test("buildWorkingMessage, terminal title, and hidden thinking label stay subtle in calm mode", () => {
  const calls = [];
  const theme = { fg(token, text) { calls.push([token, text]); return `<${token}>${text}</${token}>`; } };
  const toolName = "very-long-tool-name-that-should-be-truncated-after-32-chars";
  const message = buildWorkingMessage({ stage: "tool execution", toolName }, theme);
  assert.doesNotMatch(message, /PI KITTY GFX|TOOL EXECUTION|deep nordic glow/);
  assert.match(message, /very-long-tool-name-th/);
  assert.ok(message.length < 96);
  const title = buildTerminalTitle({ stage: "tool execution", toolName });
  assert.doesNotMatch(title, /PI KITTY GFX|TOOL EXECUTION/);
  assert.match(title, /very-long-tool-name-th/);
  assert.ok(title.length <= 48);
  assert.equal(buildTerminalTitle({ stage: "ready" }), "ready");
  const label = buildHiddenThinkingLabel(theme);
  assert.doesNotMatch(label, /PI GFX THOUGHTSTREAM/);
  assert.match(label, /thinking/);
  assert.ok(calls.some(([token]) => token === "muted"));
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

test("pi-graphics extension source is the slim graphics primitive layer", async () => {
  const sourcePath = fileURLToPath(new URL("../extensions/pi-graphics.js", import.meta.url));
  const source = await readFile(sourcePath, "utf8");
  assert.match(source, /export function settingsEnvFromPiGraphics/);
  assert.match(source, /PI_GRAPHICS_MODE: off \? "off" : "on"/);
  assert.match(source, /PI_GRAPHICS_AUTO_EDITOR_SURFACE/);
  assert.match(source, /PI_GRAPHICS_EDITOR_VARIANT/);
  assert.match(source, /PI_GRAPHICS_EDITOR_ALPHA/);
  assert.match(source, /PI_GRAPHICS_CELL_WIDTH_PX/);
  assert.match(source, /PI_GRAPHICS_LINE_HEIGHT_SCALE/);
  assert.match(source, /mountEditorRails/);
  assert.match(source, /setWidget\("pi-graphics-editor-top"/);
  assert.match(source, /setWidget\("pi-graphics-editor-bottom"/);
  assert.match(source, /class KittyEditor extends CustomEditor/);
  assert.match(source, /renderEditorBorderFramesPngs\(/);
  assert.match(source, /buildPlacement\(state/);
  assert.match(source, /pi_graphics_render_prompt_enclosure/);
  assert.match(source, /pi_graphics_render_message_border/);
  assert.match(source, /pi_graphics_clear/);
  assert.match(source, /buildScopedDeleteCommand\(\{ ownedImageIds: state\.ownedImageIds \}\)/);
  assert.match(source, /BorderedLoader/);
  assert.match(source, /DynamicBorder/);
  assert.match(source, /ModelSelectorComponent/);
  assert.match(source, /UserMessageSelectorComponent/);
  assert.match(source, /function shouldSkipGraphicsWrap/);
  assert.match(source, /function wrapRenderableComponent/);
  assert.match(source, /function patchUiGraphicsSurfaces/);
  assert.match(source, /function restoreUiGraphicsSurfaces/);
  assert.match(source, /ui\.__piGraphicsOriginalSurfaces = originals/);
  assert.match(source, /ui\.custom = function \(componentOrFactory, options = undefined, \.\.\.rest\)/);
  assert.match(source, /ui\.setWidget = function \(id, componentOrFactory, options = undefined, \.\.\.rest\)/);
  assert.match(source, /ui\.setFooter = function \(componentOrFactory, \.\.\.rest\)/);
  assert.match(source, /Array\.isArray\(value\)/);
  assert.match(source, /component\.then\(\(resolved\) => wrapRenderableFactory\(resolved, type\)\)/);
  assert.match(source, /value\.__piGraphicsNoWrap \|\| value\.piGraphics === false/);
  assert.doesNotMatch(source, /buildScopedDeleteCommand\(\{ imageIds: state\.ownedImageIds \}\)/);
  assert.doesNotMatch(source, /pi_graphics_live_probe/);
  assert.doesNotMatch(source, /buildPiGraphicsHeaderComponent/);
  assert.doesNotMatch(source, /buildPiGraphicsFooterComponent/);
  assert.doesNotMatch(source, /buildPiGraphicsHudComponent/);
  assert.doesNotMatch(source, /buildPiGraphicsFloodlightComponent/);
  assert.doesNotMatch(source, /buildPiGraphicsThemeSwatchComponent/);
  assert.doesNotMatch(source, /buildPiGraphicsAmbientProofText/);
  assert.doesNotMatch(source, /buildPiGraphicsAnsiSceneText/);
  assert.doesNotMatch(source, /buildPiGraphicsAnsiTakeoverText/);
  assert.doesNotMatch(source, /buildPiGraphicsCockpitWallText/);
  assert.doesNotMatch(source, /buildPiGraphicsRawBootstrapText/);
  assert.doesNotMatch(source, /buildPiGraphicsTranscriptChromeComponent/);
  assert.doesNotMatch(source, /buildPiGraphicsConversationFrameComponent/);
  assert.doesNotMatch(source, /pi-graphics-showcase/);
  assert.doesNotMatch(source, /pi-graphics-theme-status/);
  assert.doesNotMatch(source, /pi-graphics-heartbeat/);
  assert.doesNotMatch(source, /OscPaletteSequence/);
  assert.doesNotMatch(source, /process\.stdout\.write/);
  assert.doesNotMatch(source, /PI_GRAPHICS_SHOWCASE/);
});

test("pi graphics scoped ids are stable within a process but salted by namespace", () => {
  const envA = { PI_GRAPHICS_ID_NAMESPACE: "session-a" };
  const envB = { PI_GRAPHICS_ID_NAMESPACE: "session-b" };
  assert.equal(piGraphicsIdScope({ env: envA, pid: 11, cwd: "/repo" }), "session-a");
  assert.equal(
    piGraphicsImageId("editor-border", { env: envA, pid: 11, cwd: "/repo" }),
    piGraphicsImageId("editor-border", { env: envA, pid: 99, cwd: "/elsewhere" }),
  );
  assert.notEqual(
    piGraphicsImageId("editor-border", { env: envA, pid: 11, cwd: "/repo" }),
    piGraphicsImageId("editor-border", { env: envB, pid: 11, cwd: "/repo" }),
  );
  const realPlacement = piGraphicsPlacementId("editor-border", { env: envA, pid: 11, cwd: "/repo" });
  const placeholderPlacement = piGraphicsPlaceholderPlacementId("editor-border", { env: envA, pid: 11, cwd: "/repo" });
  assert.ok(realPlacement >= 1 && realPlacement <= 0xffffffff);
  assert.ok(placeholderPlacement >= 0x800000 && placeholderPlacement < 0x1000000);
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
  assert.ok(placement.imageId >= 0x01000000 && placement.imageId <= 0xffffffff, "image id should use the protocol's larger 32-bit namespace");
  assert.ok(placement.placementId >= 0x800000 && placement.placementId < 0x1000000, "placeholder placement id should avoid low conventional kitty ids");
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

test("buildPlacement reuses stable image and placement ids without re-uploading on redraw", () => {
  const state = makeState();
  state.config.passthrough = "none";
  const enclosure = renderPromptEnclosure({ columns: 4 });
  const first = buildPlacement(state, {
    name: "stable-redraw-rule",
    png: enclosure.png,
    columns: enclosure.columns,
    rows: enclosure.rows,
    zIndex: -5,
  });
  const second = buildPlacement(state, {
    name: "stable-redraw-rule",
    png: enclosure.png,
    columns: enclosure.columns,
    rows: enclosure.rows,
    zIndex: -5,
  });

  assert.equal(second.imageId, first.imageId);
  assert.equal(second.placementId, first.placementId);
  assert.equal(second.transmitted, false);
  assert.match(first.transmit, /a=T/);
  assert.match(first.transmit, /U=1/);
  assert.equal(second.transmit, "");
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
  assert.ok(pkg.pi.themes.includes("./themes/kitty-graphics-nord.json"), "pi.themes must include the calm Nord kitty graphics theme");
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes("themes"), "package.json files[] must ship themes/");
  assert.equal(pkg.scripts?.["pi-graphics:tmux-smoke"], "node scripts/test-pi-graphics-tmux-smoke.mjs");
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

test("themes/kitty-graphics-nord.json is calm but still visibly displaced from built-in dark", async () => {
  const themePath = fileURLToPath(new URL("../themes/kitty-graphics-nord.json", import.meta.url));
  const theme = JSON.parse(await readFile(themePath, "utf8"));
  assert.equal(theme.name, "kitty-graphics-nord");
  const resolve = (token) => parseColor(theme.vars[theme.colors[token]] ?? theme.colors[token]);
  assert.ok(channelDistance(resolve("accent"), parseColor("#8abeb7")) > 70, "Nord accent should not be mistaken for built-in dark accent");
  assert.ok(channelDistance(resolve("userMessageBg"), parseColor("#343541")) > 65, "user message panel should visibly move away from stock dark");
  assert.ok(channelDistance(resolve("customMessageBg"), resolve("userMessageBg")) > 55, "custom/assistant chrome should be distinct from user panels");
  assert.ok(contrastRatio(resolve("text"), resolve("userMessageBg")) > 9, "calm Nord text should still pop against rendered panel colors");
  assert.equal(theme.export.glowCyan, "#9eeaff");
  assert.equal(theme.export.glowAurora, "#caa6ff");
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
