// The client part of loop.mjs (bd-27804c's prototype), for pi-client: the focused session's
// loops as a status line, `⟳ 2 loops · #1 every 5m (next 3m) · #2 every 1h (next 42m)`, live.
// It follows loop.mjs's own document (agent-utils.loops) through pi-client's
// ctx.chord.watchDocument, so pi-daemon knows nothing of loops; /loop list and /loop stop stay
// loop.mjs's commands. In TUI Pi (no ctx.chord) it does nothing.
import { LOOPS_DOC, nextFireAt } from "../lib/durable-loop.js";
import { LOOPS_EVENT, LOOPS_REQUEST, liveLoopSchedules, shortDuration } from "../lib/loop-indicator.js";

export { shortDuration };

const STATUS = "agent-utils-loops";
/** Redraw the countdowns this often. */
export const LOOP_STATUS_TICK_MS = 30_000;

/** The live loops of a loops document, by number. */
export function liveLoops(doc) {
  return Object.entries(doc?.loops ?? {})
    .filter(([, loop]) => loop && !loop.stopped)
    .map(([number, loop]) => ({ number: Number(number), ...loop }))
    .sort((a, b) => a.number - b.number);
}

/** The status line for a loops document at `now`, or none without live loops. */
export function loopStatus(doc, now = Date.now()) {
  const loops = liveLoops(doc);
  if (loops.length === 0) return undefined;
  const parts = loops.map((loop) => {
    const intervalMs = Number(loop.intervalSecs) * 1000;
    const next = Number.isFinite(intervalMs) && intervalMs > 0 && Number.isFinite(loop.startedAt) ? nextFireAt(loop.startedAt, intervalMs, now) : undefined;
    return `#${loop.number} every ${shortDuration(intervalMs)}${next === undefined ? "" : ` (next ${shortDuration(next - now)})`}`;
  });
  return `⟳ ${loops.length} loop${loops.length === 1 ? "" : "s"} · ${parts.join(" · ")}`;
}

export default function loopClient(pi, { tickMs = LOOP_STATUS_TICK_MS, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval, maxSessions = 16 } = {}) {
  // Each followed session's loops: sessionId -> { doc, stop, stopped }, the oldest let go beyond
  // maxSessions. The focused session's always; others when a consumer (the editor chips, drawing
  // each pane) asks for them.
  const sessions = new Map();
  // The live ctx (pi-client's refers to the pane being drawn, else the focused one).
  let live;
  let focused;
  // A consumer draws the loops (a chip): no status line of our own.
  let consumer = false;
  let ticker;

  const sessionIdOf = (ctx) => {
    try {
      return ctx?.sessionManager?.getSessionId?.();
    } catch {
      return undefined;
    }
  };
  const publish = (sessionId) => pi.events?.emit?.(LOOPS_EVENT, { sessionId, loops: liveLoopSchedules(sessions.get(sessionId)?.doc) });
  const show = () => live?.ui?.setStatus?.(STATUS, consumer ? undefined : loopStatus(sessions.get(focused)?.doc ?? null, now()));

  // Follow a session's loops document; `ctx` refers to that session now (pi-client binds the
  // watch to the pane the ctx refers to when it is called).
  const follow = (ctx, sessionId) => {
    if (!sessionId || sessions.has(sessionId) || typeof ctx?.chord?.watchDocument !== "function") return;
    const entry = { doc: null, stop: undefined, stopped: false };
    sessions.set(sessionId, entry);
    while (sessions.size > maxSessions) {
      const [oldest, gone] = sessions.entries().next().value;
      sessions.delete(oldest);
      gone.stopped = true;
      gone.stop?.();
    }
    const { definition } = LOOPS_DOC;
    Promise.resolve(
      ctx.chord.watchDocument({ kind: definition.kind, version: definition.version, scope: definition.scope }, (value) => {
        if (entry.stopped) return;
        entry.doc = value;
        publish(sessionId);
        if (sessionId === focused) show();
      }),
    ).then(
      (stopper) => {
        if (entry.stopped) stopper?.();
        else entry.stop = stopper;
      },
      () => {
        if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
      },
    );
  };

  // A consumer asks for a session's loops while it draws that session's pane.
  pi.events?.on?.(LOOPS_REQUEST, (request) => {
    if (!consumer) {
      consumer = true;
      show();
    }
    const sessionId = request?.sessionId;
    if (!sessionId) return;
    if (sessions.has(sessionId)) return publish(sessionId);
    if (live !== undefined && sessionIdOf(live) === sessionId) follow(live, sessionId);
  });

  pi.on("session_start", (_event, ctx) => {
    if (typeof ctx?.chord?.watchDocument !== "function") return;
    live = ctx;
    focused = sessionIdOf(ctx);
    follow(ctx, focused);
    show();
    if (ticker === undefined) {
      ticker = setTimer(() => show(), tickMs);
      ticker?.unref?.();
    }
  });
  pi.on("session_shutdown", () => {
    for (const entry of sessions.values()) {
      entry.stopped = true;
      entry.stop?.();
    }
    sessions.clear();
    if (ticker !== undefined) clearTimer(ticker);
    ticker = undefined;
  });
}
