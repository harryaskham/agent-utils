import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import { createPreviewLifecycle } from "../extensions/kitty-image-preview/lifecycle.js";
import { showInKittyImagePreview } from "../extensions/kitty-image-preview/runtime.js";
import { getStreamDir } from "../extensions/kitty-image-preview/session-paths.js";
import preview from "../extensions/kitty-image-preview.js";

// Pi 0.84.4 guards the ctx.ui GETTER, not just UI methods. A non-null ctx and
// ctx?.ui?.setWidget() are still invalid after session_shutdown has returned.
function context(placement = "aboveEditor") {
  let stale = false;
  let staleAccesses = 0;
  const writes = [], widgets = [], notices = [];
  const terminal = { write: bytes => writes.push(bytes), columns: 100, rows: 30 };
  const tui = { terminal, requestRender() {} };
  const ui = {
    setStatus() {},
    setWidget(id, factory) { widgets.push({ id, factory }); if (typeof factory === "function") factory(tui, {}); },
    notify: text => notices.push(text),
  };
  const manager = { getBranch: () => [{ type: "message", message: {
    role: "toolResult", toolName: "kitty_image_preview_add", details: {
      kittyImagePreviewState: { visible: false, index: 0, items: [], ownedImageIds: [12345], config: { placement, passthrough: "none" } },
    },
  } }] };
  let registry;
  const ctx = {
    get cwd() { active(); return "/tmp"; },
    get hasUI() { active(); return true; },
    get ui() { active(); return ui; },
    get sessionManager() { active(); return manager; },
    get modelRegistry() { active(); return registry; },
    set modelRegistry(value) { registry = value; },
  };
  function active() {
    if (stale) { staleAccesses++; throw new Error("This extension ctx is stale after session replacement or reload"); }
  }
  return { ctx, ui, terminal, widgets, writes, notices, invalidate: () => { stale = true; }, staleAccesses: () => staleAccesses };
}

for (const placement of ["aboveEditor", "belowEditor", "rightOverlay"]) {
  test(`preview ${placement} shutdown leaves no UI callbacks using the old context`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const h = createStrictMockPi();
    preview(h.pi);
    const c = context(placement);
    await h.handlers.get("session_start")[0]({}, c.ctx);
    // Include both the startup flash and any shutdown flash, still pending
    // when Pi tears down this runtime and installs its successor.
    await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, c.ctx);
    assert.equal(c.writes.length, 1, "scoped GPU free is written synchronously during teardown");
    assert.match(c.writes[0], /d=I,i=12345/);
    assert.doesNotMatch(c.writes[0], /d=A/);
    c.invalidate();
    const calls = c.widgets.length;
    assert.doesNotThrow(() => t.mock.timers.tick(1000));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(c.staleAccesses(), 0);
    assert.equal(c.widgets.length, calls, "the retired generation must not clear a replacement widget");
  });
}

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDL+WQAAAABJRU5ErkJggg==", "base64");
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

for (const action of ["hide", "clear"]) {
  test(`pending ${action} timers cannot clear the successor preview`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const dir = await mkdtemp(path.join(os.tmpdir(), "preview-reload-"));
    const file = path.join(dir, "fixture.png");
    await writeFile(file, png);
    const h = createStrictMockPi(); preview(h.pi);
    const old = context();
    try {
      await h.handlers.get("session_start")[0]({}, old.ctx);
      await h.tools.get("kitty_image_preview_add").execute("add", { path: file, show: true, config: { placement: "aboveEditor", transferMode: "memory" } }, null, null, old.ctx);
      await h.commands.get(`image-${action}`).handler("", old.ctx);
      await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, old.ctx);
      old.invalidate();
      const next = createStrictMockPi(); preview(next.pi);
      const fresh = context();
      await next.handlers.get("session_start")[0]({ reason: "reload" }, fresh.ctx);
      await next.tools.get("kitty_image_preview_add").execute("new", { path: file, show: true, config: { placement: "aboveEditor" } }, null, null, fresh.ctx);
      const previousCalls = old.widgets.length;
      assert.doesNotThrow(() => t.mock.timers.tick(1000));
      await settle();
      assert.equal(old.staleAccesses(), 0);
      assert.equal(old.widgets.length, previousCalls);
      assert.equal(typeof fresh.widgets.at(-1).factory, "function", "new visible widget is not removed");
      await next.handlers.get("session_shutdown")[0]({}, fresh.ctx);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("late custom-UI rejection after shutdown does not notify through an invalid ctx", async () => {
  const h = createStrictMockPi(); preview(h.pi);
  const c = context("rightOverlay");
  const pending = deferred();
  let closes = 0;
  c.ui.custom = factory => {
    factory({ terminal: c.terminal, requestRender() {} }, {}, {}, () => { closes++; });
    return pending.promise;
  };
  await h.handlers.get("session_start")[0]({}, c.ctx);
  await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, c.ctx);
  c.invalidate();
  pending.reject(new Error("UI closed on reload"));
  await settle();
  assert.equal(c.staleAccesses(), 0);
  assert.equal(closes, 1, "flash UI is closed before the scope is invalidated");
});

test("in-flight runtime file handoff is retired on shutdown", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "preview-handoff-"));
  const file = path.join(dir, "frame.png"); await writeFile(file, png);
  const h = createStrictMockPi(); preview(h.pi);
  const c = context();
  try {
    await h.handlers.get("session_start")[0]({}, c.ctx);
    const pending = showInKittyImagePreview(h.pi, { path: file });
    await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, c.ctx);
    c.invalidate();
    assert.equal(await pending, null);
    assert.equal(c.staleAccesses(), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("in-flight Playwright capture is aborted and cannot publish or reschedule after reload", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const capture = deferred(), entered = deferred();
  let signal, execs = 0;
  const h = createStrictMockPi({ exec: (_cmd, _args, options) => {
    execs++; signal = options.signal; entered.resolve(); return capture.promise;
  } });
  preview(h.pi);
  const c = context();
  const dir = await mkdtemp(path.join(os.tmpdir(), "preview-stream-reload-"));
  c.ctx.sessionManager.getSessionFile = () => path.join(dir, `${path.basename(dir)}.jsonl`);
  const streamDir = getStreamDir(c.ctx);
  try {
    await h.handlers.get("session_start")[0]({}, c.ctx);
    const pending = h.tools.get("kitty_image_preview_playwright_start").execute("stream", { screenshotPath: path.join(dir, "missing.png"), autoScreenshot: true }, null, null, c.ctx);
    await entered.promise;
    await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, c.ctx);
    c.invalidate();
    assert.equal(signal.aborted, true);
    const calls = c.widgets.length;
    capture.resolve({ code: 0 }); // uncooperative late process completion
    await pending;
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(c.staleAccesses(), 0);
    assert.equal(c.widgets.length, calls);
    assert.equal(execs, 1, "no replacement capture scheduled");
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(streamDir, { recursive: true, force: true });
  }
});

