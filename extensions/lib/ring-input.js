// Ring input adapter primitives (bd-8b3005).
//
// The physical-ring daemon is external. The adapter uses only `ring get` as a
// smart client over its daemon-owned event log, then maps semantic ring events
// onto the generic choice input-action bus.

import { INPUT_ACTIONS } from "./input-actions.js";

export const DEFAULT_RING_INPUT_EVENT_MAP = Object.freeze({
  [INPUT_ACTIONS.SELECT_PREVIOUS]: Object.freeze(["event-ring-ccw", "scroll-up", "previous", "prev", "left"]),
  [INPUT_ACTIONS.SELECT_NEXT]: Object.freeze(["event-ring-cw", "scroll-down", "next", "right"]),
  [INPUT_ACTIONS.CHOOSE_CURRENT]: Object.freeze(["event-ring-select", "yes", "select", "confirm"]),
  [INPUT_ACTIONS.CANCEL]: Object.freeze(["event-ring-cancel", "no", "cancel", "back"]),
});

function normalizeName(value) {
  return String(value ?? "").trim().toLowerCase().replaceAll("_", "-");
}

function normalizeList(value, fallback = []) {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const out = raw.map(normalizeName).filter(Boolean);
  return [...new Set(out.length ? out : fallback.map(normalizeName).filter(Boolean))];
}

export function resolveRingInputEventMap(config = {}, env = process.env) {
  return {
    [INPUT_ACTIONS.SELECT_PREVIOUS]: normalizeList(
      config[INPUT_ACTIONS.SELECT_PREVIOUS] ?? config.previous ?? env.PI_RING_CHOICE_PREVIOUS_EVENTS,
      DEFAULT_RING_INPUT_EVENT_MAP[INPUT_ACTIONS.SELECT_PREVIOUS],
    ),
    [INPUT_ACTIONS.SELECT_NEXT]: normalizeList(
      config[INPUT_ACTIONS.SELECT_NEXT] ?? config.next ?? env.PI_RING_CHOICE_NEXT_EVENTS,
      DEFAULT_RING_INPUT_EVENT_MAP[INPUT_ACTIONS.SELECT_NEXT],
    ),
    [INPUT_ACTIONS.CHOOSE_CURRENT]: normalizeList(
      config[INPUT_ACTIONS.CHOOSE_CURRENT] ?? config.select ?? env.PI_RING_CHOICE_SELECT_EVENTS,
      DEFAULT_RING_INPUT_EVENT_MAP[INPUT_ACTIONS.CHOOSE_CURRENT],
    ),
    [INPUT_ACTIONS.CANCEL]: normalizeList(
      config[INPUT_ACTIONS.CANCEL] ?? config.cancel ?? env.PI_RING_CHOICE_CANCEL_EVENTS,
      DEFAULT_RING_INPUT_EVENT_MAP[INPUT_ACTIONS.CANCEL],
    ),
  };
}

export function parseRingInputLine(line) {
  const raw = String(line ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const event = normalizeName(parsed?.event ?? parsed?.name ?? parsed?.payload?.event ?? parsed?.payload?.gesture);
    if (!event) return null;
    return {
      event,
      ts: parsed?.ts ?? parsed?.timestamp ?? null,
      source: parsed?.source ?? null,
      ring: parsed?.ring ?? null,
      payload: parsed?.payload ?? null,
      raw: parsed,
    };
  } catch {
    if (/^[a-z0-9_.-]+$/i.test(raw)) return { event: normalizeName(raw), ts: null, source: null, ring: null, payload: null, raw };
    return null;
  }
}

export function ringEventToInputAction(eventLike, eventMap = resolveRingInputEventMap()) {
  const event = normalizeName(typeof eventLike === "string" ? eventLike : eventLike?.event);
  if (!event) return null;
  for (const action of [
    INPUT_ACTIONS.SELECT_PREVIOUS,
    INPUT_ACTIONS.SELECT_NEXT,
    INPUT_ACTIONS.CHOOSE_CURRENT,
    INPUT_ACTIONS.CANCEL,
  ]) {
    if (eventMap[action]?.includes(event)) {
      return { action, source: "ring", raw: eventLike?.raw ?? eventLike, ring: eventLike?.ring ?? null, event };
    }
  }
  return null;
}

export function buildRingInputArgs({ eventMap = resolveRingInputEventMap(), timeoutMs = 30_000 } = {}) {
  const events = [...new Set(Object.values(eventMap).flat())];
  const timeout = Math.max(1, Math.trunc(Number(timeoutMs) || 30_000));
  return [
    "get",
    "--events", events.join(","),
    "--count", "100000",
    "--timeout-ms", String(timeout),
    "--after", "now",
    "--format", "json",
  ];
}
