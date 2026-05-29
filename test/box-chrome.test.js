import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_TYPE_EFFECTS,
  BOX_TYPE_THEME_TOKENS,
  createBoxChromeRuntime,
  installBoxChromeMonkeyPatch,
  renderBoxStripPng,
} from "../extensions/pi-graphics/box-chrome.js";
import { piGraphicsImageId } from "../extensions/pi-graphics/id-space.js";

test("renderBoxStripPng produces non-empty PNG for top/mid/bot kinds", () => {
  for (const kind of ["top", "mid", "bot"]) {
    const { png, widthPx, heightPx } = renderBoxStripPng({
      kind,
      columns: 40,
      cellWidthPx: 8,
      cellHeightPx: 16,
      color: [136, 192, 208],
    });
    assert.ok(png.length > 100, `${kind} png too small`);
    assert.equal(widthPx, 40 * 8);
    assert.equal(heightPx, 16);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  }
});

test("BOX_TYPE_THEME_TOKENS and effects cover all expected Pi TUI surface types", () => {
  for (const type of [
    "assistant", "tool", "bash", "user", "custom", "skill", "branch", "compaction", "footer", "thinking",
    "loader", "border", "input", "editor", "selector", "login", "model", "oauth", "session", "settings",
    "image", "theme", "thinkingSelector", "tree", "userSelector", "agent", "mascot", "customTui", "overlay", "widget", "header",
  ]) {
    assert.ok(BOX_TYPE_THEME_TOKENS[type], `missing token for ${type}`);
    assert.ok(BOX_TYPE_EFFECTS[type], `missing effect for ${type}`);
  }
});

test("box strip edges are directional", () => {
  const args = { columns: 3, cellWidthPx: 8, cellHeightPx: 16, color: [136, 192, 208], effect: "glass" };
  const top = renderBoxStripPng({ ...args, kind: "top" }).png.toString("base64");
  const bot = renderBoxStripPng({ ...args, kind: "bot" }).png.toString("base64");
  const left = renderBoxStripPng({ ...args, kind: "left" }).png.toString("base64");
  const right = renderBoxStripPng({ ...args, kind: "right" }).png.toString("base64");
  assert.notEqual(top, bot, "top and bottom caps should not be the same ribbon");
  assert.notEqual(left, right, "left and right side borders should be directional");
  assert.notEqual(top, left, "horizontal and vertical borders should differ");
});

test("renderBoxStripPng effect variants produce distinct graphics", () => {
  const variants = ["glass", "aurora", "scanline", "circuit", "sparkle", "cloud", "compose", "facet", "prism", "veil", "scrim", "frost", "holo", "lattice", "contour", "folio", "manuscript", "note", "tapestry", "weave", "tag", "badge", "glyph", "picker", "sextant", "compass", "shell", "terminal", "prompt", "rig", "schematic", "blueprint", "grove", "vine", "dendrite", "fork", "helix", "braid", "metronome", "shuttle", "hourglass", "signal", "halo", "margin", "caret", "frame", "bevel", "chamfer", "studio", "atelier", "constellation", "swatch", "palette", "beacon", "satellite", "orbit", "emblem", "crest", "recipe", "sigil", "rune", "workbench", "panel", "fold", "capsule", "archive", "candle", "lantern", "ballot", "choice", "nebula", "ticker", "waveform", "masthead", "marquee", "ribbon", "logbook", "ledger", "crop", "lens", "aperture", "gauge", "dial", "console", "slider", "caliper", "dashboard", "tile", "mosaic", "gate", "portal", "token", "keyring", "keystone"];
  const payloads = new Set(variants.map((effect) => renderBoxStripPng({
    kind: "mid",
    columns: 24,
    cellWidthPx: 8,
    cellHeightPx: 16,
    color: [136, 192, 208],
    effect,
  }).png.toString("base64")));
  assert.equal(payloads.size, variants.length);
});

