// `/stt key=value` settings as environment variables (bd-6ffaf9). TUI /stt applies them to
// process.env; a pi-daemon session's /call, /stt and /ptt keep them as that session's own overlay
// on the worker's environment, so sessions never share a setting. Both read settings.json's
// agentUtils.stt first and PI_STT_* / PI_RT_LOCAL_VAD_* after, as the libraries resolve them.
import { normalizeSttProvider, resolveSttSettings, selectSttProvider } from "./stt-provider.js";
import { parseBooleanValue } from "./realtime-helpers.js";

/** The keys TUI /stt accepts. */
export const STT_SETTING_KEYS = Object.freeze([
  "model", "timeout", "timeout_ms", "energy", "energy_threshold",
  "insert", "insert_ms", "insert_silence_ms", "commit", "commit_ms",
  "commit_silence_ms", "min_speech", "min_speech_ms", "shortcuts", "shortcuts_enabled",
  "provider", "endpoint", "base_url", "daemon_url", "daemon_provider", "token_file", "language", "lang", "prompt", "streaming_model",
  "auth", "az", "resource", "tenant", "subscription",
]);

/** Where a session records from: the Pulse source and server, as `device=` and `server=` (pi-daemon). */
export const STT_DEVICE_KEYS = Object.freeze(["device", "source", "server"]);

const STRINGS = {
  endpoint: "PI_STT_ENDPOINT", base_url: "PI_STT_ENDPOINT", daemon_url: "PI_STT_DAEMON_URL", daemon_provider: "PI_STT_DAEMON_PROVIDER",
  token_file: "STT_TOKEN_FILE", language: "PI_STT_LANGUAGE", lang: "PI_STT_LANGUAGE", prompt: "PI_STT_PROMPT", streaming_model: "PI_STT_STREAMING_MODEL",
  auth: "PI_STT_AZURE_AUTH", az: "PI_STT_AZURE_AZ", resource: "PI_STT_AZURE_RESOURCE", tenant: "PI_STT_AZURE_TENANT", subscription: "PI_STT_AZURE_SUBSCRIPTION",
};
const NUMBERS = [
  [["timeout", "timeout_ms"], "PI_RT_LOCAL_VAD_TIMEOUT_MS", {}],
  [["energy", "energy_threshold"], "PI_RT_LOCAL_VAD_ENERGY_THRESHOLD", { min: 0, max: 1 }],
  [["insert", "insert_ms", "insert_silence_ms"], "PI_RT_LOCAL_VAD_INSERT_SILENCE_MS", {}],
  [["commit", "commit_ms", "commit_silence_ms"], "PI_RT_LOCAL_VAD_COMMIT_SILENCE_MS", {}],
  [["min_speech", "min_speech_ms"], "PI_RT_LOCAL_VAD_MIN_TURN_SPEECH_MS", {}],
];
/** A provider change forgets these, which belong to the provider before it. */
export const STT_PROVIDER_SPECIFIC_ENV = Object.freeze(["PI_RT_LOCAL_VAD_MODEL", "PI_STT_MODEL", "PI_STT_ENDPOINT", "PI_STT_PROMPT", "PI_STT_STREAMING_MODEL"]);

function pulseName(value, key, surface) {
  const text = String(value ?? "").trim();
  if (!text || text.length > 255 || /[\x00-\x1f\x7f]/.test(text)) throw new Error(`${surface}: ${key} must be a Pulse name or address`);
  return text;
}

/**
 * The environment `values` set: `{ updates, clear }`. `clear` lists the variables a provider
 * change forgets. `devices` also accepts `device=` (or `source=`) and `server=`, as PULSE_SOURCE
 * and PULSE_SERVER. Throws on an unknown key or a bad value, naming `surface`.
 */
export function sttEnvUpdates(values = {}, { env = process.env, persisted = {}, audioProviders, surface = "/stt", devices = false, extraKeys = [] } = {}) {
  const allowed = new Set([...STT_SETTING_KEYS, ...(devices ? STT_DEVICE_KEYS : []), ...extraKeys]);
  for (const key of Object.keys(values)) if (!allowed.has(key)) throw new Error(`${surface}: unknown setting '${key}'`);
  const updates = {};
  const prior = resolveSttSettings(env, persisted);
  if (values.provider !== undefined) {
    const selected = selectSttProvider(values.provider, { audioProviders });
    updates.PI_STT_PROVIDER = selected.providerName || selected.provider;
  }
  if (values.daemon_provider && !["azure", "openai"].includes(values.daemon_provider)) throw new Error(`${surface}: daemon_provider must be azure or openai`);
  for (const [key, envKey] of Object.entries(STRINGS)) if (values[key] !== undefined) updates[envKey] = String(values[key]);
  for (const [keys, envKey, { min = 0, max = Infinity }] of NUMBERS) {
    const key = keys.find((candidate) => Object.hasOwn(values, candidate));
    if (!key) continue;
    const value = Number(values[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${surface}: ${key} must be between ${min} and ${max}`);
    updates[envKey] = String(value);
  }
  if (Object.hasOwn(values, "model")) {
    const model = String(values.model).trim();
    if (!model) throw new Error(`${surface}: model cannot be empty`);
    updates.PI_RT_LOCAL_VAD_MODEL = model;
  }
  const shortcutsKey = ["shortcuts", "shortcuts_enabled"].find((key) => Object.hasOwn(values, key));
  if (shortcutsKey) updates.PI_RT_STT_SHORTCUTS_ENABLED = parseBooleanValue(values[shortcutsKey]) ? "1" : "0";
  if (devices) {
    const deviceKey = ["device", "source"].find((key) => Object.hasOwn(values, key));
    if (deviceKey) updates.PULSE_SOURCE = pulseName(values[deviceKey], deviceKey, surface);
    if (Object.hasOwn(values, "server")) updates.PULSE_SERVER = pulseName(values.server, "server", surface);
  }
  const providerChanged = updates.PI_STT_PROVIDER
    && (normalizeSttProvider(updates.PI_STT_PROVIDER, { audioProviders }) !== prior.provider || (prior.providerName && updates.PI_STT_PROVIDER !== prior.providerName));
  const clear = providerChanged ? STT_PROVIDER_SPECIFIC_ENV.filter((key) => !Object.hasOwn(updates, key)) : [];
  return { updates, clear };
}
