// The client part of loop.mjs (bd-27804c's prototype), for pi-client: the focused session's
// loops as a status line, `⟳ 2 loops · #1 every 5m (next 3m) · #2 every 1h (next 42m)`, live.
// It follows loop.mjs's own document (agent-utils.loops) through pi-client's
// ctx.chord.watchDocument, so pi-daemon knows nothing of loops; /loop list and /loop stop stay
// loop.mjs's commands. In TUI Pi (no ctx.chord) it does nothing.
import { LOOPS_DOC, nextFireAt } from "../lib/durable-loop.js";

const STATUS = "agent-utils-loops";
/** Redraw the countdowns this often. */
export const LOOP_STATUS_TICK_MS = 30_000;

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

export default function loopClient(pi, { tickMs = LOOP_STATUS_TICK_MS, now = () => Date.now(), setTimer = setInterval, clearTimer = clearInterval } = {}) {
  let doc = null;
  let stop;
  let ticker;
  let generation = 0;

  const show = (ctx) => ctx.ui?.setStatus?.(STATUS, loopStatus(doc, now()));
  const quiet = () => {
    stop?.();
    stop = undefined;
    if (ticker !== undefined) clearTimer(ticker);
    ticker = undefined;
  };

  // Follow the loops of the session ctx refers to now (pi-client's focused pane).
  const follow = async (ctx) => {
    if (typeof ctx?.chord?.watchDocument !== "function") return;
    quiet();
    const mine = ++generation;
    doc = null;
    show(ctx);
    const { definition } = LOOPS_DOC;
    try {
      const stopper = await ctx.chord.watchDocument({ kind: definition.kind, version: definition.version, scope: definition.scope }, (value) => {
        if (mine !== generation) return;
        doc = value;
        show(ctx);
      });
      if (mine !== generation) return stopper();
      stop = stopper;
    } catch {
      return;
    }
    ticker = setTimer(() => show(ctx), tickMs);
    ticker?.unref?.();
  };

  pi.on("session_start", (_event, ctx) => follow(ctx));
  pi.on("session_shutdown", () => {
    generation += 1;
    quiet();
  });
}
