import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { renderEditorBorderFrame } from "../extensions/pi-graphics/affordances.js";
import { composeEditorRenderRows } from "../extensions/pi-graphics/editor-render.js";
import { clampRenderedRowsToWidth } from "../extensions/pi-graphics/ansi-width.js";
import {
  createFullscreenResourceOwner,
  getOrCreateEditorChromeRegistry,
  resolveFullscreenDynamicPolicy,
  wrapEditorComponent,
} from "../extensions/pi-graphics/fullscreen-contract.js";

const CASES = [
  { name: "narrow-direct-nord", columns: 24, style: "gradient", color: "#88c0d0", glow: "#b48ead", tmux: false },
  { name: "wide-direct-nord", columns: 180, style: "glass", color: "#88c0d0", glow: "#b48ead", tmux: false },
  { name: "narrow-tmux-static", columns: 24, style: "chrome", color: "#a3be8c", glow: "#81a1c1", tmux: true },
  { name: "wide-tmux-static", columns: 180, style: "geometric", color: "#a3be8c", glow: "#81a1c1", tmux: true },
];

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

test("fullscreen visual matrix is deterministic across narrow/wide and theme/style cases", () => {
  const snapshots = CASES.map((entry) => {
    const options = {
      columns: entry.columns,
      rows: 2,
      edge: "top",
      style: entry.style,
      borderColor: entry.color,
      glowColor: entry.glow,
      cellWidthPx: 8,
      cellHeightPx: 19,
      context: "idle",
      phase: entry.tmux ? 0 : 0.25,
    };
    const first = renderEditorBorderFrame(options);
    const second = renderEditorBorderFrame(options);
    assert.equal(digest(first.pixels), digest(second.pixels), `${entry.name} is deterministic`);
    assert.equal(first.widthPx, entry.columns * 8);
    assert.equal(first.heightPx, 38);
    assert.equal(first.pixels.length, first.widthPx * first.heightPx * 4);
    return { name: entry.name, digest: digest(first.pixels), widthPx: first.widthPx };
  });
  assert.equal(new Set(snapshots.map((entry) => entry.digest)).size, CASES.length, "theme/style matrix produces distinct pixels");
  assert.ok(snapshots.find((entry) => entry.name === "wide-direct-nord").widthPx > snapshots.find((entry) => entry.name === "narrow-direct-nord").widthPx);
});

test("tmux/non-tmux matrix applies deterministic calm defaults and explicit opt-in", () => {
  assert.deepEqual(resolveFullscreenDynamicPolicy({ tmux: false }), {
    liveInTerminal: true,
    dynamic: true,
    animation: true,
    trailingWorkspace: true,
    rowBackground: true,
  });
  assert.deepEqual(resolveFullscreenDynamicPolicy({ tmux: true }), {
    liveInTerminal: false,
    dynamic: false,
    animation: false,
    trailingWorkspace: false,
    rowBackground: false,
  });
  assert.equal(resolveFullscreenDynamicPolicy({ tmux: true, liveEditor: true }).dynamic, true);
  assert.equal(resolveFullscreenDynamicPolicy({ tmux: true, dynamicInTmux: true, dynamic: false }).liveInTerminal, true);
  assert.equal(resolveFullscreenDynamicPolicy({ tmux: true, dynamicInTmux: true, dynamic: false }).dynamic, false);
});

test("fullscreen layout matrix stays bounded through narrow/wide resize", () => {
  for (const width of [20, 40, 120, 240]) {
    const rows = composeEditorRenderRows(["────────", "content that may be long", "────────"], {
      width,
      isDashLine: (line) => /^─+$/.test(line),
      buildBorderRow: (lineWidth, edge) => `${edge}:${"─".repeat(lineWidth)}`,
      decorateLine: (line) => `│${line}│`,
      clampRows: clampRenderedRowsToWidth,
    });
    assert.equal(rows.length, 3);
    assert.ok(rows.every((line) => line.length <= width), `all rows fit width ${width}`);
  }
});

test("theme invalidation and editor replacement preserve every owner exactly once", () => {
  let installed;
  let invalidations = 0;
  const ui = {
    setEditorComponent(factory) { installed = factory; },
    getEditorComponent() { return () => ({ render: () => ["base"], invalidate: () => { invalidations += 1; } }); },
  };
  const registry = getOrCreateEditorChromeRegistry(ui);
  const gfx = registry.acquire({ owner: "pi-graphics", priority: 10, decorate: (base) => wrapEditorComponent(base, { renderRows: (rows) => [...rows, "gfx"] }) });
  registry.acquire({ owner: "editor-chips", priority: 20, decorate: (base) => wrapEditorComponent(base, { renderRows: (rows) => [...rows, "chips"] }) });
  let component = installed();
  component.invalidate();
  assert.equal(invalidations, 1, "theme invalidation reaches the base once through both wrappers");
  assert.deepEqual(component.render(80), ["base", "gfx", "chips"]);

  ui.setEditorComponent(() => ({ render: () => ["modal"], invalidate: () => { invalidations += 1; } }));
  component = installed();
  assert.deepEqual(component.render(80), ["modal", "gfx", "chips"], "later modal editor becomes the base without clobbering chrome");
  registry.release(gfx);
  assert.deepEqual(installed().render(80), ["modal", "chips"], "graphics off preserves independent chrome");
});

test("reload and repeated on/off drain timers without duplicate callbacks", () => {
  let next = 0;
  const cleared = [];
  const owner = createFullscreenResourceOwner({
    setTimeoutImpl: (fn) => ({ id: ++next, kind: "timeout", fn, unref() {} }),
    clearTimeoutImpl: (timer) => cleared.push(timer.id),
    setIntervalImpl: (fn) => ({ id: ++next, kind: "interval", fn, unref() {} }),
    clearIntervalImpl: (timer) => cleared.push(timer.id),
  });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    owner.timeout(() => {}, 1);
    owner.interval(() => {}, 1);
    assert.deepEqual(owner.counts(), { timeouts: 1, intervals: 1 });
    assert.deepEqual(owner.drain(), { timeouts: 1, intervals: 1 });
    assert.deepEqual(owner.counts(), { timeouts: 0, intervals: 0 });
  }
  assert.deepEqual(owner.drain(), { timeouts: 0, intervals: 0 }, "reload teardown is idempotent");
  assert.equal(new Set(cleared).size, 6, "each owned handle is cleared exactly once");
});

test("source contract covers tmux calm defaults, scoped cleanup, and documented shutdown", async () => {
  const source = await readFile(fileURLToPath(new URL("../extensions/pi-graphics.js", import.meta.url)), "utf8");
  assert.match(source, /function tmuxLiveEditorGraphicsEnabled\(\)/);
  assert.match(source, /PI_GRAPHICS_TMUX_LIVE_EDITOR/);
  assert.match(source, /pi\.on\("session_shutdown"/);
  assert.doesNotMatch(source, /pi\.on\("session_end"/);
  assert.match(source, /buildScopedDeleteCommand\(\{ ownedImageIds: state\.ownedImageIds, freeData: true \}\)/);
  assert.match(source, /clearOwnedTimers\(\)/);
  assert.match(source, /releaseOwnedUiSurfaces\(ctx\)/);
});
