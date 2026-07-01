// Declarative registry for /rt k=v value settings (bd-381522).
//
// Adding a runtime /rt connection/tuning setting used to need 5 coordinated
// edits in realtime-agent.js (env alias map, coercion, apply dispatch, setter,
// snapshot). The two most error-prone — the k=v alias map and the coercion —
// are now data: one row here covers both, and a single round-trip test asserts
// every declared key normalizes, preventing the "energy= silently dropped"
// class (bd-afb682). Lifecycle keys (start/mic/listen/stt/audio/widget/status/
// fork) and pulse routing remain bespoke in realtime-agent.js; this registry
// covers the simple value settings only.

import { writeFileSync } from "node:fs";
import { readJsonIfExists, agentSettingsPath } from "../pi-graphics/agent-io.js";

// coerce tags map to coercer fns supplied by the caller (realtime-agent.js owns
// parseBooleanValue/parseRealtimeSpeed/parseVadThreshold), keeping this lib pure.
export const REALTIME_VALUE_SETTINGS = [
  { param: "baseUrl", keys: ["base_url", "baseurl", "openai_base_url", "openaibaseurl", "rt_base_url", "rtbaseurl"], coerce: "raw", setter: "setBaseUrl", snapshotField: "baseUrl" },
  { param: "backend", keys: ["backend"], coerce: "lowerTrim", setter: "setAudioBackend", snapshotField: "audioBackend" },
  { param: "voice", keys: ["voice"], coerce: "lowerTrim", setter: "setVoice", snapshotField: "voice" },
  { param: "trans", keys: ["trans", "transcription", "transcription_model", "transcriptionmodel"], coerce: "lowerTrim", setter: "setTranscriptionModel", snapshotField: "transcriptionModel" },
  { param: "reasoning", keys: ["reasoning"], coerce: "lowerTrim", setter: "setReasoningEffort", snapshotField: "reasoningEffort" },
  { param: "speed", keys: ["speed"], coerce: "speed", setter: "setSpeed", snapshotField: "speed" },
  { param: "thresh", keys: ["thresh", "threshold", "vad_threshold", "vadthreshold"], coerce: "thresh", setter: "setVadThreshold", snapshotField: "vadThreshold" },
  { param: "energy", keys: ["energy", "energy_threshold", "energythreshold"], coerce: "thresh", special: "localVadEnergy" },
  { param: "summary", keys: ["summary"], coerce: "bool", setter: "setSummaryContext", snapshotField: "summaryContext" },
  { param: "chime", keys: ["chime"], coerce: "bool", setter: "setChime", snapshotField: "chimeEnabled" },
  { param: "speakReplies", keys: ["speak_replies", "speakreplies", "replies"], coerce: "bool", setter: "setSpeakReplies", snapshotField: "speakReplies" },
  { param: "speakThinking", keys: ["speak_thinking", "speakthinking", "thinking"], coerce: "bool", setter: "setSpeakThinking", snapshotField: "speakThinking" },
  { param: "fork", keys: ["fork"], coerce: "bool", special: "fork" },
  { param: "model", keys: ["model"], coerce: "trim", setter: "setModel", snapshotField: "model" },
  { param: "directAzure", keys: ["direct_azure", "directazure", "azure"], coerce: "bool", setter: "setDirectAzure", snapshotField: "directAzure" },
  { param: "azureEndpoint", keys: ["azure_endpoint", "azureendpoint", "endpoint"], coerce: "trim", setter: "setAzureEndpoint", snapshotField: "azureEndpoint" },
  { param: "azureDeployment", keys: ["azure_deployment", "azuredeployment", "deployment"], coerce: "trim", setter: "setAzureDeployment", snapshotField: "azureDeployment" },
  { param: "azureApiVersion", keys: ["azure_api_version", "azureapiversion", "api_version", "apiversion"], coerce: "trim", setter: "setAzureApiVersion", snapshotField: "azureApiVersion" },
  { param: "azureProtocol", keys: ["azure_protocol", "azureprotocol", "protocol"], coerce: "trim", setter: "setAzureProtocol", snapshotField: "azureProtocol" },
];

