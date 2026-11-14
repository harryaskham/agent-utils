// Local /stt and /ptt (realtime-agent.js, in TUI Pi and pi-client): which microphone they record
// from, how a turn reaches the agent, and what an alias or sink=/pan= asks of speech while they
// run. Pure planning; realtime-agent.js applies it.
//
// - Kept with the session's /stt settings (as typed STT settings are): source= (device=) and
//   server= choose the Pulse microphone; send=steer|followup|interrupt the delivery.
// - For this run only (until /stt or /ptt stops, or the next /stt or /ptt replaces it): an
//   alias's settings (`/ptt bt`, settings.json agentUtils.voice.aliases), with any typed after it,
//   and typed sink=, pan=, tts= (the agent's speech while it runs, call-audio.js).
import { callOutputFrom, splitCallValues } from "./call-audio.js";
import { normalizeVoiceSend } from "./voice-settings.js";

/** Keys that choose the microphone: `source=` and `device=` are one setting. */
export const LOCAL_MIC_KEYS = Object.freeze(["device", "source", "server"]);
/** Keys of a call alone, which local /stt and /ptt pass over. */
const CALL_ONLY_KEYS = new Set(["hangup_after"]);

function pulseName(value, key, surface) {
  const text = String(value ?? "").trim();
  if (text.length > 255 || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`${surface}: ${key} must be a Pulse name or address`);
  return text;
}

/**
 * The parts of a set of voice values: `mic` ({ source?, server? }, "" clears one), `send`
 * (steer|followUp|interrupt), `mode` (vad|ptt) and `stt` (the rest, TUI /stt's settings).
 * Throws on a bad value.
 */
export function splitLocalVoiceValues(values = {}, surface = "/stt") {
  const mic = {};
  const stt = {};
  let send;
  let mode;
  for (const [key, value] of Object.entries(values)) {
    if (key === "device" || key === "source") mic.source = pulseName(value, key, surface);
    else if (key === "server") mic.server = pulseName(value, key, surface);
    else if (key === "send" || key === "deliver") send = normalizeVoiceSend(value, surface);
    else if (key === "mode") {
      const text = String(value ?? "").trim().toLowerCase();
      if (!["vad", "ptt"].includes(text)) throw new Error(`${surface}: mode must be vad or ptt`);
      mode = text;
    } else if (!CALL_ONLY_KEYS.has(key)) stt[key] = value;
  }
  return { mic, send, mode, stt };
}

/**
 * What a local /stt or /ptt asks: `kept` (values to keep as the session's own: STT settings,
 * microphone, delivery) and `overlay` (this run's own: `{ alias?, mic, send?, mode?, stt, output }`,
 * or null). With an alias every value is this run's; without one only sink=, pan= and tts= are.
 */
export function planLocalVoice(values = {}, { alias, aliasValues = {}, surface = "/stt" } = {}) {
  const typed = splitCallValues(values);
  const named = splitCallValues(aliasValues);
  const output = callOutputFrom({ ...named.output, ...typed.output }, surface);
  if (alias) {
    const own = splitLocalVoiceValues({ ...named.voice, ...typed.voice }, surface);
    return { kept: {}, overlay: { alias, mic: own.mic, send: own.send, mode: own.mode, stt: own.stt, output } };
  }
  const own = splitLocalVoiceValues(typed.voice, surface);
  const kept = Object.fromEntries(Object.entries(typed.voice).filter(([key]) => key !== "mode" && !CALL_ONLY_KEYS.has(key)));
  return { kept, overlay: output ? { mic: {}, stt: {}, output } : null, mode: own.mode };
}

/** The microphone a run records from: its own over the session's (`""` clears one). */
export function effectiveLocalMic(sessionMic = {}, overlayMic = {}) {
  const merged = { ...sessionMic, ...overlayMic };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => typeof value === "string" && value.trim() !== ""));
}

/** `/tts overlay …` for pi-client to send to the daemon: the run's output, or off. */
export function overlayCommand(output) {
  if (!output) return "/tts overlay off";
  const parts = [];
  const quote = (value) => (/[\s"'\\]/.test(value) ? JSON.stringify(value) : value);
  if (output.sink !== undefined) parts.push(`sink=${quote(String(output.sink))}`);
  if (output.pan !== undefined) parts.push(`pan=${output.pan}`);
  if (output.tts !== undefined) parts.push(`tts=${output.tts ? "on" : "off"}`);
  return `/tts overlay ${parts.join(" ")}`;
}
