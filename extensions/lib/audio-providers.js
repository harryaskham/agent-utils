// Named audio connections. No process-global mutable provider selection: each
// Pi event bus owns its runtime overrides. Standalone/Pebble callers read startup
// settings and keep explicit low-level options; they need no Pi/AHP runtime.
import { readAgentSettings, agentSettingsPath } from "../pi-graphics/agent-io.js";
import { azureAuthSettings } from "./azure-speech-auth.js";

export const AUDIO_PROVIDER_TYPES = Object.freeze(["azure", "openai", "daemon", "command"]);
export const CONNECTION_FIELDS = Object.freeze(["endpoint", "auth", "az", "resource", "tenant", "subscription", "resourceId", "apiKeyEnv", "deployment", "daemonUrl", "daemonProvider", "tokenFile", "command"]);
const ALIASES = { local: "command", "azure-speech": "azure", "direct-azure": "azure" };
const SNAKE = { resource_id: "resourceId", api_key_env: "apiKeyEnv", daemon_url: "daemonUrl", daemon_provider: "daemonProvider", token_file: "tokenFile", base_url: "endpoint" };
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUTH = ["auth", "az", "resource", "tenant", "subscription"];
const DISCOVER = "agent-utils:audio-providers.v1";
const FALLBACK = Symbol.for("agent-utils.audio-providers.fallback.v1");
const plain = v => v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const fields = v => Object.fromEntries(CONNECTION_FIELDS.filter(k => Object.hasOwn(v || {}, k) && v[k] != null).map(k => [k, v[k]]));
const pick = (v, kind) => ({ ...fields(v), ...fields(v?.[kind]) });
const canonical = name => ALIASES[name] || name;
function normalized(value) {
  const name = String(value ?? "").trim().toLowerCase();
  if (!NAME.test(name) || ["__proto__", "prototype", "constructor", "auto", "settings", "status", "reset", "help"].includes(name)) throw new Error("audio: invalid/reserved provider name (use letters, digits, . _ -)");
  return canonical(name);
}
export function builtinProviderType(name) {
  const type = canonical(String(name ?? "").trim().toLowerCase());
  return AUDIO_PROVIDER_TYPES.includes(type) ? type : undefined;
}
function startup(options = {}) {
  return readAgentSettings(options.settingsPath ?? options.audioProviders?.settingsPath ?? agentSettingsPath())?.agentUtils || {};
}
export function configuredAudioProviders(options = {}) {
  const p = startup(options).audio?.providers;
  if (p === undefined) return {};
  if (!plain(p) || Object.keys(p).length > 64) throw new Error("audio.providers must be an object with at most 64 providers");
  return p;
}
function entry(name, options) {
  const providers = configuredAudioProviders(options);
  const configured = Object.hasOwn(providers, name) ? providers[name] : undefined;
  if (configured !== undefined && !plain(configured)) throw new Error(`audio: '${name}' must be a provider object`);
  return { configured, override: options.audioProviders?.overrides.get(name) };
}
export function audioProviderType(name, options = {}) {
  const key = normalized(name), e = entry(key, options);
  const declared = e.override?.type ?? e.configured?.type ?? builtinProviderType(key);
  const type = builtinProviderType(declared);
  if (!type) throw new Error(`audio: unknown provider or missing type for '${key}'; configure agentUtils.audio.providers.${key}`);
  return type;
}
export function selectAudioProvider(name, { kind = "tts", ...options } = {}) {
  if (kind === "stt" && String(name).trim().toLowerCase() === "auto") return { provider: "auto", providerName: undefined };
  const providerName = normalized(name), provider = audioProviderType(providerName, options);
  if (kind === "stt" && provider === "command") throw new Error("stt: command providers are TTS-only");
  return { provider, providerName };
}
export function selectTtsProvider(name, options) {
  try { return selectAudioProvider(name, options); }
  catch (e) { throw new Error(`tts: unsupported provider; use azure, openai, daemon, command, or a configured audio provider name (${e.message})`); }
}
export function isConfiguredAudioProvider(name, options = {}) {
  const e = entry(normalized(name), options);
  return !!(e.configured || e.override);
}

