// Voice input settings shared by every speech-input surface: the daemon's /call, /stt and /ptt
// (voice.mjs) and the local /stt and /ptt of TUI Pi and pi-client (realtime-agent.js).
//
// - Aliases: settings.json `agentUtils.voice.aliases` (and the older `agentUtils.call.aliases`),
//   name → `key=value …`. `/call bt`, `/stt bt` and `/ptt bt` use the alias's microphone
//   (source=, server=), speech output (sink=, pan=, tts=) and delivery (send=) until they stop.
// - Delivery: how a finished turn reaches a busy agent. `steer` (the default) delivers it at the
//   agent's next step; `followup` waits for the agent's whole turn to end; `interrupt` stops the
//   agent's turn, then sends. `agentUtils.voice.send` (or PI_VOICE_SEND) sets the default.
import { parseEnvStyleArgs } from "./env-args.js";

/** Words of /call, /stt and /ptt: never alias names. */
export const VOICE_WORDS = Object.freeze(new Set([
  "help", "usage", "?", "status", "devices", "sources", "talk", "send", "cancel", "mute", "unmute", "hangup", "end", "stop",
  "off", "on", "start", "vad", "ptt", "aliases", "follow", "hold", "local-vad", "localvad", "local_vad", "local-vad-ptt",
  "local-vad-hold", "ptt-vad",
]));

/** Aliases from a settings object: name → its values (from `key=value …` or an object of values). */
export function voiceAliases(raw) {
  const aliases = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return aliases;
  for (const [name, value] of Object.entries(raw)) {
    const key = String(name).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]{0,31}$/.test(key) || VOICE_WORDS.has(key)) continue;
    if (typeof value === "string") aliases[key] = parseEnvStyleArgs(value).values;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      aliases[key] = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, String(v)]));
    }
  }
  return aliases;
}

const plainObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** The aliases settings.json's `agentUtils` defines: `voice.aliases` over the older `call.aliases`. */
export function aliasesFromSettings(agentUtils = {}) {
  const root = plainObject(agentUtils);
  return voiceAliases({ ...plainObject(plainObject(root.call).aliases), ...plainObject(plainObject(root.voice).aliases) });
}

const SEND_MODES = Object.freeze({
  steer: "steer", steering: "steer",
  followup: "followUp", "follow-up": "followUp", follow_up: "followUp", queue: "followUp",
  interrupt: "interrupt", halt: "interrupt",
});

export const DEFAULT_VOICE_SEND = "steer";

/** `steer`, `followUp` or `interrupt` for a typed `send=` (or the older `deliver=`); throws otherwise. */
export function normalizeVoiceSend(value, surface = "/stt") {
  const key = String(value ?? "").trim().toLowerCase();
  if (!Object.hasOwn(SEND_MODES, key)) throw new Error(`${surface}: send must be steer, followup or interrupt`);
  return SEND_MODES[key];
}

/** The default delivery: PI_VOICE_SEND, else settings.json `agentUtils.voice.send`, else steer. */
export function voiceSendFromSettings(agentUtils = {}, env = process.env) {
  const configured = env?.PI_VOICE_SEND ?? plainObject(plainObject(agentUtils).voice).send;
  if (configured === undefined || configured === null || String(configured).trim() === "") return DEFAULT_VOICE_SEND;
  try { return normalizeVoiceSend(configured); } catch { return DEFAULT_VOICE_SEND; }
}

/** How a delivery mode reads in status lines and settings. */
export function voiceSendLabel(mode) {
  return mode === "followUp" ? "followup" : mode === "interrupt" ? "interrupt" : "steer";
}

/** Pi's sendUserMessage options for a delivery mode (interrupt sends as a steer once stopped). */
export function piSendOptions(mode) {
  const deliverAs = mode === "followUp" ? "followUp" : "steer";
  return { deliverAs, streamingBehavior: deliverAs };
}

/**
 * The speech output key a TUI Pi process's local /stt and /ptt publish under (call-audio.js), for
 * its own tts-narration.js and choice.js: one session per TUI process.
 */
export const LOCAL_VOICE_OUTPUT_KEY = "agent-utils.local-voice";
