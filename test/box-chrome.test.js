import test from "node:test";
import assert from "node:assert/strict";

import {
  BOX_TYPE_EFFECTS,
  BOX_TYPE_THEME_TOKENS,
  createBoxChromeRuntime,
  installBoxChromeMonkeyPatch,
  renderBoxStripPng,
} from "../extensions/pi-graphics/box-chrome.js";

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
  const variants = ["glass", "aurora", "scanline", "circuit", "sparkle", "cloud", "facet", "prism", "veil", "scrim", "frost", "holo", "lattice", "contour", "folio", "manuscript", "tapestry", "weave", "tag", "badge", "glyph", "sextant", "compass", "terminal", "prompt", "rig", "schematic", "blueprint", "vine", "dendrite", "helix", "braid", "metronome", "shuttle", "hourglass", "signal", "halo", "caret", "bevel", "chamfer", "atelier", "constellation", "swatch", "palette", "satellite", "orbit", "emblem", "crest", "sigil", "rune", "workbench", "panel", "fold", "archive", "lantern", "ballot", "choice", "nebula", "ticker", "waveform", "masthead", "marquee", "ribbon", "logbook", "ledger", "lens", "aperture", "gauge", "dial", "console", "slider", "caliper", "tile", "mosaic", "portal", "keyring", "keystone"];
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
  assert.match(emitted.join(""), /(?:^|,)c=20(?:,|;)/, "relative chrome should use render width, not just content width");
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
  assert.match(resizeCmds, /a=d,d=p/, "resized rows should delete stale relative placements before replacing them");
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

test("relative box chrome leaves textual border rows unwrapped", () => {
  const emitted = [];
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state: { ownedImageIds: new Set() },
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  const border = "────────────────";
  const out = runtime.applyToRows({ type: "selector", instanceId: 80, lines: [border, " choice", border], renderWidth: 16 });
  assert.equal(out[0], border, "top textual border should not get a second graphical strip in the same row");
  assert.equal(out[2], border, "bottom textual border should not get a second graphical strip in the same row");
  assert.notEqual(out[1], " choice", "content row still gets side chrome");
  assert.ok(emitted.length > 0, "content row should still emit graphics");
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
