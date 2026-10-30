// The editor chips' agent chip: a Cacophony agent's project and name (`cacophony▌router`), shown
// in place of the directory chip, which the project and agent already determine. A visiting
// agent's name is its id (`pi-daemon▌visiting-abcdef`); a native one's is the name its
// configuration declares (CACOPHONY_AGENT_NAME, from Cacophony), else its full id.
//
// TUI Pi knows its own identity (lib/cacophony-runtime.js: its environment, or
// /caco-agent-register). pi-client draws sessions of pi-daemons, whose variables clients never
// receive: there the identity is what agent-utils' cacophony module keeps in its session state
// (a visiting registration, or a native agent's identity from the session's variables).
import { explicitCacophonyIdentity, getCacophonyRuntimeIdentity } from "./cacophony-runtime.js";

/** The state document of agent-utils' cacophony module in a pi-daemon session (its family key). */
export const CACOPHONY_STATE_ADDRESS = Object.freeze({ kind: "pi-daemon.module-state", version: 1, scope: "session", key: "cacophony" });

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** An agent's identity from variables: `{ agentId, project, name? }`, or undefined without one. */
export function agentFromVariables(vars = {}) {
  const agentId = text(vars.CACO_AGENT_ID) || text(vars.CACOPHONY_AGENT_ID) || text(vars.CACOPHONY_AGENT);
  if (!agentId) return undefined;
  const project = text(vars.CACO_PROJECT) || text(vars.CACOPHONY_PROJECT);
  const name = text(vars.CACOPHONY_AGENT_NAME);
  return { agentId, project, ...(name ? { name } : {}) };
}

/** The chip's two halves: `{ project, name }`, the declared name before the full id. */
function chip(agent) {
  const name = text(agent?.name) || text(agent?.agentId);
  return name ? { project: text(agent?.project), name } : undefined;
}

/** TUI Pi's agent chip: its Cacophony identity, if it has one (none when Cacophony is disabled). */
export function runtimeAgentChip(env = process.env, scope) {
  const identity = getCacophonyRuntimeIdentity(env, scope);
  if (identity.disabled) return undefined;
  const fromEnv = agentFromVariables(env);
  if (identity.agentId) return chip(identity.source === "environment" && fromEnv?.agentId === identity.agentId ? fromEnv : identity);
  // An id without a project: the agent alone.
  return explicitCacophonyIdentity(env).agentId ? chip(fromEnv) : undefined;
}

/** A pi-daemon session's agent chip, from its cacophony module's state document. */
export function stateAgentChip(doc, sessionId) {
  const values = doc?.values ?? {};
  // A visiting registration in this session (a clone's copied state is not its own).
  const visiting = values.identity;
  if (text(visiting?.agentId) && (!visiting.sessionId || !sessionId || String(visiting.sessionId) === String(sessionId))) return chip(visiting);
  // A native agent: its identity as the session's variables have it.
  return values.agent ? chip(values.agent) : undefined;
}
