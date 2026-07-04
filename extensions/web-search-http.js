// Bounded external-HTTP helpers for the web-search tool (bd-6cf0d6). Kept free of
// the @sinclair/typebox entrypoint dependency (like web-search-models.js) so the
// timeout logic is unit-testable without importing the tool entrypoint.

export const DEFAULT_REQUEST_TIMEOUT_MS = 120000;

/// Resolve a positive-integer timeout from an env string, else the fallback.
export function resolveRequestTimeoutMs(raw, fallback = DEFAULT_REQUEST_TIMEOUT_MS) {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/// Bound an external HTTP await with a timeout while still honoring an incoming
/// cancellation signal (bd-6cf0d6): a stalled upstream must never wedge the tool
/// with no error. Returns a `signal` to pass to fetch, `isTimeout()` to
/// discriminate a timeout from a user cancel for the error message, and
/// `cleanup()` to clear the timer + listener. Timer/AbortController are injectable
/// for tests.
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
