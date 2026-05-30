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
  if (protocol === "beta") {
    return `${base}/openai/realtime?api-version=${encodeURIComponent(apiVersion)}&deployment=${encodeURIComponent(deployment)}`;
  }
  return `${base}/openai/v1/realtime?model=${encodeURIComponent(deployment)}&api-version=${encodeURIComponent(apiVersion)}`;
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
