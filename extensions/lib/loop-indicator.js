// One cross-extension loops signal for pi-client: loop.mjs's client part (loop-client.js) follows
// sessions' loops documents and publishes each session's loops; the editor chips draw a loops
// chip from them for the session each pane shows. Plain data on Pi's event bus, per session.
import { nextFireAt } from "./durable-loop.js";

/** `{ sessionId, loops: [{ startedAt, intervalSecs }] }`: a session's live loops, now. */
export const LOOPS_EVENT = "agent-utils:loops.v1";
/** `{ sessionId }`: a consumer wants this session's loops (and is there to draw them). */
export const LOOPS_REQUEST = "agent-utils:loops-request.v1";

/** A loops document's live loops, as the event carries them. */
export function liveLoopSchedules(doc) {
  return Object.values(doc?.loops ?? {})
    .filter((loop) => loop && !loop.stopped && Number(loop.intervalSecs) > 0 && Number.isFinite(Number(loop.startedAt)))
    .map((loop) => ({ startedAt: Number(loop.startedAt), intervalSecs: Number(loop.intervalSecs) }));
}

/** How long until the soonest of `loops` fires, at `now`; undefined without loops. */
export function nextLoopIn(loops, now = Date.now()) {
  let soonest;
  for (const loop of loops ?? []) {
    const at = nextFireAt(loop.startedAt, loop.intervalSecs * 1000, now);
    if (soonest === undefined || at < soonest) soonest = at;
  }
  return soonest === undefined ? undefined : Math.max(0, soonest - now);
}

/** `5m`, `1h30m`, `45s`: a short duration. */
export function shortDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h${rest}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d${hours % 24}h`;
}
