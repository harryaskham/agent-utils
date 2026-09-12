import test from "node:test";
import assert from "node:assert/strict";
import { KittyImageGalleryOverlay, imageOverlayKey } from "../extensions/kitty-image-preview/overlay.js";
import { syncWidget } from "../extensions/kitty-image-preview.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
function state() {
  return {
    visible: true, index: 0,
    items: [{ id: 123, label: "landscape.png", width: 800, height: 400 }],
    config: { placement: "auto", placementId: 1, passthrough: "none", placementMode: "unicode", columns: 48, minRows: 4, maxRows: 24 },
    currentCommand: { itemId: 123, transport: "memory", pngBase64: png, passthrough: "none" },
  };
}

test("overlay handles left/right and escape across terminal keyboard protocols", () => {
  for (const key of ["\x1b[D", "\x1bOD", "\x1b[57350u", "\x1b[1;1:2D"]) assert.equal(imageOverlayKey(key), "previous");
  for (const key of ["\x1b[C", "\x1bOC", "\x1b[57351u"]) assert.equal(imageOverlayKey(key), "next");
  for (const key of ["\x1b", "\x1b[27u"]) assert.equal(imageOverlayKey(key), "close");
  for (const key of ["\x1b[27;1:3u", "\x1b[200~\x1b[C\x1b[201~", "x", "\x1b[1;5C"]) assert.equal(imageOverlayKey(key), null);
});

test("overlay bounds image geometry on small and resized viewports", () => {
  const owner = state();
  owner.galleryOverlay = {};
  const tui = { terminal: { rows: 30 }, requestRender() {} };
  const component = new KittyImageGalleryOverlay(owner, { tui, close() {}, navigate() {} });
  const lines = component.render(80);
  assert.match(lines[0], /1\/1  landscape.png/);
  assert.match(lines.join("\n"), /a=T/);
  assert.ok(lines.length <= 27);
  assert.match(component.render(80).join("\n"), /a=p/);
  tui.terminal.rows = 8;
  assert.ok(component.render(15).length <= 7);
  tui.terminal.rows = 2;
  assert.equal(component.render(2).length, 1);
});

test("Escape closes immediately during navigation and consumes further input", async () => {
  let release, closed = 0, moves = 0;
  const component = new KittyImageGalleryOverlay(state(), {
    tui: { requestRender() {} }, close: () => closed++,
    navigate: () => { moves++; return new Promise(resolve => { release = resolve; }); },
  });
  component.handleInput("\x1b[C");
  await Promise.resolve();
  component.handleInput("\x1b");
  component.handleInput("\x1b[D");
  assert.equal(closed, 1);
  assert.equal(moves, 1);
  release();
  await component.pending;
});

test("fullscreen discovery mounts a real widget and settles custom UI waiting span", async () => {
  const owner = state();
  const widgets = [];
  let settled = 0;
  const tui = { terminal: { columns: 80, rows: 30 }, setLayoutRoot() {}, requestRender() {} };
  const ctx = { hasUI: true, ui: {
    setWidget: (_id, factory) => widgets.push(factory), setStatus() {},
    custom: (factory, options) => new Promise(resolve => {
      const component = factory(tui, {}, {}, () => { settled++; component.dispose(); resolve(); });
      options.onHandle?.({ unfocus() {}, hide() {} });
    }),
  } };
  syncWidget(ctx, owner);
  await Promise.resolve();
  assert.equal(settled, 1);
  assert.equal(owner.fullscreenTui, true);
  assert.equal(typeof widgets.at(-1), "function");
  assert.ok(widgets.at(-1)().render(80).some(line => line.includes("a=T")));
});
