import test from "node:test";
import assert from "node:assert/strict";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import appAutomationExtension from "../extensions/app-automation.js";

// pi.on hook-wiring coverage for app-automation.js (bd-aacc0c, follow-up to
// bd-e3a282). The existing app-automation.test.js exercises extracted pure
// submodules; it never activates the extension or fires its hook, so a
// renamed/removed symbol inside session_shutdown (e.g. stopRefresh) would only
// throw live (bd-551e93 lineage). This drives the captured handler. Testable
// now that app-automation.js uses the tool-schema shim instead of a direct
// `@sinclair/typebox` import (loads under bare `node --test`).

test("app-automation registers a session_shutdown hook", () => {
  const { pi, handlers } = createStrictMockPi();
  appAutomationExtension(pi);
  const fns = handlers.get("session_shutdown") || [];
  assert.equal(fns.length, 1, "exactly one session_shutdown hook is registered");
  assert.equal(typeof fns[0], "function");
});

test("app-automation session_shutdown hook fires without throwing (bd-aacc0c wiring)", async () => {
  const { pi, handlers } = createStrictMockPi();
  appAutomationExtension(pi);
  const [shutdown] = handlers.get("session_shutdown");
  // No refreshers were started, so the stop loop is empty — but the closure
  // still runs, catching an import/symbol regression in the hook body.
  await assert.doesNotReject(async () => { await shutdown({}, {}); }, "session_shutdown must not throw");
  await assert.doesNotReject(async () => { await shutdown({}, {}); }, "repeat session_shutdown must not throw");
});
