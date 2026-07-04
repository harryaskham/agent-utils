// Color-coded PTT/VAD state indicator (bd-081267): a terminal-native ANSI
// truecolor "bar" (a colored underline of the input box) plus a short label that
// reflects the live transcription state, with brief flashes on chunk-complete and
// turn-commit. Truecolor is emitted directly (no Pi-internal theme dependency), so
// it renders in any 24-bit terminal and never fights the pi-graphics editor border.
//
// The flash lifecycle (timers) is fully injectable so it is unit-testable without
// a live terminal; the visual polish (exact hues, flash duration) is meant to be
// tuned against a live session.

const RESET = "\x1b[0m";

/// Wrap `text` in a 24-bit truecolor foreground SGR. `rgb` is [r,g,b] 0..255.
export function ansiFg(rgb, text) {
  const [r, g, b] = rgb;
  return `\x1b[38;2;${r | 0};${g | 0};${b | 0}m${text}${RESET}`;
}

// Steady state + flash colors, per the bd-081267 spec.
export const PTT_COLORS = {
  listening: [255, 165, 0],    // orange  — actively listening / recording
  transcribing: [199, 21, 133], // magenta — transcribing audio
  idle: [120, 120, 120],        // neutral — not capturing
  chunk: [235, 203, 60],        // yellow  — a transcription chunk completed (flash)
  commit: [80, 200, 120],       // green   — turn committed / sent (flash)
};

const STATE = {
  listening: { color: PTT_COLORS.listening, label: "🎤 listening" },
  transcribing: { color: PTT_COLORS.transcribing, label: "✍️  transcribing" },
  idle: { color: PTT_COLORS.idle, label: "• idle" },
};
const FLASH = {
  chunk: { color: PTT_COLORS.chunk, label: "◆ chunk" },
  commit: { color: PTT_COLORS.commit, label: "✔ sent" },
};

/// Map a raw controller state onto a steady indicator style. Unknown/terminal
/// states collapse to idle; the controller's `transcribing-final` and `held`
/// are handled by the caller (final -> transcribing steady, held -> chunk flash).
export function pttStateStyle(state) {
  if (state === "listening") return { key: "listening", ...STATE.listening };
  if (state === "transcribing" || state === "transcribing-final") return { key: "transcribing", ...STATE.transcribing };
  return { key: "idle", ...STATE.idle };
}

/// Map a flash event (chunk|commit) onto a flash style, or null.
export function pttFlashStyle(event) {
  return FLASH[event] ? { key: event, ...FLASH[event] } : null;
}

/// Render the indicator: a full-width colored underline of the input box plus the
/// state/flash label, as an array of widget lines.
export function renderPttIndicator(style, width = 40) {
  const w = Math.max(4, Math.min(240, (width | 0) || 40));
  const bar = "▁".repeat(w);
  return [ansiFg(style.color, bar), ansiFg(style.color, style.label)];
}

/// Stateful indicator: holds a steady state, and shows transient flashes that
/// revert to the steady state after `flashMs`. Timers are injectable for tests.
export function makePttIndicator({
  render,
  width = 40,
  flashMs = 320,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let stateKey = "idle";
  let flashHandle = null;

  const draw = (style) => { try { render(renderPttIndicator(style, width)); } catch { /* best-effort */ } };
  const drawSteady = () => draw(pttStateStyle(stateKey));

  return {
    /// Set the steady state (orange listening / magenta transcribing / idle).
    /// While a flash is showing, the steady redraw is deferred until it ends.
    setState(next) {
      stateKey = pttStateStyle(next).key;
      if (!flashHandle) drawSteady();
      return stateKey;
    },
    /// Show a brief flash (yellow chunk / green commit), then revert to steady.
    flash(event) {
      const fs = pttFlashStyle(event);
      if (!fs) return false;
      if (flashHandle) { try { clearTimer(flashHandle); } catch { /* best-effort */ } }
      draw(fs);
      flashHandle = setTimer(() => { flashHandle = null; drawSteady(); }, flashMs);
      return true;
    },
    /// Cancel any pending flash timer (on stop) without redrawing.
    stop() {
      if (flashHandle) { try { clearTimer(flashHandle); } catch { /* best-effort */ } flashHandle = null; }
    },
    get state() { return stateKey; },
    get flashing() { return flashHandle !== null; },
  };
}
