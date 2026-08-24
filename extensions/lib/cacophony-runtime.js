const TRUE_RE = /^(1|true|yes|on|enabled)$/i;

export const CACO_AGENT_ID_FLAG = "caco-agent-id";
export const CACO_PROJECT_FLAG = "caco-project";
export const DISABLE_PI_CACO_FLAG = "disable-pi-caco";

function emptyState() {
  return { agentId: "", project: "", source: "", visiting: false };
}

// Legacy process-local context for ordinary one-session Pi. Pi-Daemon callers
// use createCacophonyRuntimeContext() per ExtensionAPI instance instead.
const legacyContext = createCacophonyRuntimeContext();

export function isPiCacoDisabled(env = process.env) {
  return TRUE_RE.test(String(env.DISABLE_PI_CACO || "").trim());
}

export function explicitCacophonyIdentity(env = process.env) {
  return {
    agentId: String(env.CACO_AGENT_ID || env.CACOPHONY_AGENT_ID || env.CACOPHONY_AGENT || "").trim(),
    project: String(env.CACO_PROJECT || env.CACOPHONY_PROJECT || "").trim(),
  };
}

export function sessionFlagEnvironment(pi, env = process.env) {
  const getFlag = typeof pi?.getFlag === "function" ? (name) => pi.getFlag(name) : () => undefined;
  const disabled = getFlag(DISABLE_PI_CACO_FLAG);
  return {
    ...env,
    ...(getFlag(CACO_AGENT_ID_FLAG) ? { CACO_AGENT_ID: String(getFlag(CACO_AGENT_ID_FLAG)) } : {}),
    ...(getFlag(CACO_PROJECT_FLAG) ? { CACO_PROJECT: String(getFlag(CACO_PROJECT_FLAG)) } : {}),
    ...(disabled !== undefined ? { DISABLE_PI_CACO: disabled ? "1" : "0" } : {}),
  };
}

export function createCacophonyRuntimeContext(env = process.env) {
  const state = emptyState();
  const listeners = new Set();
  return {
    get(runtimeEnv = env) {
      if (isPiCacoDisabled(runtimeEnv)) return { agentId: "", project: "", source: "disabled", visiting: false, disabled: true };
      // Session-published identity wins ambient process.env. This is essential
      // when several Pi-Daemon logical sessions share one Node process.
      if (state.agentId && state.project) return { ...state, disabled: false };
      const explicit = explicitCacophonyIdentity(runtimeEnv);
      if (explicit.agentId && explicit.project) return { ...explicit, source: "environment", visiting: false, disabled: false };
      return { ...state, disabled: false };
    },
    set(identity = {}) {
      const next = {
        agentId: String(identity.agentId || identity.id || "").trim(),
        project: String(identity.project || "").trim(),
        source: String(identity.source || "runtime").trim(),
        visiting: identity.visiting === true,
      };
      if (!next.agentId || !next.project) return false;
      Object.assign(state, next);
      for (const listener of [...listeners]) { try { listener({ ...state }); } catch {} }
      return true;
    },
    clear() { Object.assign(state, emptyState()); },
    on(listener) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function runtimeContextForPi(pi, env = process.env) {
  if (!pi) return legacyContext;
  if (!pi.agentUtilsCacophonyRuntime) pi.agentUtilsCacophonyRuntime = createCacophonyRuntimeContext(sessionFlagEnvironment(pi, env));
  return pi.agentUtilsCacophonyRuntime;
}

export function getCacophonyRuntimeIdentity(env = process.env, pi) { return runtimeContextForPi(pi, env).get(sessionFlagEnvironment(pi, env)); }
export function setCacophonyRuntimeIdentity(identity = {}, pi) { return runtimeContextForPi(pi).set(identity); }
export function clearCacophonyRuntimeIdentity(pi) { runtimeContextForPi(pi).clear(); }
export function onCacophonyRuntimeIdentity(listener, pi) { return runtimeContextForPi(pi).on(listener); }
