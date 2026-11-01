// Visual thoughts: one painting budget for a whole process (a pi-daemon worker's sessions, a
// pi-client's panes). Paintings take a turn: at most `concurrent` at once and `perMinute` started
// in any minute, first come first served (each session queues at most one, so sessions alternate).
// A rate limit, a server error or a dropped connection pauses everyone: the provider is struggling,
// not one session (15 s doubling to 5 min; a rate limit's own reset when it gives one).

const TRANSIENT = /\bHTTP 5\d\d\b|terminated|fetch failed|socket|ECONN|ETIMEDOUT|EAI_AGAIN|network|timed? ?out|timeout/i;

/** Whether a painting failure says the provider (or the way to it) is struggling. */
export function isTransientPaintError(error) {
  if (error?.name === "ImageRateLimitError" || error?.name === "TimeoutError" || Number.isFinite(error?.retryAfterMs)) return true;
  return TRANSIENT.test(`${error?.message || ""} ${error?.cause?.code || ""} ${error?.cause?.message || ""}`);
}

export function createPaintBudget({
  concurrent = 1,
  perMinute = 4,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
} = {}) {
  const limits = { concurrent, perMinute };
  const waiting = [];
  const started = [];
  let active = 0;
  let pausedUntil = 0;
  let failures = 0;
  let timer = null;

  function wake(ms) {
    if (timer) return;
    timer = timers.setTimeout(() => { timer = null; pump(); }, Math.max(20, ms));
    timer?.unref?.();
  }

  function pump() {
    while (waiting.length && active < Math.max(1, limits.concurrent)) {
      const at = now();
      while (started.length && at - started[0] >= 60_000) started.shift();
      const wait = Math.max(pausedUntil - at, started.length >= Math.max(1, limits.perMinute) ? started[0] + 60_000 - at : 0);
      if (wait > 0) return wake(wait);
      const entry = waiting.shift();
      entry.cleanup?.();
      active += 1;
      started.push(at);
      let released = false;
      entry.resolve(() => {
        if (released) return;
        released = true;
        active -= 1;
        pump();
      });
    }
  }

  return {
    /** Wait for a turn; resolves to `release()`. Rejects if `signal` aborts first. */
    acquire(signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
        const entry = { resolve };
        if (signal) {
          const onAbort = () => {
            const index = waiting.indexOf(entry);
            if (index >= 0) waiting.splice(index, 1);
            reject(signal.reason ?? new Error("aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.cleanup = () => signal.removeEventListener("abort", onAbort);
        }
        waiting.push(entry);
        pump();
      });
    },
    /** The provider is struggling: everyone waits (`retryAfterMs` when it said how long). */
    failed(retryAfterMs) {
      failures += 1;
      const ms = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? retryAfterMs : Math.min(300_000, 15_000 * 2 ** (failures - 1));
      pausedUntil = Math.max(pausedUntil, now() + ms);
    },
    succeeded() { failures = 0; },
    configure({ concurrent: nextConcurrent, perMinute: nextPerMinute } = {}) {
      if (Number.isFinite(nextConcurrent)) limits.concurrent = nextConcurrent;
      if (Number.isFinite(nextPerMinute)) limits.perMinute = nextPerMinute;
      pump();
    },
    status() {
      const at = now();
      return {
        active,
        waiting: waiting.length,
        lastMinute: started.filter((time) => at - time < 60_000).length,
        pausedMs: Math.max(0, pausedUntil - at),
        ...limits,
      };
    },
  };
}
