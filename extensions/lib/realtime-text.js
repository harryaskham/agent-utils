// Terminal-text and failure-detection helpers extracted from realtime-agent.js
// (bd-e1914a). Pure string functions with no module state or constants:
// ANSI stripping, width-aware truncation, and auth/mic-permission detection.

export function isAuthFailure(text) {
  return /(401|403|unauthori[sz]ed|invalid[_ -]?(api[_ -]?)?key|incorrect api key|authentication failed|permission denied)/i.test(String(text || ""));
}

export function isMicPermissionFailure(text) {
  return /(microphone|avfoundation|coreaudio|audio input|input device|record).*(permission|denied|not authorized|not authorised)|Operation not permitted|EACCES|Input\/output error/i.test(String(text || ""));
}

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function truncateDiagnostic(text, limit = 300) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

export function truncateVisible(s, width) {
  if (stripAnsi(s).length <= width) return s;
  const plain = stripAnsi(s);
  return plain.slice(0, Math.max(0, width - 1)) + "…";
}

// Realtime session-start failure: the WS opened but closed (often code 1006, no
// close frame) BEFORE the first session.created event, so the upstream GA realtime
// session never established. Distinct from an auth failure or a normal mid-session
// disconnect. Folded in from bd-5406ff (msm-2 design) under bd-d0124f.
export function realtimeSessionStartFailureReason(code) {
  const c = code != null && Number.isFinite(Number(code)) ? ` (close code ${code})` : "";
  return `realtime WebSocket opened but closed before session.created${c} — the GA realtime session did not establish. Usually upstream: the LiteLLM proxy GA-realtime routing (bd-cb6625), or a wrong base_url/endpoint/api-version. Run /rt doctor; for a direct Azure GA connect use /rt azure=true (api_version=none).`;
}

export function isRealtimeSessionStartFailure(text) {
  return /closed before session\.created/i.test(String(text || ""));
}
