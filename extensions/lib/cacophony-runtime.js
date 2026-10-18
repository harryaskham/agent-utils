import { isIncognito } from "./privacy.js";

const TRUE_RE = /^(1|true|yes|on|enabled)$/i;

// A module can be shared by several logical Pi-Daemon sessions. Never keep a
// process-wide "current visitor", or key it by cwd/inherited PI_SESSION_ID.
const identities = new Map();
const listeners = new Set();
const emptyIdentity = () => ({ agentId: "", project: "", source: "", visiting: false });

export function cacophonySessionId(scope) {
  try {
    const value = typeof scope === "function" ? scope() : scope;
    return String(typeof value === "string" ? value : value?.sessionManager?.getSessionId?.() || "").trim();
  } catch { return ""; }
}

export function isPiCacoDisabled(env = process.env) {
  return isIncognito(env) || TRUE_RE.test(String(env.DISABLE_PI_CACO || "").trim());
}

export function explicitCacophonyIdentity(env = process.env) {
  return {
    agentId: String(env.CACO_AGENT_ID || env.CACOPHONY_AGENT_ID || env.CACOPHONY_AGENT || "").trim(),
    project: String(env.CACO_PROJECT || env.CACOPHONY_PROJECT || "").trim(),
  };
}

export function getCacophonyRuntimeIdentity(env = process.env, scope) {
  if (isPiCacoDisabled(env)) return { ...emptyIdentity(), source: "disabled", disabled: true };
  const explicit = explicitCacophonyIdentity(env);
  if (explicit.agentId && explicit.project) return { ...explicit, source: "environment", visiting: false, disabled: false };
  const stored = identities.get(cacophonySessionId(scope));
  return { ...(stored?.identity || emptyIdentity()), disabled: false };
}

function publish(sessionId, identity) {
  for (const { listener, scope } of [...listeners]) {
    if (cacophonySessionId(scope) !== sessionId) continue;
    try { listener({ ...identity }); } catch {}
  }
}

// A replacement extension runtime takes custody of the same session without
// allowing its predecessor's late CLI completion or shutdown to overwrite it.
export function ownCacophonyRuntimeSession(scope, owner) {
  const sessionId = cacophonySessionId(scope);
  if (!sessionId) return () => false;
  identities.set(sessionId, { identity: identities.get(sessionId)?.identity, owner });
  return () => identities.get(sessionId)?.owner === owner;
}

export function setCacophonyRuntimeIdentity(identity = {}, scope = identity.sessionId, owner) {
  const sessionId = cacophonySessionId(scope);
  if (owner !== undefined && identities.get(sessionId)?.owner !== owner) return false;
  const next = {
    agentId: String(identity.agentId || identity.id || "").trim(),
    project: String(identity.project || "").trim(),
    source: String(identity.source || "runtime").trim(),
    visiting: identity.visiting === true,
    sessionId,
  };
  if (!next.agentId || !next.project || !sessionId) return false;
  identities.set(sessionId, { identity: next, owner });
  publish(sessionId, next);
  return true;
}

export function clearCacophonyRuntimeIdentity(scope, owner) {
  const sessionId = cacophonySessionId(scope);
  // No-argument clearing is useful for hermetic test cleanup, never discovery.
  const keys = scope === undefined ? [...identities.keys()] : [sessionId];
  for (const key of keys) {
    if (!identities.has(key) || (owner !== undefined && identities.get(key).owner !== owner)) continue;
    identities.delete(key);
    publish(key, { ...emptyIdentity(), sessionId: key });
  }
}

export function onCacophonyRuntimeIdentity(listener, scope) {
  if (typeof listener !== "function") return () => {};
  const subscription = { listener, scope };
  listeners.add(subscription);
  return () => listeners.delete(subscription);
}
