import test from "node:test";
import assert from "node:assert/strict";

import {
  FULLSCREEN_MODE_MIGRATIONS,
  FULLSCREEN_SHUTDOWN_EVENT,
  FULLSCREEN_SURFACE_CONTRACT,
  createSurfaceLeaseStack,
  fullscreenQuietModeViolations,
  resolveFullscreenEditorMode,
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
  const graphics = stack.acquire({ owner: "pi-graphics", priority: 20, decorate: (value) => `${value}|gfx` });
  const chips = stack.acquire({ owner: "editor-chips", priority: 10, decorate: (value) => `${value}|chips` });
  const modal = stack.acquire({ owner: "modal", priority: 30, decorate: (value) => `${value}|modal` });
  assert.deepEqual(stack.owners(), ["editor-chips", "pi-graphics", "modal"]);
  assert.equal(stack.compose(), "editor|chips|gfx|modal");
  assert.equal(stack.release(graphics), true);
  assert.equal(stack.compose(), "editor|chips|modal", "graphics off preserves independent decorators");
  assert.equal(stack.release(graphics), false, "repeat teardown cannot remove another lease");
  assert.equal(stack.release(modal), true);
  assert.equal(stack.compose(), "editor|chips");
  assert.equal(stack.clearOwner("editor-chips"), 1);
  assert.equal(stack.compose(), "editor");
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
