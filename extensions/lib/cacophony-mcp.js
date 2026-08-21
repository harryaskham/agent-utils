import { isPiCacoDisabled } from "./cacophony-runtime.js";

export const CACO_MCP_SERVER_NAME = "cacophony-runtime";

export function buildCacophonyMcpRegistration(identity = {}, env = process.env) {
  if (isPiCacoDisabled(env) || identity?.disabled) return null;
  const agentId = String(identity?.agentId || "").trim();
  const project = String(identity?.project || "").trim();
  if (!agentId || !project) return null;
  return {
    name: CACO_MCP_SERVER_NAME,
    identityKey: `${project}:${agentId}`,
    definition: {
      command: String(env.CACO_BIN || "caco"),
      args: ["mcp", "stdio"],
      env: { CACO_AGENT_ID: agentId, CACO_PROJECT: project },
      literalEnv: true,
      lifecycle: "keep-alive",
      directTools: false,
    },
  };
}
