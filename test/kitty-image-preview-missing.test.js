import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import preview from "../extensions/kitty-image-preview.js";
import { findMissingImages, removeMissingImages } from "../extensions/kitty-image-preview/files.js";
import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDL+WQAAAABJRU5ErkJggg==", "base64");
const settle = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, { placement = "aboveEditor", transferMode = "memory", snapshot } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "preview-missing-"));
  const h = createStrictMockPi(); preview(h.pi);
  const widgets = [], writes = [], notices = [], statuses = [];
  let state, stale = false, staleAccesses = 0;
  const terminal = { columns: 100, rows: 30, write: value => writes.push(value) };
  const tui = { terminal, requestRender() {} };
  const ui = {
    setWidget(id, factory) { widgets.push(factory); if (factory) { const component = factory(tui, {}); if (component.state) state = component.state; } },
    setStatus: (_id, value) => statuses.push(value), notify: value => notices.push(value),
  };
  const ctx = {
    cwd: dir, sessionManager: { getBranch: () => snapshot ? [{ type: "message", message: { role: "toolResult", toolName: "kitty_image_preview_add_folder", details: { kittyImagePreviewState: snapshot } } }] : [] },
    get hasUI() { if (stale) { staleAccesses++; throw new Error("stale ctx"); } return true; },
    get ui() { if (stale) { staleAccesses++; throw new Error("stale ctx"); } return ui; },
  };
  const call = (name, values = {}) => h.tools.get(`kitty_image_preview_${name}`).execute(name, values, null, null, ctx);
  const file = async name => { const p = path.join(dir, name + ".png"); await writeFile(p, png); return p; };
  const add = async name => { const p = await file(name); await call("add", { path: p, config: { placement, transferMode, passthrough: "none" } }); return p; };
  t.after(async () => { if (!stale) await h.handlers.get("session_shutdown")[0]({}, ctx); await rm(dir, { recursive: true, force: true }); });
  return { ...h, dir, ctx, ui, call, file, add, widgets, writes, notices, statuses, get state() { return state; }, retire: async () => { await h.handlers.get("session_shutdown")[0]({}, ctx); stale = true; }, staleAccesses: () => staleAccesses };
}

for (const placement of ["aboveEditor", "belowEditor", "rightOverlay"]) {
  for (const transferMode of ["file", "memory"]) {
    test(`missing current image is skipped and counters shrink (${placement}/${transferMode})`, async t => {
      const h = await setup(t, { placement, transferMode });
      const first = await h.add("first"); await h.add("middle"); await h.add("last");
      await h.call("show", { action: "first" });
      const removedId = h.state.items[0].id;
      await rm(first);
      const result = await h.call("show", { action: "current" });
      const s = result.details.kittyImagePreviewState;
      assert.equal(s.items.length, 2); assert.equal(s.index, 0); assert.match(s.items[0].path, /middle.png$/);
      assert.equal(s.visible, true); assert.equal(s.ownedImageIds.includes(removedId), false);
      assert.ok(h.writes.some(w => w.includes(`d=I,i=${removedId}`)), "free only owned missing data");
      assert.ok(h.writes.every(w => !w.includes("d=A")), "never global-clear other agents' graphics");
      assert.ok(!h.notices.some(n => n.includes("ENOENT")));
      const status = await h.call("status"); assert.equal(status.details.kittyImagePreviewState.items.length, 2);
    });
  }
}

test("restore filters old deleted paths before preparing, including a hidden gallery", async t => {
  const h = await setup(t);
  const keep = await h.file("survivor");
  for (const visible of [true, false]) {
    h.ctx.sessionManager.getBranch = () => [{ type: "message", message: { role: "toolResult", toolName: "kitty_image_preview_add_folder", details: { kittyImagePreviewState: {
      visible, index: 1, config: { placement: "aboveEditor", transferMode: "memory", passthrough: "none" },
      items: [{ id: 11, path: path.join(h.dir, "gone-1.png") }, { id: 12, path: keep }, { id: 13, path: path.join(h.dir, "gone-2.png") }], ownedImageIds: [11, 12, 13],
    } } } }];
    await h.handlers.get("session_start")[0]({}, h.ctx);
    const s = (await h.call("status")).details.kittyImagePreviewState;
    assert.equal(s.items.length, 1); assert.equal(s.items[0].path, keep); assert.equal(s.index, 0); assert.equal(s.visible, visible);
  }
  assert.ok(!h.notices.some(n => n.includes("restore failed")));
});

test("restoring an entirely cleaned-up gallery hides it without ENOENT or blank slots", async t => {
  const h = await setup(t, { snapshot: { visible: true, index: 1, config: { placement: "rightOverlay", transferMode: "file", passthrough: "none" },
    items: [{ id: 20, path: "/no-fixture-dir/gone.png" }, { id: 21, path: "/no-fixture-dir/also-gone.png" }], ownedImageIds: [20, 21, 22],
  } });
  await h.handlers.get("session_start")[0]({}, h.ctx);
  const state = (await h.call("status")).details.kittyImagePreviewState;
  assert.equal(state.visible, false); assert.deepEqual(state.items, []); assert.deepEqual(state.ownedImageIds, []);
  assert.equal(h.widgets.at(-1), undefined); assert.equal(h.statuses.at(-1), undefined);
  assert.ok(!h.notices.some(n => /ENOENT|restore failed/.test(n)));
});

