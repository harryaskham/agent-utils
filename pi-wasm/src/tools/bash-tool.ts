// Browser bash AgentTool (pi-wasm S13a, bead bd-4d085a).
//
// Routes through `env.exec()`, which delegates to the configured ExecBackend
// (S13/S14). In the no-bash MVP (no backend), exec() reports `shell_unavailable`
// and this tool throws accordingly — so it is SAFE to include but only USEFUL
// once a backend is set. Kept out of the default `createBrowserFileTools` set
// (S4 stays bash-free); include it via `createBrowserAgentTools(env, { bash: true })`
// or directly when a session selects an exec backend.

import { Type } from "typebox";
import type { AgentTool, ExecutionEnv } from "@earendil-works/pi-agent-core";
import { createBrowserFileTools } from "./browser-tools";

export function createBrowserBashTool(env: ExecutionEnv): AgentTool {
  const parameters = Type.Object({
    command: Type.String({ description: "The bash command to run." }),
    timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
  });
  return {
    name: "bash",
    label: "Bash",
    description:
      "Execute a shell command in the working directory. Availability depends on the session's execution backend (unavailable in the no-bash browser MVP).",
    parameters,
    execute: async (_toolCallId, params, signal) => {
      const { command, timeout } = params as { command: string; timeout?: number };
      const result = await env.exec(command, { timeout, abortSignal: signal });
      if (!result.ok) throw new Error(result.error.message);
      const { stdout, stderr, exitCode } = result.value;
      const sections: string[] = [];
      if (stdout) sections.push(stdout);
      if (stderr) sections.push(`[stderr]\n${stderr}`);
      sections.push(`[exit code: ${exitCode}]`);
      return { content: [{ type: "text", text: sections.join("\n") }], details: { exitCode } };
    },
  };
}

/**
 * The browser tool set for the Agent: the six file tools (S4) plus, optionally,
 * bash (only useful when a session has configured an ExecBackend; S13/S14).
 */
export function createBrowserAgentTools(env: ExecutionEnv, options?: { bash?: boolean }): AgentTool[] {
  const tools = createBrowserFileTools(env);
  if (options?.bash) tools.push(createBrowserBashTool(env));
  return tools;
}
