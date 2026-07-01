// Pi extension: agent-visible `self_compact` tool (bd-94599a, bd-d71947).
//
// Lets a long-running agent autonomously trigger compaction of its OWN
// conversation/context — equivalent to a user-issued `/compact` — without
// requiring operator intervention. It calls the documented extension
// compaction API `ctx.compact({ customInstructions })` (the 5th argument to a
// tool's `execute` is the `ExtensionContext`), which is the fire-and-forget
// trigger Pi provides for exactly this (see examples/extensions/trigger-compact.ts).
//
// bd-d71947: the previous implementation used
// `pi.sendUserMessage("/compact", { deliverAs: "followUp" })`, but that only
// REPLAYS "/compact" as a follow-up user message — it is never dispatched as a
// slash command, so no compaction actually ran.
//
// A rate-limit guard prevents duplicate/recursive compaction (no second
// self-compaction within a minimum interval), matching the pi-self-compact
// mixin's "rate-limiting + duplicate/recursive compaction prevention" contract.
//
// Disable with PI_SELF_COMPACT_TOOL=0. Override the minimum interval with
// PI_SELF_COMPACT_MIN_INTERVAL_MS (milliseconds).

import { ToolSchema } from "./lib/tool-schema.js";

const FALSE_RE = /^(0|false|off|no|disabled)$/i;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const MAX_INSTRUCTIONS_LEN = 2000;

function envBool(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !FALSE_RE.test(String(value).trim());
}

function resolveMinIntervalMs(env = process.env) {
  const raw = env.PI_SELF_COMPACT_MIN_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_MIN_INTERVAL_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MIN_INTERVAL_MS;
  return Math.floor(n);
}

// Single-line, bounded; strip control chars and any leading slashes so the
// instructions can never re-shape `/compact` into a different slash command.
export function sanitizeInstructions(raw) {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!s) return "";
  return s.replace(/^\/+/, "").slice(0, MAX_INSTRUCTIONS_LEN).trim();
}

export function buildCompactCommand(instructions) {
  const clean = sanitizeInstructions(instructions);
  return clean ? `/compact ${clean}` : "/compact";
}

export default function selfCompactExtension(pi, { now = () => Date.now() } = {}) {
  if (!envBool("PI_SELF_COMPACT_TOOL", true)) return;
  if (typeof pi.registerTool !== "function") return;

  const minIntervalMs = resolveMinIntervalMs(process.env);
  let lastQueuedAt = 0;

  // After a real compaction fires, treat that moment as the new reference point
  // so the rate-limit window measures from the most recent actual compaction.
  pi.on?.("session_compact", () => {
    lastQueuedAt = now();
  });

  pi.registerTool({
    name: "self_compact",
    label: "Self Compact",
    description:
      "Trigger compaction of this agent's own conversation context (equivalent to a user-issued /compact) so a long-running agent can free up context autonomously, without operator intervention. Optionally focus the retained summary with instructions.",
    promptSnippet:
      "Compact your own conversation context (equivalent to /compact) to free context during a long session; optionally focus the summary with instructions.",
    promptGuidelines: [
      "Use self_compact when your context is heavy in a long-running session and you want to compact-and-continue rather than request recreation or a handoff.",
      "Prefer self_compact over a context-driven handoff: compaction preserves the session and avoids spin-up overhead.",
      "Pass instructions to focus the retained summary on the current task/bead when relevant.",
      "A rate limit prevents a second self-compaction within a short interval; do not call it repeatedly in a tight loop.",
    ],
    parameters: ToolSchema.object({
      instructions: ToolSchema.optional(
        ToolSchema.string({
          description:
            "Optional instructions to focus the compaction summary (for example, on the current bead/task). Leading slashes are stripped.",
        }),
      ),
      dryRun: ToolSchema.optional(
        ToolSchema.boolean({
          description: "Report the /compact command that would be queued without actually triggering compaction.",
        }),
      ),
    }),
    async execute(_toolCallId, params = {}, _signal, _onUpdate, ctx) {
      const command = buildCompactCommand(params.instructions);
      const customInstructions = sanitizeInstructions(params.instructions) || undefined;

      if (params.dryRun) {
        return {
          content: [{ type: "text", text: `Would trigger compaction (\`${command}\`) of this agent's own context.` }],
          details: { command, queued: false, dryRun: true, minIntervalMs },
        };
      }

      const t = now();
      if (lastQueuedAt && t - lastQueuedAt < minIntervalMs) {
        const sinceMs = t - lastQueuedAt;
        const waitMs = minIntervalMs - sinceMs;
        return {
          content: [
            {
              type: "text",
              text: `Skipped self-compaction: last one was ${Math.round(sinceMs / 1000)}s ago and the minimum interval is ${Math.round(
                minIntervalMs / 1000,
              )}s (wait ~${Math.ceil(waitMs / 1000)}s). This guards against duplicate/recursive compaction.`,
            },
          ],
          details: { command, queued: false, reason: "rate_limited", sinceMs, waitMs, minIntervalMs },
        };
      }

      if (!ctx || typeof ctx.compact !== "function") {
        return {
          content: [{ type: "text", text: "Cannot self-compact: the compaction API (ctx.compact) is unavailable in this runtime." }],
          details: { command, queued: false, reason: "unsupported" },
        };
      }

      lastQueuedAt = t;
      // Real, fire-and-forget compaction trigger (bd-d71947). ctx.compact()
      // actually runs compaction; the old pi.sendUserMessage("/compact") only
      // replayed the text and never dispatched the command.
      ctx.compact({
        customInstructions,
        onError: (err) => {
          if (ctx.hasUI && typeof ctx.ui?.notify === "function") {
            ctx.ui.notify(`self-compact failed: ${err?.message || err}`, "error");
          }
        },
      });
      return {
        content: [
          {
            type: "text",
            text: `Triggering compaction (\`${command}\`) — this agent will compact its own context, equivalent to a user-issued /compact.`,
          },
        ],
        details: { command, queued: true, minIntervalMs },
      };
    },
  });
}