test("createBoxChromeRuntime uploads strips once and wraps lines", () => {
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const lines = ["first row", "second row", "third row"];
  const out = runtime.applyToRows({ type: "assistant", instanceId: 1, lines, renderWidth: 20 });
  assert.equal(out.length, 3);
  assert.notEqual(out[0], lines[0]);
  assert.match(out[0], /first ro/, "box anchor replacement should preserve content while reclaiming one cell of width");
  assert.ok(emitted.some((c) => /a=t,f=100,t=d/.test(c)), "must upload strip + anchor");
  const placementIds = [...emitted.join("").matchAll(/(?:^|,)p=(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(placementIds.length >= 3, "must allocate anchor and relative placements");
  assert.ok(placementIds.some((id) => id >= 0x800000 && id < 0x1000000), "anchor placeholders should use high 24-bit underline IDs");
  assert.ok(placementIds.some((id) => id > 0x1000000), "relative placements should use the full 32-bit protocol range");
  const emittedText = emitted.join("");
  assert.match(emittedText, /(?:^|,)c=20(?:,|;)/, "relative chrome should use render width, not just content width");
  for (const [kind, row] of [["top", 0], ["mid", 1], ["bot", 2]]) {
    const expectedStripId = piGraphicsImageId(`box-strip-assistant-${kind}-folio-${row}-20-136,192,208-8x16`);
    assert.match(emittedText, new RegExp(`(?:^|,)i=${expectedStripId}(?:,|;)`), `relative chrome should upload a coherent ${kind} strip for row ${row}`);
  }
  assert.doesNotMatch(emittedText, /(?:^|,)H=-?\d+|(?:^|,)V=-?\d+/, "box strips are anchored at the placeholder origin and must not emit unnecessary H/V offsets");
  // Second pass with same instanceId/lines should reuse cached uploads (no new a=t).
  const emittedBeforeSecond = emitted.length;
  runtime.applyToRows({ type: "assistant", instanceId: 1, lines, renderWidth: 20 });
  const newCmds = emitted.slice(emittedBeforeSecond);
  assert.deepEqual(newCmds, [], "second render should not re-upload or re-place unchanged box chrome");
  runtime.resetCaches();
  const beforeResetRender = emitted.length;
  runtime.applyToRows({ type: "assistant", instanceId: 1, lines, renderWidth: 20 });
  const resetCmds = emitted.slice(beforeResetRender).join("");
  assert.match(resetCmds, /a=t,f=100,t=d/, "after scoped clear, box chrome must re-upload cached strip images");
  assert.match(resetCmds, /a=p/, "after scoped clear, box chrome must re-place anchors and relative strips");
  const beforeResize = emitted.length;
  runtime.applyToRows({ type: "assistant", instanceId: 1, lines: ["first row wider", "second row wider", "third row wider"], renderWidth: 24 });
  const resizeCmds = emitted.slice(beforeResize).join("");
  assert.match(resizeCmds, /a=d,d=i,i=\d+,p=\d+/, "resized rows should delete stale relative placements by image id plus placement id");
  assert.doesNotMatch(resizeCmds, /a=d,d=p/, "d=p is cell-intersection deletion in the Kitty protocol, not placement-id deletion");
});

test("relative box chrome reuses no-icon strip uploads after first three rows", () => {
  const emitted = [];
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const lines = Array.from({ length: 8 }, (_, i) => `row ${i}`);
  runtime.applyToRows({ type: "assistant", instanceId: 10, lines, renderWidth: 20 });
  const uploads = [...emitted.join("").matchAll(/a=t,f=100,t=d/g)];
  assert.equal(uploads.length, 13, "8 anchors plus 5 strip images: top, first two mids, shared later mid, and bottom form one coherent box");
});

test("box chrome caps oversized render widths before emitting kitty placements", () => {
  const emitted = [];
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  runtime.applyToRows({ type: "assistant", instanceId: 11, lines: ["short"], renderWidth: 2000 });
  assert.match(emitted.join(""), /(?:^|,)c=512(?:,|;)/, "kitty placements should be bounded even on huge render widths");
  assert.doesNotMatch(emitted.join(""), /(?:^|,)c=2000(?:,|;)/);
});

test("unicode box mode leaves render-width slack for padded containers", () => {
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: () => {},
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "settings", instanceId: 111, lines: ["x".repeat(10)], renderWidth: 12 });
  assert.ok(out[0].includes("\u{10eeee}"));
  assert.match(out[0], /x{8}/, "content should be reclaimed to leave side-border slack");
  assert.doesNotMatch(out[0], /x{10}/, "unicode wrapper must not preserve full content plus side borders when renderWidth includes container padding");
});

test("unicode box topLeft mode emits one anchor and no redundant right placeholder", () => {
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: () => {},
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    boxUnicodeMode: "topLeft",
    debugPlaceholders: true,
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "assistant", instanceId: 113, lines: ["hello"], renderWidth: 12 });
  const visible = out[0]
    .replace(/\x1b_G[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal((visible.match(/U/g) || []).length, 1, "topLeft mode should expose only one debug anchor cell");
  assert.match(visible, /^Uhell/);
});

test("unicode box mode clamps overwide content to render width hint", () => {
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: () => {},
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "assistant", instanceId: 112, lines: ["x".repeat(80)], renderWidth: 20 });
  const visible = out[0]
    .replace(/\x1b_G[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(visible, /x{18}/, "content should be truncated to the render-width hint with two side placeholders");
  assert.doesNotMatch(visible, /x{19}/, "unicode row must not exceed the render-width hint and wrap the right placeholder");
  assert.equal((visible.match(/\u{10eeee}/gu) || []).length, 2, "unicode row should keep only two side placeholders");
});

test("box chrome preserves ANSI controls while reclaiming one visible cell", () => {
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "assistant", instanceId: 4, lines: ["\x1b[31mfirst\x1b[0m"], renderWidth: 8 });
  assert.match(out[0], /^\x1b\[31m/);
  assert.match(out[0], /\u{10eeee}/u);
  assert.match(out[0], /firs\x1b\[0m$/, "trimming should remove a visible cell, not the reset sequence");
  assert.doesNotMatch(out[0], /\x1b\[[^m]*$/, "ANSI controls must not be truncated mid-sequence");
});

test("box chrome treats APC cursor markers and DCS controls as zero-width", () => {
  const emitted = [];
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const cursorMarker = "\x1b_cursor\x1b\\";
  const dcs = "\x1bP1$r q\x1b\\";
  const out = runtime.applyToRows({ type: "editor", instanceId: 12, lines: [`ab${cursorMarker}cd${dcs}ef`], renderWidth: 6 });
  assert.match(out[0], /ab\x1b_cursor\x1b\\cd\x1bP1\$r q\x1b\\/);
  assert.doesNotMatch(out[0], /ef/, "visible text should truncate while zero-width controls survive");
  assert.doesNotMatch(out[0], /\x1b[_P][^\x1b]*$/, "APC/DCS controls must not be truncated mid-sequence");
});

test("unicode box mode truncates and pads ANSI-styled rows without corrupting controls", () => {
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    boxMode: "unicode",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "selector", instanceId: 5, lines: ["\x1b[32mabcdef\x1b[0m"], renderWidth: 6 });
  assert.match(out[0], /\x1b\[32mabcd\x1b\[0m/);
  assert.match(out[0], /\u{10eeee}/u);
  assert.doesNotMatch(out[0], /ef/, "content should be truncated to leave room for side placeholders");
  assert.doesNotMatch(out[0], /\x1b\[[^m]*$/, "unicode truncation must not split ANSI controls");
});

test("relative box chrome wraps textual border rows as part of the same coherent box", () => {
  const emitted = [];
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const border = "────────────────";
  const out = runtime.applyToRows({ type: "selector", instanceId: 80, lines: [border, " choice", border], renderWidth: 16 });
  assert.notEqual(out[0], border, "top textual border should receive top chrome instead of being skipped");
  assert.notEqual(out[2], border, "bottom textual border should receive bottom chrome instead of being skipped");
  assert.notEqual(out[1], " choice", "content row still gets side chrome");
  const emittedText = emitted.join("");
  const topId = piGraphicsImageId("box-strip-selector-top-picker-0-16-136,192,208-8x16");
  const botId = piGraphicsImageId("box-strip-selector-bot-picker-2-16-136,192,208-8x16");
  assert.match(emittedText, new RegExp(`(?:^|,)i=${topId}(?:,|;)`), "top border row should use top strip art");
  assert.match(emittedText, new RegExp(`(?:^|,)i=${botId}(?:,|;)`), "bottom border row should use bottom strip art");
});

test("debug placeholder mode renders visible U cells with unique SGR ids", () => {
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: () => {},
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    debugPlaceholders: true,
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "assistant", instanceId: 81, lines: ["alpha", "beta"], renderWidth: 10 });
  assert.match(out[0], /\x1b\[38;2;\d+;\d+;\d+m\x1b\[58;2;\d+;\d+;\d+mU/);
  assert.doesNotMatch(out[0], /\u{10eeee}/u, "debug mode should make the placeholder visibly inspectable");
  assert.notEqual(out[0].match(/\x1b\[58;2;[^m]+m/)?.[0], out[1].match(/\x1b\[58;2;[^m]+m/)?.[0], "rows should expose distinct placement colors");
});

test("unicode box mode replaces border-only rows with full placeholder rows", () => {
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: () => {},
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    debugPlaceholders: true,
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const out = runtime.applyToRows({ type: "assistant", instanceId: 82, lines: ["────────", " Test ", "────────"], renderWidth: 10 });
  const visible = (line) => line
    .replace(/\x1b_G[\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.equal(visible(out[0]), "U".repeat(8), "top border row should be all placeholders in debug mode");
  assert.equal(visible(out[2]), "U".repeat(8), "bottom border row should be all placeholders in debug mode");
  assert.equal((visible(out[1]).match(/U/g) || []).length, 2, "content rows should keep only side placeholders");
  assert.doesNotMatch(visible(out[0]), /─/, "textual border glyphs should not remain on placeholder border rows");
});

test("box chrome does not double-wrap rows that already contain kitty placeholders", () => {
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const alreadyGraphical = "\u{10eeee} existing border";
  const out = runtime.applyToRows({ type: "border", instanceId: 8, lines: [alreadyGraphical], renderWidth: 40 });
  assert.deepEqual(out, [alreadyGraphical], "standalone DynamicBorder chrome should not be wrapped again by its parent");
  assert.deepEqual(emitted, [], "skipped placeholder rows should not allocate duplicate placements");
});

test("unicode box mode keeps line count and uses placeholder-only side borders", () => {
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    boxMode: "unicode",
    boxEffect: "cloud",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const lines = ["alpha", "beta", "gamma"];
  const out = runtime.applyToRows({ type: "assistant", instanceId: 3, lines });
  assert.equal(out.length, lines.length, "unicode mode should not create one-line boxes between content rows");
  assert.ok(out.every((line) => line.includes("\u{10eeee}")), "unicode mode should anchor borders with placeholder text");
  assert.ok(emitted.every((cmd) => !/P=/.test(cmd)), "unicode mode should not create non-placeholder relative placements");
});

test("unicode box mode reuses cell images across component instances", () => {
  const emitted = [];
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    boxEffect: "cloud",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const lines = ["alpha", "beta", "gamma"];
  runtime.applyToRows({ type: "assistant", instanceId: 3, lines });
  const beforeSecondInstance = emitted.length;
  runtime.applyToRows({ type: "assistant", instanceId: 4, lines });
  assert.deepEqual(emitted.slice(beforeSecondInstance), [], "identical unicode side cells should be keyed by pixels, not component instance id");
});

test("thinking assistant content uses dedicated thought chrome", () => {
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [180, 150, 230] }),
  });
  const component = { lastMessage: { content: [{ type: "thinking", thinking: "pondering" }] } };
  runtime.applyToRows({ type: "assistant", instanceId: 9, component, lines: [" thinking line", " still thinking"] });
  assert.ok(emitted.some((c) => /a=t,f=100,t=d/.test(c)), "thought chrome should upload strips");
  assert.ok([...state.ownedImageIds].length >= 2, "thought chrome should own strip and anchor images");
  assert.deepEqual(runtime.ownedImageIds(), state.boxChromeImageIds, "runtime should expose only tracked box chrome image ids for targeted cleanup");
});

test("installBoxChromeMonkeyPatch is idempotent, updates runtime, and restores safely", () => {
  class Fake {
    render() { return ["alpha", "beta"]; }
  }
  const emittedA = [];
  const runtimeA = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emittedA.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const installA = installBoxChromeMonkeyPatch({ components: { assistant: Fake }, runtime: runtimeA });
  const emittedB = [];
  const runtimeB = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emittedB.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    resolveTheme: () => ({ colorRgb: [180, 150, 230] }),
  });
  const installB = installBoxChromeMonkeyPatch({ components: { assistant: Fake }, runtime: runtimeB });
  const instance = new Fake();
  const result = instance.render(20);
  assert.equal(result.length, 2);
  assert.notEqual(result[0], "alpha");
  assert.equal(emittedA.length, 0, "reinstall should not keep using stale runtime");
  assert.ok(result[0].includes("\u{10eeee}"), "updated unicode runtime should render side placeholders");
  installA.restore();
  assert.notEqual(new Fake().render(20)[0], "alpha", "old restore should not remove newer runtime ownership");
  installB.restore();
  assert.deepEqual(new Fake().render(20), ["alpha", "beta"], "current restore should put original render back");
});

test("null-runtime box chrome install can scrub stale global prototype wrappers", () => {
  class Fake {
    render() { return ["alpha", "beta"]; }
  }
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: () => {},
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    boxMode: "unicode",
    resolveTheme: () => ({ colorRgb: [180, 150, 230] }),
  });
  installBoxChromeMonkeyPatch({ components: { assistant: Fake }, runtime });
  assert.ok(new Fake().render(20)[0].includes("\u{10eeee}"), "precondition: stale runtime emits placeholder borders");

  const scrub = installBoxChromeMonkeyPatch({ components: { assistant: Fake }, runtime: null });
  assert.deepEqual(new Fake().render(20), ["alpha", "beta"], "null runtime should immediately stop placeholder edge emission");
  scrub.restore();
  assert.deepEqual(new Fake().render(20), ["alpha", "beta"], "null-runtime restore should remove stale wrapper completely");
});
