import test from "node:test";
import assert from "node:assert/strict";

import {
  FULLSCREEN_MODE_MIGRATIONS,
  FULLSCREEN_SHUTDOWN_EVENT,
  FULLSCREEN_SURFACE_CONTRACT,
  createFullscreenResourceOwner,
  createSurfaceLeaseStack,
  fullscreenQuietModeViolations,
  getOrCreateEditorChromeRegistry,
  resolveFullscreenEditorMode,
  wrapEditorComponent,
} from "../extensions/pi-graphics/fullscreen-contract.js";

test("fullscreen contract uses Pi's supported shutdown event and declares every singleton/resource owner", () => {
  assert.equal(FULLSCREEN_SHUTDOWN_EVENT, "session_shutdown");
  assert.deepEqual(Object.keys(FULLSCREEN_SURFACE_CONTRACT).sort(), [
    "editor", "footer", "hardwareCursor", "header", "kittyImage", "kittyPlacement", "timer", "widget", "workingIndicator", "workingMessage",
  ]);
  assert.equal(FULLSCREEN_SURFACE_CONTRACT.editor.ownership, "lease-stack");
  assert.equal(FULLSCREEN_SURFACE_CONTRACT.widget.ownership, "namespaced-id");
  assert.equal(FULLSCREEN_SURFACE_CONTRACT.kittyImage.ownership, "scoped-id");
});

test("surface leases compose deterministically and release only the exact owner lease", () => {
  const stack = createSurfaceLeaseStack("editor");
  const graphics = stack.acquire({ owner: "pi-graphics", priority: 10, decorate: (value) => `${value}|gfx` });
  const chips = stack.acquire({ owner: "editor-chips", priority: 20, decorate: (value) => `${value}|chips` });
  const modal = stack.acquire({ owner: "modal", priority: 30, decorate: (value) => `${value}|modal` });
  assert.deepEqual(stack.owners(), ["pi-graphics", "editor-chips", "modal"]);
  assert.equal(stack.compose(), "editor|gfx|chips|modal");
  assert.equal(stack.release(graphics), true);
  assert.equal(stack.compose(), "editor|chips|modal", "graphics off preserves independent decorators");
  assert.equal(stack.release(graphics), false, "repeat teardown cannot remove another lease");
  assert.equal(stack.release(modal), true);
  assert.equal(stack.compose(), "editor|chips");
  assert.equal(stack.clearOwner("editor-chips"), 1);
  assert.equal(stack.compose(), "editor");
});

test("shared editor registry preserves later base owners and releases only one decorator", () => {
  let installed = null;
  const defaultFactory = () => ({ value: "default", render: () => ["default"], handleInput() {} });
  const ui = {
    setEditorComponent(factory) { installed = factory; },
    getEditorComponent() { return null; },
  };
  const registry = getOrCreateEditorChromeRegistry(ui, { defaultFactory });
  const gfx = registry.acquire({ owner: "pi-graphics", priority: 10, decorate: (base) => wrapEditorComponent(base, { renderRows: (rows) => [...rows, "gfx"] }) });
  const chips = registry.acquire({ owner: "editor-chips", priority: 20, decorate: (base) => wrapEditorComponent(base, { renderRows: (rows) => [...rows, "chips"] }) });
  assert.deepEqual(installed().render(80), ["default", "gfx", "chips"]);

  const replacement = () => ({ value: "modal", render: () => ["modal"], handleInput() {} });
  ui.setEditorComponent(replacement);
  assert.equal(ui.getEditorComponent(), replacement, "other extensions see and replace the undecorated base factory");
  assert.deepEqual(installed().render(80), ["modal", "gfx", "chips"], "registered chrome composes around a later editor owner");
  assert.equal(registry.release(gfx), true);
  assert.deepEqual(installed().render(80), ["modal", "chips"], "gfx off leaves editor chips and the replacement base alive");
  assert.equal(registry.release(chips), true);
  assert.deepEqual(installed().render(80), ["modal"]);
});

test("editor component wrapper delegates host methods, focus, input, invalidate, and dispose", () => {
  const calls = [];
  const base = {
    focused: false,
    render: () => ["base"],
    handleInput: (data) => calls.push(["input", data]),
    invalidate: () => calls.push(["invalidate"]),
    dispose: () => calls.push(["dispose"]),
    getText: () => "text",
  };
  const wrapped = wrapEditorComponent(base, { renderRows: (rows, width) => [...rows, `width=${width}`] });
  wrapped.focused = true;
  wrapped.handleInput("x");
  wrapped.invalidate();
  wrapped.dispose();
  assert.equal(base.focused, true);
  assert.equal(wrapped.getText(), "text");
  assert.deepEqual(wrapped.render(42), ["base", "width=42"]);
  assert.deepEqual(calls, [["input", "x"], ["invalidate"], ["dispose"]]);
});

test("resource owner drains timeout and interval handles idempotently", () => {
  const cleared = [];
  let next = 1;
  const callbacks = new Map();
  const owner = createFullscreenResourceOwner({
    setTimeoutImpl(fn) { const id = `t${next++}`; callbacks.set(id, fn); return id; },
    clearTimeoutImpl(id) { cleared.push(["timeout", id]); callbacks.delete(id); },
    setIntervalImpl(fn) { const id = `i${next++}`; callbacks.set(id, fn); return id; },
    clearIntervalImpl(id) { cleared.push(["interval", id]); callbacks.delete(id); },
  });
  const timeout = owner.timeout(() => {}, 1);
  owner.interval(() => {}, 1);
  assert.deepEqual(owner.counts(), { timeouts: 1, intervals: 1 });
  assert.equal(owner.clear(timeout), true);
  assert.deepEqual(owner.drain(), { timeouts: 0, intervals: 1 });
  assert.deepEqual(owner.drain(), { timeouts: 0, intervals: 0 });
  assert.deepEqual(cleared, [["timeout", "t1"], ["interval", "i2"]]);
});

test("legacy editor modes have explicit deterministic fullscreen migrations", () => {
  assert.deepEqual(resolveFullscreenEditorMode("joinedUnicode"), {
    input: "joinedunicode",
    style: "unicode",
    unicodeMode: "topLeft",
    deprecated: true,
    warning: "deprecated editor mode 'joinedunicode' maps to 'unicode'",
  });
  assert.deepEqual(resolveFullscreenEditorMode("animated"), {
    input: "animated",
    style: "relative",
    animation: true,
    deprecated: true,
    warning: "deprecated editor mode 'animated' maps to 'relative'",
  });
  assert.equal(resolveFullscreenEditorMode("relative").warning, null);
  assert.equal(resolveFullscreenEditorMode("unknown").style, "static");
  assert.equal(FULLSCREEN_MODE_MIGRATIONS.placeholder.deprecated, true);
});

test("quiet-mode audit reports every residual graphics-owned resource", () => {
  assert.deepEqual(fullscreenQuietModeViolations({}), []);
  assert.deepEqual(
    fullscreenQuietModeViolations({
      editor: true,
      footer: null,
      widget: new Set(["pi-graphics-editor-top"]),
      kittyImage: new Set([1]),
      timer: [],
    }),
    ["editor", "widget", "kittyImage"],
  );
});
