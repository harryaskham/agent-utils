// What a live /call asks of its session's speech, shared by voice.mjs (the call) and tts.mjs (the
// agent's speech) in one pi-daemon worker, through process-wide maps rather than either module's
// instance, so it survives either module's reload and the order they load in.
//
// - The call's output: while a call with an alias (or sink=/pan= of its own) is live, the
//   session's speech plays on that sink and pan, bypassing /tts focus and solo, and speaks even if
//   /tts is off. Nothing in the session's /tts settings changes: when the call ends the overlay
//   goes, and speech is as it was.
// - Speech activity: when each session last started or finished speaking, so a call's hang-up
//   timer counts the agent's speech as activity, as it counts the operator's.

const OUTPUTS = Symbol.for("agent-utils.call-output.v1");
const ACTIVITY = Symbol.for("agent-utils.speech-activity.v1");
const MAX_SESSIONS = 1024;

/** Keys of a /call (or an alias) that shape the call's speech rather than its microphone. */
export const CALL_OUTPUT_KEYS = Object.freeze(["sink", "pan", "tts"]);

function map(symbol) {
  const existing = globalThis[symbol];
  if (existing instanceof Map) return existing;
  const created = new Map();
  globalThis[symbol] = created;
  return created;
}

function remember(target, key, value) {
  target.delete(key);
  target.set(key, value);
  while (target.size > MAX_SESSIONS) target.delete(target.keys().next().value);
}

/**
 * A call's speech output from its values: `{ sink?, pan?, tts }`, or null when it asks nothing of
 * speech. `sink=` names the Pulse sink; `pan=` is -1 (left) to 1 (right); `tts=on|off` (on by
 * default once sink or pan is given, as `/tts sink=` turns /tts on) speaks while the call lasts.
 * Throws on an invalid value.
 */
export function callOutputFrom(values = {}, surface = "/call") {
  const output = {};
  if (values.sink !== undefined) {
    const sink = String(values.sink).trim();
    if (!sink || sink.length > 255 || /[\x00-\x1f\x7f]/.test(sink)) throw new Error(`${surface}: sink must be a Pulse sink name`);
    output.sink = sink;
  }
  if (values.pan !== undefined) {
    const pan = Number(values.pan);
    if (String(values.pan).trim() === "" || !Number.isFinite(pan) || pan < -1 || pan > 1) throw new Error(`${surface}: pan must be a number from -1 to 1`);
    output.pan = pan;
  }
  if (values.tts !== undefined) {
    const text = String(values.tts).trim().toLowerCase();
    if (!["on", "off", "true", "false", "1", "0", "yes", "no"].includes(text)) throw new Error(`${surface}: tts must be on or off`);
    output.tts = ["on", "true", "1", "yes"].includes(text);
  } else if (output.sink !== undefined || output.pan !== undefined) output.tts = true;
  return Object.keys(output).length ? output : null;
}

/** Split a call's values into its microphone's (voice) and its speech's (output). */
export function splitCallValues(values = {}) {
  const voice = {};
  const output = {};
  for (const [key, value] of Object.entries(values)) (CALL_OUTPUT_KEYS.includes(key) ? output : voice)[key] = value;
  return { voice, output };
}

/** Set (or with null, clear) a session's call output. */
export function setCallOutput(sessionId, output) {
  const outputs = map(OUTPUTS);
  const key = String(sessionId ?? "");
  if (!key) return;
  if (output && typeof output === "object") remember(outputs, key, { ...output });
  else outputs.delete(key);
}

/** A session's live call output, or undefined. */
export function callOutput(sessionId) {
  return map(OUTPUTS).get(String(sessionId ?? ""));
}

/** Per-utterance speech overrides for a call output: its sink (bypassing focus/solo) and pan. */
export function callSpeechOverrides(output) {
  if (!output) return {};
  return {
    ...(output.sink !== undefined ? { device: output.sink, bypassRouting: true } : {}),
    ...(output.pan !== undefined ? { pan: output.pan, panSource: "explicit" } : {}),
  };
}

/** How a call output reads in /tts and /call status. */
export function describeCallOutput(output) {
  if (!output) return "";
  const parts = [];
  if (output.sink !== undefined) parts.push(`sink:${output.sink}`);
  if (output.pan !== undefined) parts.push(`pan:${Number(output.pan).toFixed(2)}`);
  if (output.tts !== undefined) parts.push(`tts:${output.tts ? "on" : "as set"}`);
  return parts.join(" · ");
}

/** Note that a session's speech started or finished now. */
export function noteSpeechActivity(sessionId, at = Date.now()) {
  const key = String(sessionId ?? "");
  if (key) remember(map(ACTIVITY), key, at);
}

/** When a session's speech last started or finished (ms), or 0. */
export function lastSpeechActivity(sessionId) {
  return map(ACTIVITY).get(String(sessionId ?? "")) ?? 0;
}
