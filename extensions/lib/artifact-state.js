import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { getCacophonyRuntimeIdentity } from "./cacophony-runtime.js";

export function expandStatePath(value, env = process.env) {
  const home = env.HOME || homedir();
  const text = String(value);
  return resolve(text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text);
}

export function agentUtilsStateRoot(env = process.env) {
  return expandStatePath(env.PI_AGENT_UTILS_STATE_DIR || join(env.XDG_STATE_HOME || join(env.HOME || homedir(), ".local", "state"), "agent-utils"), env);
}

export function sharedImagesRoot(env = process.env) {
  return expandStatePath(env.PI_SHARED_IMAGES_DIR || join(agentUtilsStateRoot(env), "images"), env);
}

export function artifactIdentity(pi, ctx, env = process.env) {
  let session, name;
  try { session = ctx?.sessionManager?.getSessionId?.(); } catch {}
  try { name = pi?.getSessionName?.() || ctx?.sessionManager?.getSessionName?.(); } catch {}
  const identity = getCacophonyRuntimeIdentity(env);
  session = String(session || env.PI_SESSION_ID || `pid-${process.pid}`);
  return {
    agent: String(env.CACO_AGENT_NAME || env.CACO_SHORT_NAME || identity.agentId || name || `session-${session}`),
    session,
    host: String(env.CACO_NODE || hostname()),
    cwd: ctx?.cwd,
  };
}