// First-listed alias per param, used by env builders that prefer the param name
// itself first then the alias chain. Each row already implies `param` is a key.
export function realtimeValueParamFor(key) {
  for (const s of REALTIME_VALUE_SETTINGS) {
    if (s.param === key || s.keys.includes(key)) return s.param;
  }
  return null;
}

// Build the value-setting params from a parsed env-style `values` map, taking
// the param name first, then each alias in order (||/?? precedence). Returns a
// plain object with only the params that were supplied.
export function buildRealtimeValueParams(values = {}) {
  const out = {};
  for (const s of REALTIME_VALUE_SETTINGS) {
    if (values[s.param] !== undefined) { out[s.param] = values[s.param]; continue; }
    for (const k of s.keys) {
      if (values[k] !== undefined) { out[s.param] = values[k]; break; }
    }
  }
  return out;
}

// Coerce supplied value-setting params in place-equivalent and return a new map,
// using the caller-provided coercers. Unsupplied/null params are skipped.
export function normalizeRealtimeValueParams(params = {}, coercers = {}) {
  const lowerTrim = (x) => String(x).trim().toLowerCase();
  const trim = (x) => String(x).trim();
  const raw = (x) => x;
  const map = {
    lowerTrim, trim, raw,
    bool: coercers.bool || ((x) => x),
    speed: coercers.speed || ((x) => x),
    thresh: coercers.thresh || ((x) => x),
  };
  const out = { ...params };
  for (const s of REALTIME_VALUE_SETTINGS) {
    if (out[s.param] === undefined || out[s.param] === null) continue;
    out[s.param] = (map[s.coerce] || raw)(out[s.param]);
  }
  return out;
}

// Apply value-setting params via controls[setter](value, ctx). Lifecycle/pulse
// and fork stay bespoke in the caller; fork rows are skipped here, and energy is
// special (local-vad sensitivity). Unsupplied params are skipped. Returns the
// list of param names applied (for snapshot/echo). bd-25f291.
export function applyRealtimeValueParams(params = {}, controls = {}, ctx, { applyLocalVadEnergy } = {}) {
  const applied = [];
  for (const s of REALTIME_VALUE_SETTINGS) {
    if (params[s.param] === undefined) continue;
    if (s.special === "fork") continue;
    if (s.special === "localVadEnergy") {
      if (typeof applyLocalVadEnergy === "function") applyLocalVadEnergy(params[s.param], ctx);
      applied.push(s.param);
      continue;
    }
    if (s.setter && typeof controls[s.setter] === "function") {
      controls[s.setter](params[s.param], ctx);
      applied.push(s.param);
    }
  }
  return applied;
}

// --- Persistence (bd-7217db): runtime /rt value changes survive a restart ---
//
// Runtime /rt k=v value changes are otherwise lost on restart because
// makeInitialConfig (realtime-config.js) reads env only. The fields below are
// persisted to the Pi agent settings.json under `agentUtils.realtime.<field>`
// (config-field names) and read back by makeInitialConfig with env precedence
// (env > persisted > default) — each is a complete set->persist->restart->restore
// round-trip. Reuses pi-graphics' agentSettingsPath/readJsonIfExists so both
// extensions share one settings.json; writes touch ONLY the agentUtils.realtime
// slice and never clobber pi-graphics' or any other slice.
export const PERSISTED_REALTIME_FIELDS = [
  "baseUrl",
  "model",
  "voice",
  "transcriptionModel",
  "speed",
  "vadThreshold",
  "directAzure",
  "azureEndpoint",
  "azureDeployment",
  "azureApiVersion",
  "azureProtocol",
  "speakReplies",
  "speakThinking",
];

const PERSISTED_FIELD_SET = new Set(PERSISTED_REALTIME_FIELDS);

