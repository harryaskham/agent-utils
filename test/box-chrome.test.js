import test from "node:test";
import assert from "node:assert/strict";

import {
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

test("BOX_TYPE_THEME_TOKENS covers all expected types", () => {
  for (const type of ["assistant", "tool", "bash", "user", "custom", "skill", "branch", "compaction", "footer"]) {
    assert.ok(BOX_TYPE_THEME_TOKENS[type], `missing token for ${type}`);
  }
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
  const out = runtime.applyToRows({ type: "assistant", instanceId: 1, lines });
  assert.equal(out.length, 3);
  assert.notEqual(out[0], lines[0]);
  assert.ok(emitted.some((c) => /a=t,f=100,t=d/.test(c)), "must upload strip + anchor");
  // Second pass with same instanceId/lines should reuse cached uploads (no new a=t).
  const emittedBeforeSecond = emitted.length;
  runtime.applyToRows({ type: "assistant", instanceId: 1, lines });
  const newCmds = emitted.slice(emittedBeforeSecond);
  assert.ok(newCmds.every((c) => !/a=t,f=100,t=d/.test(c)), "no re-upload on second render");
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