// Existing files keep working. A partial /audio azure az=... edit must inherit
// the legacy auth/endpoint, not accidentally revert to key mode/regional Speech.
function legacy(name, type, kind, options) {
  if (name !== type) return {};
  const s = startup(options), surface = s[kind] || {};
  const ttsAzure = { ...fields(s.tts?.providers?.azure), ...fields(s.tts) };
  const inherited = type === "azure" && kind === "stt" ? Object.fromEntries(AUTH.filter(k => ttsAzure[k] !== undefined).map(k => [k, ttsAzure[k]])) : {};
  return { ...inherited, ...fields(surface.providers?.[type]), ...((surface.provider || (kind === "tts" ? "azure" : "auto")) === name || (kind === "stt" && !surface.provider) ? fields(surface) : {}) };
}
function environment(name, type, kind, env) {
  if (name !== type) return {};
  const result = {};
  if (type === "azure") {
    for (const key of [...AUTH, ...(kind === "tts" ? ["resourceId"] : [])]) {
      const suffix = key === "resourceId" ? "RESOURCE_ID" : key.toUpperCase();
      const value = env[`PI_${kind.toUpperCase()}_AZURE_${suffix}`] ?? env[`AZURE_SPEECH_${suffix}`];
      if (value != null && String(value).trim()) result[key] = value;
    }
    const endpoint = kind === "tts" ? env.PI_TTS_AZURE_ENDPOINT : env.PI_STT_ENDPOINT;
    if (endpoint) result.endpoint = endpoint;
  } else if (type === "daemon") {
    for (const [field, suffix] of [["daemonUrl", "DAEMON_URL"], ["daemonProvider", "DAEMON_PROVIDER"]]) {
      const value = env[`PI_${kind.toUpperCase()}_${suffix}`] || env[`${kind.toUpperCase()}_${suffix}`];
      if (value) result[field] = value;
    }
    if (env[`${kind.toUpperCase()}_TOKEN_FILE`]) result.tokenFile = env[`${kind.toUpperCase()}_TOKEN_FILE`];
  } else if (type === "openai") {
    const endpoint = kind === "tts" ? env.PI_TTS_BASE_URL || env.OPENAI_BASE_URL : env.PI_STT_ENDPOINT;
    if (endpoint) result.endpoint = endpoint;
  }
  return result;
}
export function validateConnection(value, type) {
  const result = { ...value };
  for (const [key, v] of Object.entries(result)) {
    if (!CONNECTION_FIELDS.includes(key)) throw new Error(`audio: unknown connection field '${key}'`);
    if (v === null) continue;
    if (typeof v !== "string" || !v.trim() || v.length > 4096 || /[\r\n\0]/.test(v)) throw new Error(`audio: invalid ${key}`);
  }
  for (const key of ["endpoint", "daemonUrl"]) {
    if (result[key] == null) continue;
    if (key === "daemonUrl" && /^[A-Za-z0-9.-]+(?::\d+)?$/.test(result[key])) continue;
    let u; try { u = new URL(result[key]); } catch { throw new Error(`audio: ${key} must be HTTP(S)`); }
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error(`audio: ${key} must be HTTP(S) without credentials, query or fragment`);
  }
  if (result.apiKeyEnv != null && !ENV_NAME.test(result.apiKeyEnv)) throw new Error("audio: api_key_env must name an environment variable (no secret values)");
  if (type === "azure") {
    const normalized = azureAuthSettings({ env: {}, options: result });
    if (result.auth != null) result.auth = normalized.auth;
  }
  else if ([...AUTH, "resourceId", "deployment"].some(k => result[k] != null && !(k === "auth" && type === "openai" && result.auth === "key"))) throw new Error("audio: Entra auth/broker/deployment fields apply only to azure");
  if (result.daemonProvider != null && !["azure", "openai"].includes(result.daemonProvider)) throw new Error("audio: daemon_provider must be azure or openai");
  return result;
}
function validateDefinition(value, type) {
  for (const key of Object.keys(value)) {
    if (!["type", "tts", "stt", ...CONNECTION_FIELDS].includes(key)) throw new Error(`audio: unknown provider field '${key}' (use apiKeyEnv, never literal keys)`);
  }
  for (const kind of ["tts", "stt"]) {
    if (value[kind] !== undefined && !plain(value[kind])) throw new Error(`audio: ${kind} must be a connection object`);
    if (value[kind]) validateConnection(value[kind], type);
    validateConnection(pick(value, kind), type);
  }
}
export function resolveAudioConnection(name, { kind = "tts", env = process.env, ...options } = {}) {
  if (!name || name === "auto") return undefined;
  const key = normalized(name), e = entry(key, options);
  if (!e.configured && !e.override) return undefined; // exact legacy path
  const type = audioProviderType(key, options);
  if (e.configured) validateDefinition(e.configured, type);
  const merged = { ...legacy(key, type, kind, options), ...pick(e.configured, kind), ...environment(key, type, kind, env), ...pick(e.override, kind) };
  if (kind === "stt") delete merged.resourceId;
  return { name: key, type, ...validateConnection(merged, type) };
}
export function withAudioConnection(options = {}, { kind = "tts" } = {}) {
  if (!options.providerName || options.audioConnectionResolved) return options; // explicit low-level/Pebble calls
  const env = options.env ?? process.env;
  const c = resolveAudioConnection(options.providerName, { kind, env, audioProviders: options.audioProviders });
  if (!c) return options;
  const next = { ...options, provider: c.type, providerName: c.name, audioConnectionResolved: true };
  for (const key of [...CONNECTION_FIELDS, "apiKey", "baseUrl"]) delete next[key];
  for (const [key, v] of Object.entries(c)) if (!["name", "type"].includes(key)) next[key] = v;
  if (c.apiKeyEnv) {
    const key = env[c.apiKeyEnv];
    if (!key && !(c.type === "azure" && c.auth === "entra")) throw new Error(`audio: credential environment variable ${c.apiKeyEnv} is not set`);
    if (key) next.apiKey = String(key).trim();
  }
  // Pin resolved Entra policy even for a named Azure provider without auth=;
  // shared auth env must not silently switch that provider's identity.
  if (c.type === "azure") Object.assign(next, azureAuthSettings({ env: {}, options: c }));
  return next;
}
export function normalizeRuntimeValues(values = {}, type) {
  const out = {};
  for (const [raw, value] of Object.entries(values)) {
    const parts = raw.split("."), scope = parts.length === 2 ? parts[0] : undefined;
    if (parts.length > 2 || (scope && !["tts", "stt"].includes(scope))) throw new Error("audio: use tts.<field> or stt.<field>");
    const field = SNAKE[parts.at(-1)] || parts.at(-1);
    if (field === "type" && !scope) { out.type = builtinProviderType(value); if (!out.type) throw new Error("audio: unsupported type"); continue; }
    if (!CONNECTION_FIELDS.includes(field)) throw new Error(`audio: unknown field '${raw}'; secrets are never accepted (use api_key_env)`);
    const v = value === null || /^(none|null|unset)$/i.test(String(value).trim()) ? null : String(value).trim();
    if (scope) (out[scope] ||= {})[field] = v; else out[field] = v;
  }
  validateDefinition(out, out.type || type);
  return out;
}
function requireRuntime(options) {
  if (!options?.audioProviders || options.audioProviders.closed) throw new Error("audio: no active session provider registry");
  return options.audioProviders;
}
export function setRuntimeAudioProvider(name, values, options = {}) {
  const registry = requireRuntime(options), key = normalized(name);
  let type; try { type = audioProviderType(key, options); } catch { /* new name needs type */ }
  const patch = normalizeRuntimeValues(values, type);
  if (patch.type && type && patch.type !== type) throw new Error(`audio: '${key}' is ${type}; use a new name for another type`);
  if (!type && !patch.type) throw new Error("audio: new provider needs type=azure|openai|daemon|command");
  const next = { ...(registry.overrides.get(key) || {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (["tts", "stt"].includes(k)) {
      const scoped = { ...next[k] };
      for (const [f, x] of Object.entries(v)) { if (x === null) delete scoped[f]; else scoped[f] = x; }
      if (Object.keys(scoped).length) next[k] = scoped; else delete next[k];
    } else if (v === null) delete next[k]; else next[k] = v;
  }
  validateDefinition(next, type || patch.type);
  if (registry.overrides.size >= 64 && !registry.overrides.has(key)) throw new Error("audio: at most 64 runtime providers");
  if (Object.keys(next).length) registry.overrides.set(key, next); else registry.overrides.delete(key);
  return snapshotRuntimeAudioProviders(options);
}
export function snapshotRuntimeAudioProviders({ audioProviders } = {}) {
  return Object.fromEntries([...(audioProviders?.overrides || [])].map(([k, v]) => [k, structuredClone(v)]));
}
export function resetRuntimeAudioProviders(name, options = {}) {
  const r = requireRuntime(options); if (name == null) r.overrides.clear(); else r.overrides.delete(normalized(name));
  return snapshotRuntimeAudioProviders(options);
}
export function restoreRuntimeAudioProviders(snapshot = {}, options = {}) {
  const r = requireRuntime(options); r.overrides.clear();
  for (const [name, v] of Object.entries(plain(snapshot) ? snapshot : {}).slice(0, 64)) {
    if (!plain(v)) continue;
    try { setRuntimeAudioProvider(name, Object.fromEntries(Object.entries(v).flatMap(([k, x]) => plain(x) ? Object.entries(x).map(([f, y]) => [`${k}.${f}`, y]) : [[k, x]])), options); } catch { /* invalid old entry is not an executable configuration */ }
  }
}
export function audioProviderNames(options = {}) {
  return [...new Set([...AUDIO_PROVIDER_TYPES, ...Object.keys(configuredAudioProviders(options)), ...(options.audioProviders?.overrides.keys() || [])])].sort();
}
// Inspection also shows effective legacy policy, without enabling a named
// override or ever resolving a credential value.
export function inspectAudioConnection(name, { kind = "tts", env = process.env, ...options } = {}) {
  const resolved = resolveAudioConnection(name, { ...options, kind, env });
  if (resolved) return resolved;
  const key = normalized(name), type = audioProviderType(key, options);
  const c = { ...legacy(key, type, kind, options), ...environment(key, type, kind, env) };
  if (type === "azure") Object.assign(c, azureAuthSettings({ env, options: c, kind }));
  return { name: key, type, ...c };
}
export function describeAudioProviders(options = {}) {
  const result = [];
  for (const name of audioProviderNames(options)) {
    try {
      const type = audioProviderType(name, options), tts = inspectAudioConnection(name, options), stt = type === "command" ? null : inspectAudioConnection(name, { ...options, kind: "stt" });
      const auth = type === "azure" ? (tts.auth === "entra" ? `entra/${tts.az || "az"}` : `key/${tts.apiKeyEnv || "default-env"}`) : type === "openai" ? `key/${tts.apiKeyEnv || "OPENAI_API_KEY"}` : type;
      const a = tts.endpoint || tts.daemonUrl || "default", b = stt?.endpoint || stt?.daemonUrl || "default";
      result.push(`${name}: ${type} · ${auth} · ${a === b ? a : `tts ${a} · stt ${b}`} · ${options.audioProviders?.overrides.has(name) ? "runtime" : isConfiguredAudioProvider(name, options) ? "settings" : "legacy"}`);
    } catch (e) { result.push(`${name}: ${e.message}`); }
  }
  return result;
}
export function createAudioProviders({ settingsPath } = {}) { return { settingsPath, overrides: new Map(), closed: false }; }
export function bindAudioProviders(pi, options = {}) {
  const fallback = globalThis[FALLBACK] ||= new WeakMap();
  const bus = pi.events, hasBus = typeof bus?.emit === "function" && typeof bus?.on === "function";
  let shared;
  if (hasBus) bus.emit(DISCOVER, { version: 1, accept(value) { if (!shared && value?.version === 1 && !value.providers?.closed) shared = value; } });
  else shared = fallback.get(pi);
  if (!shared) {
    shared = { version: 1, providers: createAudioProviders(options), refs: 0 };
    if (hasBus) {
      const handler = req => { if (req?.version === 1 && !shared.providers.closed) req.accept?.(shared); };
      const off = bus.on(DISCOVER, handler); shared.off = typeof off === "function" ? off : () => bus.off?.(DISCOVER, handler);
    } else fallback.set(pi, shared);
  }
  shared.refs++;
  let released = false;
  return { providers: shared.providers, release() { if (released) return; released = true; if (--shared.refs === 0) { shared.providers.closed = true; shared.providers.overrides.clear(); shared.off?.(); fallback.delete(pi); } } };
}
// Legacy surface auth commands remain accepted for old configurations. Once a
// named/shared provider owns the connection, edit that provider explicitly.
export const SURFACE_AUTH_KEYS = Object.freeze(["auth", "az", "resource", "tenant", "subscription", "resource_id"]);
export function rejectSurfaceAuthKeys(values = {}, surface = "/tts", options = {}) {
  const key = SURFACE_AUTH_KEYS.find(k => Object.hasOwn(values, k));
  const selected = values.provider || options.providerName;
  const name = selected === "auto" ? "azure" : selected;
  if (key && name && isConfiguredAudioProvider(name, options)) throw new Error(`${surface}: ${key}= belongs to shared audio provider '${name}'; use /audio ${name} ${key}=...`);
}