// Read the persisted realtime settings slice (agentUtils.realtime). Returns {}
// when the file or slice is missing/malformed, so callers treat it as a plain
// precedence layer.
export function readPersistedRealtimeSettings(path = agentSettingsPath()) {
  const all = readJsonIfExists(path);
  const rt = all && all.agentUtils && all.agentUtils.realtime;
  return rt && typeof rt === "object" && !Array.isArray(rt) ? rt : {};
}

// Persist one realtime value setting to settings.json via read-merge-write,
// touching only agentUtils.realtime.<field>. Returns true on write. Non-fatal:
// returns false (never throws) on an unknown field or IO error, so a setter is
// never broken by a settings-write failure.
export function persistRealtimeSetting(field, value, path = agentSettingsPath()) {
  if (!PERSISTED_FIELD_SET.has(field)) return false;
  try {
    const all = readJsonIfExists(path) || {};
    if (!all.agentUtils || typeof all.agentUtils !== "object" || Array.isArray(all.agentUtils)) {
      all.agentUtils = {};
    }
    if (
      !all.agentUtils.realtime ||
      typeof all.agentUtils.realtime !== "object" ||
      Array.isArray(all.agentUtils.realtime)
    ) {
      all.agentUtils.realtime = {};
    }
    all.agentUtils.realtime[field] = value;
    writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

// --- Durable cascade + STT defaults (bd-b45224) ---
//
// Harry's contract: env WINS at runtime, but an env-derived value must NEVER be
// written back into settings.json (env is a runtime-only override; only explicit
// user changes persist). makeInitialConfig / cascadeRosterFromArgs read these
// persisted slices as a precedence layer BELOW env and above hardcoded defaults,
// and never write during resolution. Cascade previously had no persisted slice
// at all (env + /cascade args only); STT fields (transcriptionModel/vadThreshold)
// were only under agentUtils.realtime — agentUtils.stt is an explicit alias slice
// so an operator can put durable stt defaults in their own block. Same
// read-merge-write model as realtime: writes touch ONLY the named slice.
export const PERSISTED_CASCADE_FIELDS = [
  "voice", "model", "baseUrl", "ttsModel", "provider",
  "speakerProfileId", "lang", "speed", "azure",
];
export const PERSISTED_STT_FIELDS = [
  "transcriptionModel", "vadThreshold", "backend",
];

const PERSISTED_CASCADE_SET = new Set(PERSISTED_CASCADE_FIELDS);
const PERSISTED_STT_SET = new Set(PERSISTED_STT_FIELDS);

// Read an agentUtils.<slice> object, or {} when missing/malformed.
function readPersistedSlice(sliceKey, path) {
  const all = readJsonIfExists(path);
  const s = all && all.agentUtils && all.agentUtils[sliceKey];
  return s && typeof s === "object" && !Array.isArray(s) ? s : {};
}

// Persist one field into agentUtils.<slice>.<field> via read-merge-write,
// touching only that slice. Non-fatal: false on unknown field or IO error.
function persistSliceSetting(sliceKey, fieldSet, field, value, path) {
  if (!fieldSet.has(field)) return false;
  try {
    const all = readJsonIfExists(path) || {};
    if (!all.agentUtils || typeof all.agentUtils !== "object" || Array.isArray(all.agentUtils)) {
      all.agentUtils = {};
    }
    if (
      !all.agentUtils[sliceKey] ||
      typeof all.agentUtils[sliceKey] !== "object" ||
      Array.isArray(all.agentUtils[sliceKey])
    ) {
      all.agentUtils[sliceKey] = {};
    }
    all.agentUtils[sliceKey][field] = value;
    writeFileSync(path, JSON.stringify(all, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function readPersistedCascadeSettings(path = agentSettingsPath()) {
  return readPersistedSlice("cascade", path);
}
export function readPersistedSttSettings(path = agentSettingsPath()) {
  return readPersistedSlice("stt", path);
}
export function persistCascadeSetting(field, value, path = agentSettingsPath()) {
  return persistSliceSetting("cascade", PERSISTED_CASCADE_SET, field, value, path);
}
export function persistSttSetting(field, value, path = agentSettingsPath()) {
  return persistSliceSetting("stt", PERSISTED_STT_SET, field, value, path);
}
