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

// coerce tags map to coercer fns supplied by the caller (realtime-agent.js owns
// parseBooleanValue/parseRealtimeSpeed/parseVadThreshold), keeping this lib pure.
export const REALTIME_VALUE_SETTINGS = [
  { param: "baseUrl", keys: ["base_url", "baseurl", "openai_base_url", "openaibaseurl", "rt_base_url", "rtbaseurl"], coerce: "raw" },
  { param: "backend", keys: ["backend"], coerce: "lowerTrim" },
  { param: "voice", keys: ["voice"], coerce: "lowerTrim" },
  { param: "trans", keys: ["trans", "transcription", "transcription_model", "transcriptionmodel"], coerce: "lowerTrim" },
  { param: "reasoning", keys: ["reasoning"], coerce: "lowerTrim" },
  { param: "speed", keys: ["speed"], coerce: "speed" },
  { param: "thresh", keys: ["thresh", "threshold", "vad_threshold", "vadthreshold"], coerce: "thresh" },
  { param: "energy", keys: ["energy", "energy_threshold", "energythreshold"], coerce: "thresh" },
  { param: "summary", keys: ["summary"], coerce: "bool" },
  { param: "chime", keys: ["chime"], coerce: "bool" },
  { param: "fork", keys: ["fork"], coerce: "bool" },
  { param: "model", keys: ["model"], coerce: "trim" },
  { param: "directAzure", keys: ["direct_azure", "directazure", "azure"], coerce: "bool" },
  { param: "azureEndpoint", keys: ["azure_endpoint", "azureendpoint", "endpoint"], coerce: "trim" },
  { param: "azureDeployment", keys: ["azure_deployment", "azuredeployment", "deployment"], coerce: "trim" },
  { param: "azureApiVersion", keys: ["azure_api_version", "azureapiversion", "api_version", "apiversion"], coerce: "trim" },
  { param: "azureProtocol", keys: ["azure_protocol", "azureprotocol", "protocol"], coerce: "trim" },
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
