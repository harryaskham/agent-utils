// Session-owned request lifetimes, not a second playback queue. The daemon is
// authoritative for queue order/output. New daemon speech doesn't supersede
// earlier work unless interrupt=true; explicit cancel/dispose always aborts all
// owned requests and waits for their bounded remote cleanup.
export function speechReplacesPrevious(options = {}) {
  return options.provider !== "daemon" || options.playback === "local" || options.interrupt === true;
}

export function createSpeechRequests({ interruptPlayback = () => {}, maxPending = 64 } = {}) {
  const active = new Set();
  let latest = null;
  const cancel = ({ kind } = {}) => {
    const pending = [...active].filter(request => !kind || request.kind === kind);
    for (const request of pending) {
      request.controller.abort();
      try { request.cancelOwner?.(); } catch {}
    }
    if (!kind) { try { interruptPlayback(); } catch {} }
    return Promise.all(pending.map(request => request.done));
  };
  return {
    start(options = {}, { replace = speechReplacesPrevious(options) } = {}) {
      if (replace) void cancel();
      if (active.size >= maxPending) throw new Error("speech: too many pending requests; stop speech or wait for the daemon queue");
      const controller = new AbortController();
      let resolve;
      const request = { controller, cancelOwner: options.cancelOwner, kind: options.speechKind ?? String(options.streamName || "").replace(/^\//, ""), done: new Promise(done => { resolve = done; }) };
      active.add(request);
      latest = request;
      return {
        signal: controller.signal,
        isLatest: () => latest === request,
        finish() { active.delete(request); resolve(); },
      };
    },
    cancel,
    get size() { return active.size; },
  };
}
