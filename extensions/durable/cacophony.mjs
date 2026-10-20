// Durable adaptor: Cacophony visiting registration for pi-daemon sessions (bd-cab485).
//
// List this file in a pi-daemon profile's `extensions:`. `/caco-agent-register [project=…]`
// (or, with PI_CACO_AUTO_REGISTER / agentUtils.cacophony.autoRegister, the session's first run)
// registers the session as a Cacophony visiting agent; its shell and the caco MCP server then run
// with CACO_AGENT_ID and CACO_PROJECT, and a system prompt section names the agent. `/caco-runtime`
// shows the identity. Needs pi-daemon 1.12 or later (per-session environment overrides).
import { createCacophonyModule } from "../lib/durable-cacophony.js";

const module = createCacophonyModule();

export const extension = module.extension;
export const commands = module.commands;
export function observe(event, info) {
  return module.observe(event, info);
}
