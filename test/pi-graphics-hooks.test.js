import test from "node:test";
import assert from "node:assert/strict";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import piGraphicsExtension from "../extensions/pi-graphics.js";

// pi.on hook-wiring coverage for pi-graphics.js (bd-e1a23d, follow-up to
// bd-aacc0c). The six lifecycle hooks — session_start, model_select,
// message_end, turn_end, session_compact, session_end — each run real editor /
// footer / box-chrome logic that only throws when the hook RUNS (bd-551e93
// lineage), so importing + activating the extension is not enough; the handlers
// must be driven.
//
// This is testable under bare `node --test` now that (1) the typebox `Type.*`
// schema surface uses the dependency-free ./lib/tool-schema.js shim, and (2) the
// `@earendil-works/pi-coding-agent` Component surface is loaded lazily inside the
// async activation factory instead of at the module top level. That host-runtime
// peer is NOT installed in the unit-test env, so the lazy import fails softly and
// the component-dependent branches (chat-spacing patch, KittyEditor, box-chrome
// monkeypatch) degrade to guarded no-ops — the hooks still fire cleanly.

// A graphics-safe ctx: `ui` exposes only the no-op surfaces the hooks touch, and
// it deliberately omits `write`/`terminal.write`, so resolveGraphicsWriter()
// returns null and NO kitty escape sequences are emitted into the node --test TAP
// stream. It also omits `setEditorComponent`, so installEditorSurface() early
// returns instead of constructing a KittyEditor from the (absent) CustomEditor.
function makeCtx() {
  return {
    ui: {
      setWidget() {},
      setStatus() {},
      setFooter() {},
      setWorkingIndicator() {},
      setWorkingMessage() {},
      getAllThemes() {
        return [];
      },
    },
  };
}

// Activation is async (the lazy pi-coding-agent import), so await the factory;
// pi awaits it before firing lifecycle hooks, so every pi.on registration below
// lands before session_start would in a live session.
async function activate() {
  const { pi, handlers } = createStrictMockPi();
  await piGraphicsExtension(pi);
  return { pi, handlers };
}

const LIFECYCLE_HOOKS = [
  "session_start",
  "model_select",
  "message_end",
  "turn_end",
  "session_compact",
  "session_end",
];

test("pi-graphics registers exactly one handler for each lifecycle hook", async () => {
  const { handlers } = await activate();
  for (const event of LIFECYCLE_HOOKS) {
    assert.equal(
      (handlers.get(event) || []).length,
      1,
      `expected exactly one ${event} hook to be registered`,
    );
  }
});

test("pi-graphics session_start hook fires without throwing (graphics-safe ctx)", async () => {
  const { handlers } = await activate();
  const [start] = handlers.get("session_start");
  // Heaviest hook: editor surface + box chrome + footer + working indicator.
  await assert.doesNotReject(
    async () => { await start({}, makeCtx()); },
    "session_start must not throw with a graphics-safe ctx",
  );
});

test("pi-graphics footer hooks fire without throwing (model_select/message_end/turn_end/session_compact)", async () => {
  const { handlers } = await activate();
  for (const event of ["model_select", "message_end", "turn_end", "session_compact"]) {
    const [fn] = handlers.get(event);
    await assert.doesNotReject(
      async () => { await fn({}, makeCtx()); },
      `${event} (refreshFooterState + installSegmentedFooter) must not throw`,
    );
  }
});

test("pi-graphics session_end hook fires without throwing (graphics-safe ctx)", async () => {
  const { handlers } = await activate();
  const [end] = handlers.get("session_end");
  // Teardown path: box-chrome restore, widget/footer clear, scoped graphics free.
  await assert.doesNotReject(
    async () => { await end({}, makeCtx()); },
    "session_end must not throw with a graphics-safe ctx",
  );
});
