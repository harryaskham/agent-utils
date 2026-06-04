import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import xvfbExtension, { __xvfbTest } from "../extensions/xvfb.js";
import {
  xvfbCommandPath,
  displayInUse,
  pickFreeDisplay,
  buildXvfbArgs,
  planXvfb,
  spawnXvfb,
  xvfbPlanSummary,
  DEFAULT_XVFB_SCREEN,
  XVFB_DISPLAY_MIN,
} from "../extensions/lib/xvfb.js";

// ---------------------------------------------------------------------------
// Pure layer: display selection
// ---------------------------------------------------------------------------

test("pickFreeDisplay returns the configured minimum when nothing is in use", () => {
  const n = pickFreeDisplay({ fileExists: () => false });
  assert.equal(n, XVFB_DISPLAY_MIN);
});

test("pickFreeDisplay skips occupied display numbers", () => {
  // :99 and :100 occupied, :101 free.
  const occupied = new Set([99, 100]);
  const n = pickFreeDisplay({ fileExists: (num) => occupied.has(num) });
  assert.equal(n, 101);
});

test("pickFreeDisplay returns null when the whole range is occupied", () => {
  const n = pickFreeDisplay({ min: 99, max: 101, fileExists: () => true });
  assert.equal(n, null);
});

test("displayInUse reflects the injected probe", () => {
  assert.equal(displayInUse(99, () => true), true);
  assert.equal(displayInUse(99, () => false), false);
});

test("buildXvfbArgs encodes display, screen, and a non-listening server", () => {
  assert.deepEqual(buildXvfbArgs(99, { screen: "1280x720x24" }), [":99", "-screen", "0", "1280x720x24", "-nolisten", "tcp"]);
  assert.deepEqual(buildXvfbArgs(123), [":123", "-screen", "0", DEFAULT_XVFB_SCREEN, "-nolisten", "tcp"]);
});

// ---------------------------------------------------------------------------
// Pure layer: command resolution
// ---------------------------------------------------------------------------

test("xvfbCommandPath returns undefined for an empty command", () => {
  assert.equal(xvfbCommandPath("", { PATH: "/usr/bin" }), undefined);
});

test("xvfbCommandPath rejects an explicit non-executable path", () => {
  assert.equal(xvfbCommandPath("/nonexistent/Xvfb", {}), undefined);
});

// ---------------------------------------------------------------------------
// Pure layer: planXvfb policy gate
// ---------------------------------------------------------------------------

const headlessEnv = {}; // no DISPLAY / WAYLAND_DISPLAY
const resolveOk = () => "/usr/bin/Xvfb";
const noDisplaysInUse = () => false;

