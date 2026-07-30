// Pi extension: agent-visible `context_usage` tool (bd-78ac4f).
//
// Agents cannot see how full their own context window is, so decisions about
// when to compact are made blind. An operator-proxy session triggered
// self_compact at 50.1% used purely on a subjective sense of "this feels
// long", wasting half a usable window. Compaction is not free: it discards
// fine detail and forces a re-orientation pass.
//
// This exposes the live figure Pi already tracks (`ctx.getContextUsage()`) so
// the decision can be made on data. It is read-only and side-effect free.
//
// Disable with PI_CONTEXT_USAGE_TOOL=0.

import { ToolSchema } from "./lib/tool-schema.js";
import { getContextUsage, formatContextUsage } from "./lib/context-usage.js";

const FALSE_RE = /^(0|false|off|no|disabled)$/i;

function envBool(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !FALSE_RE.test(String(value).trim());
}

export default function contextUsageExtension(pi) {
  if (!envBool("PI_CONTEXT_USAGE_TOOL", true)) return;
  if (typeof pi.registerTool !== "function") return;

  pi.registerTool({
    name: "context_usage",
    label: "Context Usage",
    description:
      "Report this agent's own context-window usage: tokens used, window size, percentage used, and tokens remaining. Use it to decide whether compaction is actually warranted instead of guessing.",
    promptSnippet:
      "Check your own context usage (tokens used, window size, percent full) before deciding whether to compact.",
    promptGuidelines: [
      "Call context_usage before self_compact so the decision is based on the real figure rather than a feeling that the session is long.",
      "Compaction is not free: it discards recent detail and forces re-orientation, so prefer continuing while there is ample window left.",
    ],
    parameters: ToolSchema.object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const usage = getContextUsage(ctx);
      return {
        content: [{ type: "text", text: `Context: ${formatContextUsage(usage)}.` }],
        details: usage,
      };
    },
  });
}
