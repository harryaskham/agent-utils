const TRUE_RE = /^(1|true|yes|on|enabled)$/i;

const state = {
  agentId: "",
  project: "",
  source: "",
  visiting: false,
};
const listeners = new Set();

export function isPiCacoDisabled(env = process.env) {
  return TRUE_RE.test(String(env.DISABLE_PI_CACO || "").trim());
}

export function explicitCacophonyIdentity(env = process.env) {
  return {
    agentId: String(env.CACO_AGENT_ID || env.CACOPHONY_AGENT_ID || env.CACOPHONY_AGENT || "").trim(),
    project: String(env.CACO_PROJECT || env.CACOPHONY_PROJECT || "").trim(),
  };
}

export function getCacophonyRuntimeIdentity(env = process.env) {
  if (isPiCacoDisabled(env)) return { agentId: "", project: "", source: "disabled", visiting: false, disabled: true };
  const explicit = explicitCacophonyIdentity(env);
  if (explicit.agentId && explicit.project) return { ...explicit, source: "environment", visiting: false, disabled: false };
  return { ...state, disabled: false };
}

export function setCacophonyRuntimeIdentity(identity = {}) {
  const next = {
    agentId: String(identity.agentId || identity.id || "").trim(),
    project: String(identity.project || "").trim(),
    source: String(identity.source || "runtime").trim(),
    visiting: identity.visiting === true,
  };
  if (!next.agentId || !next.project) return false;
  Object.assign(state, next);
  for (const listener of [...listeners]) {
    try { listener({ ...state }); } catch {}
  }
  return true;
}

export function clearCacophonyRuntimeIdentity() {
  Object.assign(state, { agentId: "", project: "", source: "", visiting: false });
}

export function onCacophonyRuntimeIdentity(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