test("preview scope cancels timers and invalidates already-dequeued work across generations", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const life = createPreviewLifecycle();
  const gate = deferred();
  let touched = 0;
  const isCurrent = life.capture();
  life.defer(async () => { await gate.promise; if (isCurrent()) touched++; }, 1);
  life.defer(() => { touched++; }, 100);
  assert.equal(life.pendingTimers, 2);
  t.mock.timers.tick(1);
  life.close();
  life.begin();
  gate.resolve(); await settle();
  t.mock.timers.tick(1000);
  assert.equal(touched, 0);
  assert.equal(life.pendingTimers, 0);
  const timer = life.defer(() => { touched++; }, 5);
  assert.equal(life.pendingTimers, 1);
  life.cancel(timer);
  assert.equal(life.pendingTimers, 0);
});

test("late stream description cannot publish status after shutdown", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = createStrictMockPi(); preview(h.pi);
  const c = context();
  const completion = deferred(), entered = deferred();
  let descriptionSignal;
  c.ctx.modelRegistry = {
    find: () => ({ provider: "fixture", id: "vision" }),
    complete: (_model, _input, options) => { descriptionSignal = options.signal; entered.resolve(); return completion.promise; },
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), "preview-description-reload-"));
  const file = path.join(dir, "frame.png"); await writeFile(file, png);
  c.ctx.sessionManager.getSessionFile = () => path.join(dir, `${path.basename(dir)}.jsonl`);
  const streamDir = getStreamDir(c.ctx);
  try {
    await h.handlers.get("session_start")[0]({}, c.ctx);
    await h.tools.get("kitty_image_preview_playwright_start").execute("stream", { screenshotPath: file, autoScreenshot: false, describe: true }, null, null, c.ctx);
    await entered.promise;
    await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, c.ctx);
    c.invalidate();
    assert.equal(descriptionSignal.aborted, true);
    completion.resolve({ content: [{ type: "text", text: "late fixture description" }] });
    await settle();
    t.mock.timers.tick(1000);
    assert.equal(c.staleAccesses(), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(streamDir, { recursive: true, force: true });
  }
});

for (const [tool, interval] of [["animate", 50], ["cycle", 1000]]) {
  test(`${tool} in-flight file preparation cannot notify a retired context`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const dir = await mkdtemp(path.join(os.tmpdir(), "preview-animate-reload-"));
    const first = path.join(dir, "first.png"), next = path.join(dir, "next.png");
    await writeFile(first, png); await writeFile(next, png);
    const h = createStrictMockPi(); preview(h.pi);
    const c = context();
    try {
      await h.handlers.get("session_start")[0]({}, c.ctx);
      for (const file of [first, next]) await h.tools.get("kitty_image_preview_add").execute("add", { path: file, config: { placement: "aboveEditor", transferMode: "memory" } }, null, null, c.ctx);
      await h.tools.get("kitty_image_preview_show").execute("first", { action: "first" }, null, null, c.ctx);
      await h.tools.get(`kitty_image_preview_${tool}`).execute("run", { action: "start", intervalMs: 50, intervalSeconds: 1 }, null, null, c.ctx);
      await rm(next);
      t.mock.timers.tick(interval); // file read now in flight and will reject
      await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, c.ctx);
      c.invalidate();
      const calls = c.widgets.length;
      // Drive asynchronous FS completions with a real file operation, not a
      // wall-clock sleep (the following timers must already be cancelled).
      await writeFile(next, png);
      await settle();
      t.mock.timers.tick(interval * 3);
      await settle();
      assert.equal(c.staleAccesses(), 0);
      assert.equal(c.widgets.length, calls);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test("actual Pi ExtensionRunner invalidation leaves preview shutdown quiescent", async t => {
  const { ExtensionRunner, createExtensionRuntime } = await import("@earendil-works/pi-coding-agent");
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const h = createStrictMockPi(); preview(h.pi);
  const c = context();
  const runner = new ExtensionRunner([], createExtensionRuntime(), "/tmp", c.ctx.sessionManager, {});
  runner.setUIContext(c.ui, "tui");
  const ctx = runner.createContext();
  await h.handlers.get("session_start")[0]({}, ctx);
  await h.handlers.get("session_shutdown")[0]({ reason: "reload" }, ctx);
  runner.invalidate();
  assert.throws(() => ctx.ui, /ctx is stale/, "use the real SDK guard, not only a fake");
  assert.doesNotThrow(() => t.mock.timers.tick(1000));
  await settle();
});
