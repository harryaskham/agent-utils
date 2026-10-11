// Azure Speech/MAI authentication. Provider remains "azure"; credentials stay
// in headers and an in-memory, expiry-aware cache, never settings or transcripts.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const AZURE_SPEECH_TOKEN_RESOURCE = "https://cognitiveservices.azure.com/";
export const AZURE_TOKEN_BROKER_TIMEOUT_MS = 45000;
const AUTH_FIELDS = ["auth", "az", "resource", "tenant", "subscription", "resourceId"];
const CACHE_SYMBOL = Symbol.for("agent-utils.azure-speech-token.v1");
const MAX_TOKEN_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_CACHE_ENTRIES = 32;

export function normalizeAzureAuth(value = "key") {
  const auth = String(value).trim().toLowerCase();
  if (!["key", "entra"].includes(auth)) throw new Error("azure-speech: auth must be key or entra");
  return auth;
}

// Shared tts.providers.azure auth is inherited by STT, but its TTS endpoint
// must never become the transcription endpoint. STT's own provider fields win.
export function azureAuthSettings({ env = process.env, persisted = {}, inherited = {}, kind = "tts", options = {} } = {}) {
  const provider = { ...Object.fromEntries(AUTH_FIELDS.filter(k => (kind !== "stt" || k !== "resourceId") && inherited.providers?.azure?.[k] !== undefined).map(k => [k, inherited.providers.azure[k]])), ...persisted.providers?.azure };
  const source = { ...provider, ...Object.fromEntries(AUTH_FIELDS.filter(k => persisted[k] !== undefined).map(k => [k, persisted[k]])) };
  const result = {};
  for (const key of AUTH_FIELDS) {
    const suffix = key === "resourceId" ? "RESOURCE_ID" : key.toUpperCase();
    const value = options[key] ?? env[`PI_${kind.toUpperCase()}_AZURE_${suffix}`] ?? env[`AZURE_SPEECH_${suffix}`] ?? source[key];
    if (value != null) result[key] = value;
  }
  result.auth = normalizeAzureAuth(result.auth);
  result.az = String(result.az ?? "az").trim();
  if (!result.az || /[\r\n\0]/.test(result.az)) throw new Error("azure-speech: az must be an executable name or path, not a shell command");
  result.resource = String(result.resource ?? AZURE_SPEECH_TOKEN_RESOURCE).trim();
  if (!/^https:\/\/[^\s]+$/.test(result.resource)) throw new Error("azure-speech: token resource must be an HTTPS audience");
  for (const key of ["tenant", "subscription", "resourceId"]) {
    if (result[key] !== undefined) {
      result[key] = String(result[key]).trim();
      if (!result[key] || /[\r\n\0]/.test(result[key])) throw new Error(`azure-speech: invalid ${key}`);
    }
  }
  if (result.resourceId && !/^\/subscriptions\/[^#\s]+\/resourceGroups\/[^#\s]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^#\s]+$/i.test(result.resourceId)) {
    throw new Error("azure-speech: resourceId must be the Azure Cognitive Services resource ID");
  }
  return result;
}

export function azureTokenArgs({ resource = AZURE_SPEECH_TOKEN_RESOURCE, tenant, subscription } = {}) {
  return ["account", "get-access-token", "--resource", resource, "--output", "json", "--only-show-errors",
    ...(tenant ? ["--tenant", tenant] : []), ...(subscription ? ["--subscription", subscription] : [])];
}

function abortError() { return new DOMException("Azure authentication aborted", "AbortError"); }
function parseToken(bytes, now) {
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("azure-speech: token broker returned invalid JSON; output omitted"); }
  const token = value?.accessToken;
  if (typeof token !== "string" || !token || Buffer.byteLength(token) > MAX_TOKEN_BYTES || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error("azure-speech: token broker returned an invalid accessToken; output omitted");
  let expiry = Number(value.expires_on) * 1000;
  if (!Number.isFinite(expiry) || expiry <= 0) {
    // JWT exp is UTC, unlike legacy expiresOn (a local time from the broker
    // machine, which may be remote and in another timezone).
    try { expiry = Number(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()).exp) * 1000; } catch {}
  }
  if ((!Number.isFinite(expiry) || expiry <= 0) && typeof value.expiresOn === "string" && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.expiresOn)) expiry = Date.parse(value.expiresOn);
  if (!Number.isFinite(expiry) || expiry <= now + 15000) throw new Error("azure-speech: token broker returned expired or missing UTC expiry; output omitted");
  const margin = Math.min(300000, Math.max(15000, (expiry - now) / 10));
  return { token, expiresAt: expiry, refreshAt: expiry - margin };
}

