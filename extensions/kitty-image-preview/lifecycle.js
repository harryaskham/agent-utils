// Session-owned deferred preview work. Closing the scope invalidates callbacks
// BEFORE UI teardown, including work already dequeued/awaiting I/O. No retired
// callback may touch a captured Pi context, or clear a successor's widget.
export function createPreviewLifecycle() {
  let epoch = {};
  let active = true;
  const timers = new Set();
  const capture = () => {
    const owned = epoch;
    return () => active && epoch === owned;
  };
  const close = () => {
    active = false;
    epoch = {};
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  return {
    get active() { return active; },
    get pendingTimers() { return timers.size; },
    capture,
    close,
    cancel(timer) { clearTimeout(timer); timers.delete(timer); },
    begin() { close(); active = true; },
    defer(callback, delay, onError = () => {}) {
      if (!active) return undefined;
      const current = capture();
      const fail = error => { if (current()) { try { onError(error); } catch {} } };
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!current()) return;
        try { Promise.resolve(callback()).catch(fail); } catch (error) { fail(error); }
      }, delay);
      timers.add(timer);
      timer.unref?.();
      return timer;
    },
  };
}

export function previewIsActive(state) {
  return state.lifecycle?.active !== false;
}
export function previewEpoch(state) {
  return state.lifecycle?.capture() ?? (() => true);
}
export function deferPreviewUi(state, callback, delay) {
  return state.lifecycle.defer(callback, delay, error => {
    // UI-only diagnostics; do not throw outside Pi's awaited hook/tool boundary.
    state.lastUiError = String(error?.message || error).slice(0, 500);
  });
}
