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
    "image", "theme", "thinkingSelector", "tree", "userSelector", "agent", "mascot", "customTui", "overlay", "widget",
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
  const variants = ["glass", "aurora", "scanline", "circuit", "sparkle", "cloud"];
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
  const beforeResize = emitted.length;
  runtime.applyToRows({ type: "assistant", instanceId: 1, lines: ["first row wider", "second row wider", "third row wider"], renderWidth: 24 });
  const resizeCmds = emitted.slice(beforeResize).join("");
  assert.match(resizeCmds, /a=d,d=p/, "resized rows should delete stale relative placements before replacing them");
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

test("thinking assistant content uses cloudy thought chrome", () => {
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
  assert.ok(emitted.some((c) => /a=t,f=100,t=d/.test(c)), "cloud chrome should upload strips");
  assert.ok([...state.ownedImageIds].length >= 2, "cloud chrome should own strip and anchor images");
});

test("installBoxChromeMonkeyPatch is idempotent and wraps render", () => {
  class Fake {
    render() { return ["alpha", "beta"]; }
  }
  const emitted = [];
  const state = { ownedImageIds: new Set() };
  const runtime = createBoxChromeRuntime({
    emitGraphicsCommand: (c) => emitted.push(c),
    state,
    passthrough: "none",
    resolveTheme: () => ({ colorRgb: [136, 192, 208] }),
  });
  installBoxChromeMonkeyPatch({ components: { assistant: Fake }, runtime });
  installBoxChromeMonkeyPatch({ components: { assistant: Fake }, runtime });
  const instance = new Fake();
  const result = instance.render(20);
  assert.equal(result.length, 2);
  assert.notEqual(result[0], "alpha");
});
