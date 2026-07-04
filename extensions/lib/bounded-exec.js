// Shared "bounded external call" primitives (bd-6cf0d6 / bd-29a134). Any await
// on an external subprocess or HTTP request in agent code needs a bounded
// timeout, or a single stalled dependency silently wedges a user-facing loop
// with no error (the bd-adde03 local-vad hang: a stalled `stt --stdin` child
// never settled its Promise). This module is the ONE home for that timeout /
// kill / error-surface pattern so it is not re-implemented per call site:
//
//   * runBoundedSubprocess(...)  — spawn a one-shot subprocess, collect
//     stdout/stderr, and hard-bound the wait (SIGTERM -> unref'd SIGKILL grace).
//     Used by the batch STT (`stt --stdin`) and batch TTS (`tts`) paths.
//   * combineTimeoutSignal(...)  — a timeout-backed AbortController for fetch
//     that also forwards an incoming cancel and exposes isTimeout(). Used by the
//     web-search /responses fetch, the batch STT HTTP transcription, and the
//     direct-Azure TTS HTTP synthesis.
//
// Kept free of the extension entrypoint / typebox imports so the timeout logic
// is unit-testable without a live subprocess, socket, or the tool entrypoint.

import { spawn } from "node:child_process";

// Grace period between SIGTERM and the escalated SIGKILL for a stalled child.
export const DEFAULT_KILL_GRACE_MS = 2000;

/// Run a one-shot subprocess with bounded stdout/stderr collection and a hard
/// timeout. Resolves `{ code, stdout: Buffer, stderr: Buffer }` when the child
/// closes (the caller decides how to treat a non-zero `code`, since each surface
/// has its own "<label> exited N: <stderr>" message). Rejects when spawn throws,
/// on the child's `error` event, or on timeout — where it SIGTERMs the child and
/// then, after `killGraceMs`, escalates to SIGKILL via a standalone unref'd timer
/// (so it neither blocks the event loop nor is cancelled by the settle guard),
/// rejecting with "<label> timed out after <ms>ms". `spawnImpl` is injectable and
/// `onSpawn(proc)` runs after listeners/timer are attached (e.g. to write stdin).
export function runBoundedSubprocess({
  command,
  args = [],
  spawnImpl = spawn,
  stdio,
  timeoutMs,
  label = "subprocess",
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  onSpawn,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const timeout = Number(timeoutMs);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer != null) { clearTimer(timer); timer = null; }
      fn(arg);
    };

    let proc;
    try {
      proc = spawnImpl(command, args, stdio ? { stdio } : undefined);
    } catch (err) {
      reject(err);
      return;
    }

    const out = [];
    const err = [];
    proc.stdout?.on?.("data", (d) => out.push(Buffer.from(d)));
    proc.stderr?.on?.("data", (d) => err.push(Buffer.from(d)));
    proc.on?.("error", (e) => finish(reject, e));
    proc.on?.("close", (code) =>
      finish(resolve, { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
    );

    if (Number.isFinite(timeout) && timeout > 0) {
      timer = setTimer(() => {
        if (settled) return;
        try { proc.kill?.("SIGTERM"); } catch { /* best-effort */ }
        const kill = setTimer(() => { try { proc.kill?.("SIGKILL"); } catch { /* best-effort */ } }, killGraceMs);
        kill?.unref?.();
        finish(reject, new Error(`${label} timed out after ${timeout}ms`));
      }, timeout);
    }

    if (typeof onSpawn === "function") {
      try { onSpawn(proc); } catch (e) { finish(reject, e); }
    }
  });
}

// -------------------------------------------------------------------------
// HTTP: timeout-backed AbortController (moved here from web-search-http.js as the
// canonical home; web-search-http.js re-exports these for backward compat).
// -------------------------------------------------------------------------

export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/// Resolve a positive-integer timeout from an env string, else the fallback.
export function resolveRequestTimeoutMs(raw, fallback = DEFAULT_REQUEST_TIMEOUT_MS) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/// Bound an external HTTP await with a timeout while still honoring an incoming
/// cancellation signal: a stalled upstream must never wedge the caller with no
/// error. Returns a `signal` to pass to fetch, `isTimeout()` to discriminate a
/// timeout from a user cancel for the error message, and `cleanup()` to clear the
/// timer + listener. Timer/AbortController are injectable for tests.
export function combineTimeoutSignal(
  incoming,
  timeoutMs,
  { setTimer = setTimeout, clearTimer = clearTimeout, AbortCtl = AbortController } = {},
) {
  const controller = new AbortCtl();
  let timedOut = false;
  const onAbort = () => { try { controller.abort(); } catch { /* already aborted */ } };
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimer(() => { timedOut = true; onAbort(); }, timeoutMs)
    : null;
  if (incoming) {
    if (incoming.aborted) onAbort();
    else { try { incoming.addEventListener?.("abort", onAbort, { once: true }); } catch { /* best-effort */ } }
  }
  return {
    signal: controller.signal,
    isTimeout: () => timedOut,
    cleanup: () => {
      if (timer != null) { try { clearTimer(timer); } catch { /* best-effort */ } }
      try { incoming?.removeEventListener?.("abort", onAbort); } catch { /* best-effort */ }
    },
  };
}
