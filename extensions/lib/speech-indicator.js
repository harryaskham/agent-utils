// One cross-extension speech activity signal. realtime-agent publishes the
// state of /ptt, /stt and /rt microphone input; editor chips render it. Plain
// data only, emitted on Pi's per-session event bus — no process-global state.
export const SPEECH_INDICATOR_EVENT = "agent-utils:speech-indicator.v1";
export const SPEECH_INDICATOR_REQUEST = "agent-utils:speech-indicator-request.v1";
export const SPEECH_PHASES = Object.freeze(["disabled", "armed", "listening", "on-air", "transcribing", "sent", "muted", "error"]);
const SURFACES = new Set(["PTT", "STT", "RT", "NOTE"]);
const METER_INTERVAL_MS = 100;

const finite = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const oneLine = (value, max) => String(value ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, max);

export function normalizeSpeechIndicator(value = {}) {
  const phase = SPEECH_PHASES.includes(value.phase) ? value.phase : "disabled";
  const surface = SURFACES.has(value.surface) ? value.surface : "";
  if (phase === "disabled") return { version: 1, phase, surface: "", hint: "", meter: false, level: 0, db: null, transcribing: false, threshold: null };
  const meter = Boolean(value.meter);
  return {
    version: 1,
    phase,
    surface,
    hint: oneLine(value.hint, 24),
    meter,
    level: meter ? finite(value.level, 0, 1, 0) : 0,
    db: meter && value.db != null ? Math.round(finite(value.db, -90, 0, -90)) : null,
    threshold: meter && value.threshold != null ? finite(value.threshold, 0, 1, null) : null,
    transcribing: Boolean(value.transcribing),
  };
}

/// PCM RMS (0..1) -> dBFS, floored for silence so the label stays bounded.
export function rmsToDb(rms) {
  const value = Number(rms);
  return value > 0 && Number.isFinite(value) ? Math.max(-90, Math.min(0, 20 * Math.log10(value))) : -90;
}

const sameExceptMeter = (a, b) => a && b && a.phase === b.phase && a.surface === b.surface && a.hint === b.hint
  && a.meter === b.meter && a.transcribing === b.transcribing;

/// Producer. Phase changes publish immediately; meter-only changes coalesce to
/// one update per interval with a trailing write. `fallback(state, consumed)`
/// renders locally when no chip consumer accepted the current state.
export function createSpeechIndicatorPublisher(pi, { fallback = () => {}, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, intervalMs = METER_INTERVAL_MS } = {}) {
  const bus = pi?.events;
  let state = normalizeSpeechIndicator();
  let lastEmit = -Infinity, timer = null, closed = false, announced = false;
  const emit = () => {
    if (closed) return false;
    clearTimer(timer); timer = null;
    lastEmit = now();
    announced = true;
    let consumed = false;
    try { bus?.emit?.(SPEECH_INDICATOR_EVENT, { ...state, accept() { consumed = true; } }); } catch {}
    try { fallback(state, consumed); } catch {}
    return consumed;
  };
  const onRequest = () => { if (!closed) emit(); };
  const off = bus?.on?.(SPEECH_INDICATOR_REQUEST, onRequest);
  return {
    get state() { return state; },
    publish(value) {
      if (closed) return;
      const next = normalizeSpeechIndicator(value);
      if (!announced) { state = next; return void emit(); }
      const meterOnly = sameExceptMeter(state, next);
      if (meterOnly && next.level === state.level && next.db === state.db && next.threshold === state.threshold) return;
      state = next;
      if (!meterOnly) return void emit();
      const wait = intervalMs - (now() - lastEmit);
      if (wait <= 0) return void emit();
      if (!timer) { timer = setTimer(() => { timer = null; emit(); }, wait); timer?.unref?.(); }
    },
    dispose() {
      if (closed) return;
      state = normalizeSpeechIndicator();
      emit();
      closed = true;
      clearTimer(timer); timer = null;
      try { typeof off === "function" ? off() : bus?.off?.(SPEECH_INDICATOR_REQUEST, onRequest); } catch {}
    },
  };
}

/// Consumer. `accept()` claims rendering so the producer skips its fallback.
export function subscribeSpeechIndicator(pi, onState, { accept = () => true } = {}) {
  const bus = pi?.events;
  if (typeof bus?.on !== "function") return () => {};
  const handler = (value) => {
    if (!value || value.version !== 1) return;
    if (accept()) { try { value.accept?.(); } catch {} }
    onState(normalizeSpeechIndicator(value));
  };
  const off = bus.on(SPEECH_INDICATOR_EVENT, handler);
  try { bus.emit?.(SPEECH_INDICATOR_REQUEST, { version: 1 }); } catch {}
  return () => { try { typeof off === "function" ? off() : bus.off?.(SPEECH_INDICATOR_EVENT, handler); } catch {} };
}