test("planXvfb refuses when a native display is already present", () => {
  const plan = planXvfb({
    env: { DISPLAY: ":0" },
    platform: "linux",
    resolveCommand: resolveOk,
    fileExists: noDisplaysInUse,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "display-present");
  assert.equal(plan.detection.kind, "native-display");
});

test("planXvfb refuses on macOS (always has a display)", () => {
  const plan = planXvfb({ env: {}, platform: "darwin", resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "display-present");
});

test("planXvfb with force overrides an existing display", () => {
  const plan = planXvfb({
    env: { DISPLAY: ":0" },
    platform: "linux",
    force: true,
    resolveCommand: resolveOk,
    fileExists: noDisplaysInUse,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.display, `:${XVFB_DISPLAY_MIN}`);
});

test("planXvfb refuses when Xvfb is not on PATH", () => {
  const plan = planXvfb({
    env: headlessEnv,
    platform: "linux",
    resolveCommand: () => undefined,
    fileExists: noDisplaysInUse,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "xvfb-missing");
});

test("planXvfb refuses when this session already owns a display", () => {
  const plan = planXvfb({ env: headlessEnv, platform: "linux", alreadySpawned: true, resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "already-spawned");
});

test("planXvfb refuses when no free display number remains", () => {
  const plan = planXvfb({
    env: headlessEnv,
    platform: "linux",
    resolveCommand: resolveOk,
    fileExists: () => true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "no-free-display");
});

test("planXvfb succeeds on a headless linux node with Xvfb available", () => {
  const plan = planXvfb({
    env: headlessEnv,
    platform: "linux",
    screen: "800x600x24",
    resolveCommand: resolveOk,
    fileExists: (num) => num === 99, // :99 taken -> picks :100
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.displayNumber, 100);
  assert.equal(plan.display, ":100");
  assert.equal(plan.command, "/usr/bin/Xvfb");
  assert.deepEqual(plan.args, [":100", "-screen", "0", "800x600x24", "-nolisten", "tcp"]);
});

test("xvfbPlanSummary describes both spawn and refusal outcomes", () => {
  const ok = planXvfb({ env: headlessEnv, platform: "linux", resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  assert.match(xvfbPlanSummary(ok), /spawn \/usr\/bin\/Xvfb :99 .*DISPLAY=:99/);
  const refused = planXvfb({ env: { DISPLAY: ":0" }, platform: "linux", resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  assert.match(xvfbPlanSummary(refused), /not started \(display-present\)/);
});

// ---------------------------------------------------------------------------
// spawnXvfb wrapper (injected spawn; no real Xvfb)
// ---------------------------------------------------------------------------

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = [];
    this.pid = 4321;
  }
  kill(signal) {
    this.killed.push(signal);
    // Simulate the process exiting on SIGTERM.
    if (signal === "SIGTERM") {
      this.exitCode = 0;
      queueMicrotask(() => this.emit("exit", 0, null));
    }
    return true;
  }
}

test("spawnXvfb throws unless given a successful plan", () => {
  assert.throws(() => spawnXvfb({ ok: false, reason: "xvfb-missing" }), /successful plan/);
});

test("spawnXvfb spawns the planned command and exports DISPLAY", () => {
  const plan = planXvfb({ env: headlessEnv, platform: "linux", resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  const env = {};
  let spawned = null;
  const child = new FakeChild();
  const handle = spawnXvfb(plan, {
    exportEnv: env,
    spawnImpl: (command, args, opts) => {
      spawned = { command, args, opts };
      return child;
    },
  });
  assert.equal(spawned.command, "/usr/bin/Xvfb");
  assert.deepEqual(spawned.args, [":99", "-screen", "0", DEFAULT_XVFB_SCREEN, "-nolisten", "tcp"]);
  assert.equal(env.DISPLAY, ":99");
  assert.equal(handle.display, ":99");
  assert.equal(handle.pid, 4321);
});

test("spawnXvfb stop() terminates the child and unsets DISPLAY, and is idempotent", async () => {
  const plan = planXvfb({ env: headlessEnv, platform: "linux", resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  const env = {};
  const child = new FakeChild();
  const handle = spawnXvfb(plan, { exportEnv: env, spawnImpl: () => child });
  assert.equal(env.DISPLAY, ":99");
  await handle.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
  assert.equal(env.DISPLAY, undefined);
  // Idempotent: a second stop is a no-op (no extra kill).
  await handle.stop();
  assert.deepEqual(child.killed, ["SIGTERM"]);
});

test("spawnXvfb stop() does not clobber a DISPLAY it does not own", async () => {
  const plan = planXvfb({ env: headlessEnv, platform: "linux", resolveCommand: resolveOk, fileExists: noDisplaysInUse });
  const env = { DISPLAY: ":7" }; // pre-existing, different display
  const child = new FakeChild();
  const handle = spawnXvfb(plan, { exportEnv: env, spawnImpl: () => child });
  // spawnXvfb overwrites with its own display.
  assert.equal(env.DISPLAY, ":99");
  // Manually simulate the env having been changed to something else before stop.
  env.DISPLAY = ":7";
  await handle.stop();
  assert.equal(env.DISPLAY, ":7");
});

// ---------------------------------------------------------------------------
// Extension tools (fake pi harness)
// ---------------------------------------------------------------------------

function makeHarness() {
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    on(event, handler) {
      const arr = handlers.get(event) || [];
      arr.push(handler);
      handlers.set(event, arr);
    },
    registerTool(def) { tools.set(def.name, def); },
  };
  return { pi, tools, handlers };
}

test("extension registers ensure/stop/status tools and a shutdown handler", () => {
  const { pi, tools, handlers } = makeHarness();
  xvfbExtension(pi);
  assert.ok(tools.has("xvfb_ensure"));
  assert.ok(tools.has("xvfb_stop"));
  assert.ok(tools.has("xvfb_status"));
  assert.ok((handlers.get("session_shutdown") || []).length >= 1);
});

test("xvfb_ensure dry-run reports a plan without spawning on a forced path", async () => {
  const { pi, tools } = makeHarness();
  xvfbExtension(pi);
  // force=true so the test does not depend on the host actually being headless.
  const result = await tools.get("xvfb_ensure").execute("t", { force: true, dryRun: true }, null, null, {});
  assert.equal(result.details.dryRun, true);
  assert.match(result.content[0].text, /\(dry-run\)/);
  assert.equal(result.details.xvfb, null);
});

test("xvfb_status reports display availability and no session display initially", async () => {
  const { pi, tools } = makeHarness();
  xvfbExtension(pi);
  const result = await tools.get("xvfb_status").execute("t", {}, null, null, {});
  assert.match(result.content[0].text, /display (available|MISSING)/);
  assert.match(result.content[0].text, /Session Xvfb: none\./);
  assert.equal(result.details.xvfb, null);
});

test("xvfb_stop reports nothing running when no display was started", async () => {
  const { pi, tools } = makeHarness();
  xvfbExtension(pi);
  const result = await tools.get("xvfb_stop").execute("t", {}, null, null, {});
  assert.match(result.content[0].text, /No session-owned Xvfb is running\./);
  assert.equal(result.details.xvfb, null);
});

test("__xvfbTest.publicHandle summarizes liveness from the child state", () => {
  assert.equal(__xvfbTest.publicHandle(null), null);
  const alive = __xvfbTest.publicHandle({ display: ":99", displayNumber: 99, pid: 1, child: { exitCode: null, signalCode: null } });
  assert.deepEqual(alive, { display: ":99", displayNumber: 99, pid: 1, alive: true });
  const dead = __xvfbTest.publicHandle({ display: ":99", displayNumber: 99, pid: 1, child: { exitCode: 0, signalCode: null } });
  assert.equal(dead.alive, false);
});
