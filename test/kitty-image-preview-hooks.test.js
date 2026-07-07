import test from "node:test";
import assert from "node:assert/strict";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import kittyImagePreviewExtension from "../extensions/kitty-image-preview.js";

// pi.on hook-wiring coverage for kitty-image-preview.js (bd-aacc0c, follow-up to
// bd-e3a282). session_start (cross-generation reclaim + transmit-guard reset)
// and session_shutdown (animation/cycle/stream teardown + owned-image free) each
// contain real logic that only throws when the hook RUNS (bd-551e93 lineage).
// This drives both handlers through their UI and headless branches. Testable now
// that the extension + its schema submodule use the tool-schema shim and the
// pi-ai `complete` import is lazy (loads under bare `node --test`).

// A representative ctx: no items/owned-ids are present on a fresh activation, so
// the hooks run their empty-state paths. `hasUI` selects the UI vs headless
// branch of the teardown.
function makeCtx(hasUI) {
  return {
    hasUI,
    sessionManager: { getBranch: () => [] },
    ui: { setStatus() {}, setWidget() {}, notify() {} },
  };
}

test("kitty-image-preview registers session_start and session_shutdown hooks", () => {
  const { pi, handlers } = createStrictMockPi();
  kittyImagePreviewExtension(pi);
  assert.equal((handlers.get("session_start") || []).length, 1, "one session_start hook");
  assert.equal((handlers.get("session_shutdown") || []).length, 1, "one session_shutdown hook");
});

test("kitty-image-preview session_start hook fires without throwing, UI and headless (bd-aacc0c wiring)", async () => {
  const { pi, handlers } = createStrictMockPi();
  kittyImagePreviewExtension(pi);
  const [start] = handlers.get("session_start");
  await assert.doesNotReject(async () => { await start({}, makeCtx(false)); }, "session_start (headless) must not throw");
  await assert.doesNotReject(async () => { await start({}, makeCtx(true)); }, "session_start (ui) must not throw");
});

test("kitty-image-preview session_shutdown hook fires without throwing, UI + headless + no-ctx (bd-aacc0c wiring)", async () => {
  const { pi, handlers } = createStrictMockPi();
  kittyImagePreviewExtension(pi);
  const [shutdown] = handlers.get("session_shutdown");
  await assert.doesNotReject(async () => { await shutdown({}, makeCtx(true)); }, "session_shutdown (ui) must not throw");
  // Headless teardown takes the runHeadlessOwnedFree branch instead of flashDeleteWidget.
  await assert.doesNotReject(async () => { await shutdown({}, makeCtx(false)); }, "session_shutdown (headless) must not throw");
  // Defensive: the hook guards on ctx?.hasUI, so a missing ctx must also be safe.
  await assert.doesNotReject(async () => { await shutdown({}, undefined); }, "session_shutdown (no ctx) must not throw");
});