test("navigation skips missing siblings in either direction", async t => {
  const h = await setup(t); await h.add("first"); const middle = await h.add("middle"); await h.add("last");
  await rm(middle);
  const previous = await h.call("show", { action: "previous" });
  assert.match(previous.details.kittyImagePreviewState.items[previous.details.kittyImagePreviewState.index].path, /first.png$/);
  const next = await h.call("show", { action: "next" });
  assert.match(next.details.kittyImagePreviewState.items[next.details.kittyImagePreviewState.index].path, /last.png$/);
});

test("all missing hides inline/side UI, drops payloads and stops animation/cycle", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await setup(t);
  const one = await h.add("one"), two = await h.add("two");
  await h.call("animate", { action: "start", intervalMs: 5000 });
  await h.call("cycle", { action: "start", intervalSeconds: 5 });
  await rm(one); await rm(two);
  const s = (await h.call("status")).details.kittyImagePreviewState;
  assert.equal(s.items.length, 0); assert.equal(s.visible, false); assert.equal(s.index, 0); assert.deepEqual(s.ownedImageIds, []);
  assert.equal(h.state.currentCommand, undefined); assert.equal(h.state.pagePrepared, undefined);
  assert.equal(h.state.animation.running, false); assert.equal(h.state.cycle.running, false);
  assert.equal(h.state.fileReconcileTimer, undefined); assert.equal(h.widgets.at(-1), undefined); assert.equal(h.statuses.at(-1), undefined);
});

test("idle visible gallery notices cleanup without navigation; shutdown cancels checks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = await setup(t), file = await h.add("clean-me");
  await rm(file); t.mock.timers.tick(2000);
  for (let i = 0; i < 100 && h.state.items.length; i++) await settle();
  assert.equal(h.state.items.length, 0); assert.equal(h.widgets.at(-1), undefined);
  await h.add("late");
  t.mock.timers.tick(2000); // check may already have started its asynchronous stat
  await h.retire(); t.mock.timers.tick(5000); await settle();
  assert.equal(h.staleAccesses(), 0);
});

test("removing every file closes the gallery overlay and does not resurrect visibility", async t => {
  const h = await setup(t), first = await h.add("first"), last = await h.add("last");
  let overlay;
  h.ui.custom = factory => new Promise(done => { overlay = factory({ terminal: { rows: 30, columns: 100, write() {} }, requestRender() {} }, {}, {}, done); });
  const opened = h.commands.get("image-overlay").handler("", h.ctx);
  while (!overlay) await settle();
  await rm(first); await rm(last);
  overlay.handleInput("\u001b[C"); await overlay.pending; await opened;
  assert.equal(h.state.visible, false); assert.equal(h.state.galleryOverlay, undefined);
  assert.equal(h.widgets.at(-1), undefined); assert.equal(h.statuses.at(-1), undefined);
});

test("sharing a deleted selection repairs the gallery but never shares a substitute", async t => {
  const h = await setup(t); await h.add("keep"); const selected = await h.add("gone");
  await rm(selected);
  const result = await h.call("share_current");
  assert.equal(result.details.shared, false); assert.ok(result.content.every(c => c.type === "text"));
  assert.equal(result.details.kittyImagePreviewState.items.length, 1);
});

test("stat is bounded, supports symlinks and doesn't confuse EACCES with missing", async t => {
  const h = await setup(t), keep = await h.file("keep");
  const link = path.join(h.dir, "link.png"), broken = path.join(h.dir, "broken.png"), directory = path.join(h.dir, "directory.png");
  await symlink(keep, link); await symlink(path.join(h.dir, "missing.png"), broken); await mkdir(directory);
  const missing = await findMissingImages([{ path: keep }, { path: link }, { path: broken }, { path: directory }]);
  assert.deepEqual(new Set(missing.map(x => x.path)), new Set([broken, directory]));
  let active = 0, high = 0;
  const result = await findMissingImages(Array.from({ length: 100 }, (_, i) => ({ path: String(i) })), { statImpl: async () => {
    active++; high = Math.max(high, active); await settle(); active--;
    throw Object.assign(new Error("not evidence of absence"), { code: "EACCES" });
  } });
  assert.deepEqual(result, []); assert.ok(high <= 8);
});

test("late stat cannot remove a replacement stream frame or disturb surviving selection", async () => {
  const a = { id: 1, path: "gone" }, b = { id: 2, path: "keep" }, replacement = { id: 1, path: "new-frame" };
  let release;
  const check = findMissingImages([a], { statImpl: () => new Promise((_ok, bad) => { release = () => bad(Object.assign(new Error("gone"), { code: "ENOENT" })); }) });
  const state = { items: [replacement, b], index: 1, visible: true, currentCommand: { itemId: 2 } };
  release(); const missing = await check;
  assert.deepEqual(removeMissingImages(state, missing), []); assert.equal(state.index, 1);
  state.items = [a, b];
  removeMissingImages(state, missing);
  assert.deepEqual(state.items, [b]); assert.equal(state.index, 0); assert.equal(state.currentCommand.itemId, 2);
});
