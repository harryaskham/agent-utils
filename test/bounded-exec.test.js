import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  runBoundedSubprocess,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveRequestTimeoutMs,
  combineTimeoutSignal,
} from "../extensions/lib/bounded-exec.js";

// Fake child: stdout/stderr EventEmitters, records kill signals, optionally emits
// close on the next microtask (after runBoundedSubprocess attaches its listeners).
function fakeChild({ stdout = "", stderr = "", exitCode = 0, autoClose = true } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: () => {} };
  proc.killed = [];
  proc.kill = (sig) => { proc.killed.push(sig); return true; };
  if (autoClose) {
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    });
  }
  return proc;
}

test("runBoundedSubprocess resolves { code, stdout, stderr } on close and runs onSpawn", async () => {
  const proc = fakeChild({ stdout: "hello", stderr: "warn", exitCode: 0 });
  let onSpawnProc = null;
  const res = await runBoundedSubprocess({
    command: "x",
    args: ["a"],
    spawnImpl: () => proc,
    stdio: ["pipe", "pipe", "pipe"],
    onSpawn: (p) => { onSpawnProc = p; },
  });
  assert.equal(res.code, 0);
  assert.equal(res.stdout.toString(), "hello");
  assert.equal(res.stderr.toString(), "warn");
  assert.ok(Buffer.isBuffer(res.stdout) && Buffer.isBuffer(res.stderr));
  assert.equal(onSpawnProc, proc, "onSpawn receives the spawned proc after listeners attach");
});

test("runBoundedSubprocess resolves a non-zero code (caller decides how to treat it)", async () => {
  const proc = fakeChild({ stderr: "boom", exitCode: 3 });
  const res = await runBoundedSubprocess({ command: "x", spawnImpl: () => proc });
  assert.equal(res.code, 3);
  assert.equal(res.stderr.toString(), "boom");
});

test("runBoundedSubprocess rejects when spawn itself throws", async () => {
  const spawnImpl = () => { throw new Error("spawn ENOENT"); };
  await assert.rejects(runBoundedSubprocess({ command: "x", spawnImpl }), /spawn ENOENT/);
});

test("runBoundedSubprocess rejects on the child 'error' event", async () => {
  const proc = fakeChild({ autoClose: false });
  queueMicrotask(() => proc.emit("error", new Error("child boom")));
  await assert.rejects(runBoundedSubprocess({ command: "x", spawnImpl: () => proc }), /child boom/);
});

test("runBoundedSubprocess rejects if onSpawn throws (e.g. stdin write fails)", async () => {
  const proc = fakeChild({ autoClose: false });
  await assert.rejects(
    runBoundedSubprocess({ command: "x", spawnImpl: () => proc, onSpawn: () => { throw new Error("stdin gone"); } }),
    /stdin gone/,
  );
});

test("runBoundedSubprocess times out a stalled child: SIGTERM then SIGKILL after the grace, rejects", async () => {
  const proc = fakeChild({ autoClose: false }); // never emits close -> would hang without the timeout
  const timers = [];
  const setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length - 1; };
  const clearTimer = () => {};
  const p = runBoundedSubprocess({
    command: "x",
    spawnImpl: () => proc,
    timeoutMs: 100,
    label: "tts",
    setTimer,
    clearTimer,
  });
  assert.equal(timers.length, 1, "main timeout timer scheduled");
  assert.equal(timers[0].ms, 100);
  timers[0].fn(); // fire the timeout -> SIGTERM, schedule SIGKILL, reject
  await assert.rejects(p, /tts timed out after 100ms/);
  assert.deepEqual(proc.killed, ["SIGTERM"]);
  assert.equal(timers.length, 2, "SIGKILL escalation timer scheduled");
  assert.equal(timers[1].ms, DEFAULT_KILL_GRACE_MS);
  timers[1].fn(); // fire the grace -> SIGKILL
  assert.deepEqual(proc.killed, ["SIGTERM", "SIGKILL"]);
});

test("runBoundedSubprocess schedules no timer when timeoutMs is non-positive", async () => {
  const proc = fakeChild({ exitCode: 0 });
  let scheduled = 0;
  const setTimer = (fn, ms) => { scheduled++; return setTimeout(fn, ms); };
  const res = await runBoundedSubprocess({ command: "x", spawnImpl: () => proc, timeoutMs: 0, setTimer });
  assert.equal(res.code, 0);
  assert.equal(scheduled, 0, "no timeout timer scheduled when the timeout is disabled");
});

test("bounded-exec is the canonical home for the HTTP timeout helper too", () => {
  assert.equal(typeof combineTimeoutSignal, "function");
  assert.equal(resolveRequestTimeoutMs("", 5000), 5000);
  assert.equal(resolveRequestTimeoutMs("250"), 250);
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 120000);
});