// Execute the CLI interface only; never invoke a shell or run az login. Bound
// output, duration, and process-group teardown (custom brokers may spawn SSH).
function acquireToken({ command, args, env, signal, timeoutMs, spawnImpl }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    let proc, timer, settled = false, exited = false, size = 0;
    const chunks = [];
    const group = process.platform !== "win32";
    const kill = sig => {
      try { if (group && proc.pid) process.kill(-proc.pid, sig); else proc.kill(sig); } catch {}
    };
    const finish = (error, value, stop = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (stop) {
        kill("SIGTERM");
        const escalation = setTimeout(() => { if (group || !exited) kill("SIGKILL"); }, 250);
        escalation.unref?.();
      }
      if (error) reject(error); else resolve(value);
    };
    const onAbort = () => finish(abortError(), undefined, true);
    try {
      proc = spawnImpl(command, args, { env, detached: group, stdio: ["ignore", "pipe", "ignore"] });
    } catch { reject(new Error("azure-speech: token broker could not start; check the configured az executable")); return; }
    proc.stdout?.on("data", data => {
      if (settled) return;
      size += data.length;
      if (size > MAX_OUTPUT_BYTES) { finish(new Error("azure-speech: token broker output exceeded 128 KiB; output omitted"), undefined, true); return; }
      chunks.push(Buffer.from(data));
    });
    proc.once("error", () => finish(new Error("azure-speech: token broker could not start; check the configured az executable"), undefined, true));
    proc.once("close", code => {
      exited = true;
      if (code !== 0) finish(new Error(`azure-speech: token broker exited ${code ?? "?"}; check its login/access; output omitted`));
      else finish(null, Buffer.concat(chunks, size));
    });
    timer = setTimeout(() => finish(new Error(`azure-speech: token broker timed out after ${timeoutMs}ms; output omitted`), undefined, true), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function createAzureTokenBroker({ spawnImpl = spawn, now = Date.now, timeoutMs = AZURE_TOKEN_BROKER_TIMEOUT_MS } = {}) {
  const cache = new Map();
  function keyFor(options, env) {
    // Do not share cached identities across configured brokers/accounts/homes.
    // Hash the relevant environment so cache keys cannot expose credentials.
    const relevant = Object.fromEntries(Object.keys(env).filter(k => ["PATH", "HOME", "AZURE_CONFIG_DIR", "AZURE_CLOUD", "AZURE_AUTHORITY_HOST"].includes(k) || k.startsWith("AZ_TOKEN_")).sort().map(k => [k, env[k]]));
    return JSON.stringify([options.az, azureTokenArgs(options), createHash("sha256").update(JSON.stringify(relevant)).digest("hex")]);
  }
  async function getToken(options = {}) {
    const env = options.env ?? process.env;
    const signal = options.signal;
    if (signal?.aborted) throw abortError();
    const key = keyFor(options, env);
    let record = cache.get(key);
    if (record && record.refreshAt > now()) { cache.delete(key); cache.set(key, record); return record.token; }
    if (!record?.pending) {
      if (record) cache.delete(key);
      // Bound the idle cache, but never evict a live acquisition.
      if (cache.size >= MAX_CACHE_ENTRIES) {
        const idle = [...cache].find(([, r]) => !r.pending);
        if (idle) cache.delete(idle[0]);
        else throw new Error("azure-speech: token broker is at capacity");
      }
      record = { users: 0, controller: new AbortController(), pending: null };
      cache.set(key, record);
      const current = record;
      current.pending = acquireToken({ command: options.az || "az", args: azureTokenArgs(options), env, signal: current.controller.signal, timeoutMs, spawnImpl })
        .then(bytes => {
          current.controller.signal.throwIfAborted();
          const token = parseToken(bytes, now());
          Object.assign(current, token);
          return token.token;
        }).catch(error => { if (cache.get(key) === current) cache.delete(key); throw error; })
        .finally(() => { current.pending = null; });
    }
    record.users++;
    let onAbort;
    try {
      return await (signal ? Promise.race([record.pending, new Promise((_, reject) => {
        onAbort = () => reject(abortError());
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]) : record.pending);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      record.users--;
      if (record.pending && record.users === 0) {
        if (cache.get(key) === record) cache.delete(key);
        record.controller.abort();
      }
    }
  }
  return {
    getToken,
    // Invalidate only the exact credential used by a rejected request, not a
    // refreshed successor token. The next request reacquires; no HTTP replay.
    invalidate(options, token) {
      const key = keyFor(options, options.env ?? process.env);
      const current = cache.get(key);
      if (current?.token === token && !current.pending) cache.delete(key);
    },
    dispose() { for (const record of cache.values()) record.controller?.abort(); cache.clear(); },
    status() { return { cached: cache.size, pending: [...cache.values()].filter(r => r.pending).length }; },
  };
}

export function sharedAzureTokenBroker() {
  return globalThis[CACHE_SYMBOL] ||= createAzureTokenBroker();
}

export async function azureAuthHeaders(options = {}, { keyHeader = "api-key", speechResource = false, kind = "tts" } = {}) {
  const settings = azureAuthSettings({ env: options.env, options, kind });
  if (settings.auth === "key") {
    const key = String(options.apiKey ?? "").trim();
    if (!key) throw new Error("azure-speech: no API key (set the Azure speech/STT key or use auth=entra)");
    return { headers: { [keyHeader]: key }, invalidate() {} };
  }
  const broker = options.azureTokenBroker ?? sharedAzureTokenBroker();
  const request = { ...settings, env: options.env ?? process.env, signal: options.signal };
  const token = await broker.getToken(request);
  const bearer = speechResource && settings.resourceId ? `aad#${settings.resourceId}#${token}` : token;
  return { headers: { Authorization: `Bearer ${bearer}` }, invalidate: () => broker.invalidate(request, token) };
}
