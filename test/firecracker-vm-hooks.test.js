import test from "node:test";
import assert from "node:assert/strict";

import { createStrictMockPi } from "./helpers/strict-mock-pi.js";
import firecrackerVmExtension from "../extensions/firecracker-vm.js";

// pi.on hook-wiring coverage for firecracker-vm.js (bd-aacc0c, follow-up to
// bd-e3a282). A missing import / renamed symbol inside an event hook only
// throws when the hook RUNS; pure-helper coverage can't catch it (bd-551e93
// lineage). Firing the captured handler is the only thing that exercises the
// hook closure. This became testable once firecracker-vm.js dropped its direct
// `@sinclair/typebox` + `@earendil-works/pi-ai` imports for the tool-schema
// shim (so it now loads under bare `node --test`).

test("firecracker-vm registers a session_shutdown hook", () => {
  const { pi, handlers } = createStrictMockPi();
  firecrackerVmExtension(pi);
  const fns = handlers.get("session_shutdown") || [];
  assert.equal(fns.length, 1, "exactly one session_shutdown hook is registered");
  assert.equal(typeof fns[0], "function");
});

test("firecracker-vm session_shutdown hook fires without throwing (bd-aacc0c wiring)", async () => {
  const { pi, handlers } = createStrictMockPi();
  firecrackerVmExtension(pi);
  const [shutdown] = handlers.get("session_shutdown");
  // No VMs were started, so the teardown loop is empty — but the closure still
  // runs, catching any import/symbol regression in the hook body (e.g. a
  // renamed stopVm).
  await assert.doesNotReject(async () => { await shutdown({}, {}); }, "session_shutdown must not throw");
  // Idempotent: a second teardown (double shutdown) must also be safe.
  await assert.doesNotReject(async () => { await shutdown({}, {}); }, "repeat session_shutdown must not throw");
});
