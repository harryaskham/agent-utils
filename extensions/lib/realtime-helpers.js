// Pure, self-contained helpers extracted from realtime-agent.js (bd-e1914a).
//
// These functions depend only on their arguments (and process.env) — no
// realtime module state or audio-format constants — so they live here to keep
// the main extension file focused on the stateful controller/wiring. Behavior
// is unchanged from the original inline definitions.

export function env(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

export function envBool(name, defaultValue = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function b64(buf) { return Buffer.from(buf).toString("base64"); }

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function realtimeUrl(baseUrl, model) {
  const wsBase = normalizeBaseUrl(baseUrl).replace(/^http/, "ws");
  return `${wsBase}/v1/realtime?model=${encodeURIComponent(model)}`;
}

export function azureRealtimeUrl(endpoint, deployment, apiVersion, protocol = "v1") {
  const base = String(endpoint || "").replace(/\/+$/, "").replace(/^http/, "ws");
  // Omit api-version entirely when it is blank / "none" / "ga" — some proxies
  // (e.g. a LiteLLM front for a GA-only realtime model) reject the dated
  // api-version and require the unversioned GA endpoint (bd-drop-api-version).
  const ver = String(apiVersion ?? "").trim();
  const omitVersion = ver === "" || ver.toLowerCase() === "none" || ver.toLowerCase() === "ga";
  if (protocol === "beta") {
    return omitVersion
      ? `${base}/openai/realtime?deployment=${encodeURIComponent(deployment)}`
      : `${base}/openai/realtime?api-version=${encodeURIComponent(ver)}&deployment=${encodeURIComponent(deployment)}`;
  }
  return omitVersion
    ? `${base}/openai/v1/realtime?model=${encodeURIComponent(deployment)}`
    : `${base}/openai/v1/realtime?model=${encodeURIComponent(deployment)}&api-version=${encodeURIComponent(ver)}`;
}

// Build the WebSocket connect headers for the realtime API (bd-0b40ce).
//
// Azure direct mode authenticates with `api-key` and never used the OpenAI-Beta
// opt-in header. For the OpenAI (non-Azure) path, OpenAI REMOVED the Realtime
// Beta interface — and the `OpenAI-Beta: realtime=v1` opt-in header — for GA on
// 2026-05-12. GA models (e.g. gpt-realtime-2) reject the beta handshake, so the
// header is OMITTED by default. Re-enable it only for a legacy / self-hosted beta
// realtime endpoint via PI_RT_BETA_HEADER=1 (config.betaHeader).
export function realtimeWsHeaders({ directAzure = false, apiKey = "", betaHeader = false } = {}) {
  // Mirror the Python websockets UA — some OpenAI-compatible WS proxies are
  // sensitive to ws' default UA.
  const userAgent = "Python/3.13 websockets/15.0.1";
  if (directAzure) {
    return { "api-key": apiKey, "User-Agent": userAgent };
  }
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": userAgent,
  };
  if (betaHeader) headers["OpenAI-Beta"] = "realtime=v1";
  return headers;
}

export function parseBooleanValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Expected boolean value, got: ${value}`);
}

export function parseRealtimeSpeed(value, fallback = 1.0) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0.25 || n > 1.5) throw new Error(`Expected realtime speed between 0.25 and 1.5, got: ${value}`);
  return n;
}

export function parseVadThreshold(value, fallback = 0.7) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`Expected realtime VAD threshold between 0 and 1, got: ${value}`);
  return n;
}

export function estimateRealtimeTokensForText(text) {
  const s = String(text ?? "");
  // Same order-of-magnitude heuristic Pi uses for preflight-style guards: a
  // token is usually ~4 chars in English/code-ish text. Add a small floor so
  // role/content wrappers are not free.
  return Math.ceil(s.length / 4) + 4;
}

export const TOOL_OUTPUT_CAP = 16_000;

export function truncateToolOutput(text, max = TOOL_OUTPUT_CAP) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[truncated ${s.length - max} chars]`;
}

export function numberEnv(name, fallback) {
  const value = Number(env(name) ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}
