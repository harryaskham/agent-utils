// Pi extension: agent-visible `self_compact` tool (bd-94599a, bd-d71947).
//
// Lets a long-running agent autonomously trigger compaction of its OWN
// conversation/context — equivalent to a user-issued `/compact` — without
// requiring operator intervention in standalone Pi. The tool returns its receipt
// first and requests normal turn termination. Only after agent_settled, outside
// the event dispatcher, may the idle context call ctx.compact(). RPC/AHP is
// deliberately unsupported until the host has correlated compact/resume control:
// calling compact() inside execute aborts its own tool/client request.
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
// bd-78ac4f: compaction is also refused below a usage threshold (default 75%)
// with no agent-controlled bypass. Agents cannot see their own context usage, and one
// session compacted at 50.1% purely on a subjective sense of "this feels
// long", throwing away half a usable window. Legitimate early-compaction cases
// exist (deliberately dropping a large one-off payload before a long
// autonomous run), so the escape hatch stays.
//
// Disable with PI_SELF_COMPACT_TOOL=0. Override the minimum interval with
// PI_SELF_COMPACT_MIN_INTERVAL_MS (milliseconds). Override the usage threshold
// with PI_SELF_COMPACT_MIN_PERCENT (0 disables the check).

import { ToolSchema } from "./lib/tool-schema.js";
import { getContextUsage, formatContextUsage } from "./lib/context-usage.js";

const FALSE_RE = /^(0|false|off|no|disabled)$/i;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_MIN_PERCENT = 75;
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

/**
 * Usage percentage below which agent-requested compaction is refused.
 *
 * `0` disables the guard entirely. Invalid values fall back to the default
 * rather than silently disabling it, so a typo cannot quietly restore the old
 * compact-at-any-time behaviour.
 */
export function resolveMinPercent(env = process.env) {
  const raw = env.PI_SELF_COMPACT_MIN_PERCENT;
  if (raw === undefined || raw === "") return DEFAULT_MIN_PERCENT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) return DEFAULT_MIN_PERCENT;
  return n;
}

/**
 * Decide whether compaction should be refused as premature.
 *
 * Unknown usage cannot establish eligibility, so it fails closed too.
 */
export function shouldRefuseCompaction(usage, minPercent) {
  if (!minPercent) return null;
  if (!usage || !usage.available || usage.percent === null) return { percent: null, minPercent };
  if (usage.percent >= minPercent) return null;
  return { percent: usage.percent, minPercent };
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

// The generic AHP bridge has no correlated compact-and-resume operation. Never
// manufacture a new autonomous turn after its owning client has observed abort.
export function selfCompactRuntimeSupported(ctx) {
  return ctx?.mode !== "rpc" && !globalThis[Symbol.for("paratenic.pi.ahp-bridge.v1")]?.enabled;
}

export default function selfCompactExtension(pi, { now = () => Date.now(), defer = (fn) => setTimeout(fn, 0), cancelDeferred = clearTimeout } = {}) {
  if (!envBool("PI_SELF_COMPACT_TOOL", true)) return;
  if (typeof pi.registerTool !== "function") return;

  const minIntervalMs = resolveMinIntervalMs(process.env);
  const minPercent = resolveMinPercent(process.env);
  let lastQueuedAt = 0;
  let sessionGeneration = 0;
  let pending = null;
  let timer = null;
  const cancelPending = () => {
    sessionGeneration++;
    if (timer !== null) cancelDeferred(timer);
    timer = null;
    pending = null;
  };
  pi.on?.("input", cancelPending);
  pi.on?.("agent_start", cancelPending);
  pi.on?.("session_shutdown", cancelPending);
  pi.on?.("agent_settled", (_event, ctx) => {
    const request = pending;
    if (!request || request.started || timer !== null) return;
    // Leave the event dispatcher before compact() -> abort() waits for it.
    timer = defer(() => {
      timer = null;
      if (pending !== request || request.generation !== sessionGeneration || request.signal?.aborted
          || !selfCompactRuntimeSupported(ctx) || ctx?.isIdle?.() !== true || ctx?.hasPendingMessages?.()) {
        pending = null;
        return;
      }
      request.started = true;
      const settle = (error) => {
        if (pending !== request || request.generation !== sessionGeneration) return;
        pending = null;
        if (error) {
          ctx?.ui?.notify?.(`self-compact failed: ${error?.message || error}. Continue manually when ready.`, "error");
          return;
        }
        if (ctx?.isIdle?.() !== true || ctx?.hasPendingMessages?.()) return;
        pi.sendMessage({
          customType: "agent-utils.self-compact-continue",
          content: "Self-compaction completed. Continue the interrupted task using the compacted summary and retained recent messages. Do not stop merely because compaction finished.",
          display: false,
          details: { toolCallId: request.toolCallId, source: "self_compact" },
        }, { triggerTurn: true, deliverAs: "followUp" });
      };
      try { ctx.compact({ customInstructions: request.customInstructions, onComplete: () => settle(), onError: settle }); }
      catch (error) { settle(error); }
    });
  });
  const syncVisibility = (_event, ctx) => {
    if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
    const visible = selfCompactRuntimeSupported(ctx) && !shouldRefuseCompaction(getContextUsage(ctx), minPercent);
    const active = pi.getActiveTools();
    if (active.includes("self_compact") === visible) return;
    pi.setActiveTools(visible ? [...active, "self_compact"] : active.filter((name) => name !== "self_compact"));
  };
  // Reevaluate before requests and after usage/model/session changes. Only
  // mutate the active set at a boundary crossing, preserving all other tools.
  for (const event of ["session_start", "before_agent_start", "turn_start", "turn_end", "model_select", "session_compact"]) {
    pi.on?.(event, syncVisibility);
  }
  const onBridgeAvailable = () => {
    cancelPending();
    if (typeof pi.getActiveTools === "function" && typeof pi.setActiveTools === "function") {
      const active = pi.getActiveTools();
      if (active.includes("self_compact")) pi.setActiveTools(active.filter(name => name !== "self_compact"));
    }
  };
  pi.events?.on?.("paratenic:ahp-bridge-available", onBridgeAvailable);
  pi.on?.("session_shutdown", () => pi.events?.off?.("paratenic:ahp-bridge-available", onBridgeAvailable));

  // After a real compaction fires, treat that moment as the new reference point
  // so the rate-limit window measures from the most recent actual compaction.
  pi.on?.("session_compact", () => {
    lastQueuedAt = now();
  });

  pi.registerTool({
    name: "self_compact",
    label: "Self Compact",
    description:
      "Queue standalone Pi context compaction via /compact after the current run settles, then continue after success. Unavailable in RPC/AHP sessions; those require controller-owned compaction. Optionally focus the retained summary with instructions.",
    promptSnippet:
      "Compact your own conversation context and automatically resume after success; optionally focus the summary with instructions.",
    promptGuidelines: [
      "Use self_compact when your context is heavy in a long-running session and you want to compact-and-continue rather than request recreation or a handoff.",
      "Prefer self_compact over a context-driven handoff: compaction preserves the session and avoids spin-up overhead.",
      "Pass instructions to focus the retained summary on the current task/bead when relevant.",
      "A rate limit prevents a second self-compaction within a short interval; do not call it repeatedly in a tight loop.",
      "Compaction is refused below the usage threshold (default 75%) because it is not free: it discards recent detail and forces re-orientation. Check context_usage first. There is no agent-controlled bypass; the operator can still use /compact manually.",
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
      const usage = getContextUsage(ctx);

      if (params.dryRun) {
        return {
          content: [{ type: "text", text: `Would trigger compaction (\`${command}\`) of this agent's own context. Context: ${formatContextUsage(usage)}.` }],
          details: { command, queued: false, dryRun: true, minIntervalMs, minPercent, usage },
        };
      }

      // Refuse premature compaction before the rate-limit check: "you are only
      // half full" is the more useful answer than "wait 20s".
      const premature = shouldRefuseCompaction(usage, minPercent);
      if (premature) {
        if (premature.percent === null) {
          return {
            content: [{ type: "text", text: "Refused self-compaction: context usage is unknown; cannot establish threshold eligibility. The operator can still use /compact manually." }],
            details: { command, queued: false, reason: "usage_unknown", minPercent, usage },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Refused self-compaction: context is only ${premature.percent.toFixed(
                1,
              )}% used, below the ${premature.minPercent}% threshold (${formatContextUsage(
                usage,
              )}). Compaction discards recent detail and forces a re-orientation pass, so compacting now would waste the rest of a usable window. Wait until the threshold is reached; the operator can still use /compact manually.`,
            },
          ],
          details: {
            command,
            queued: false,
            reason: "below_threshold",
            minPercent: premature.minPercent,
            usage,
          },
        };
      }

      if (pending) return {
        content: [{ type: "text", text: "Self-compaction is already pending; no second request was queued." }],
        details: { command, queued: false, reason: "pending" },
      };
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

      if (!ctx || typeof ctx.compact !== "function" || typeof ctx.isIdle !== "function" || !selfCompactRuntimeSupported(ctx)) {
        return {
          content: [{ type: "text", text: "Cannot self-compact safely in this runtime. RPC/AHP clients must use their controller-owned compaction path; the generic bridge does not provide correlated compact-and-resume. Manual /compact remains available." }],
          details: { command, queued: false, reason: "unsupported" },
        };
      }

      lastQueuedAt = t;
      pending = { toolCallId: _toolCallId, customInstructions, generation: sessionGeneration, signal: _signal, started: false };
      return {
        content: [
          {
            type: "text",
            text: `Queued compaction (\`${command}\`) — compaction will start only after this tool result and the agent run settle. Context: ${formatContextUsage(
              usage,
            )}. The agent will resume automatically after successful compaction.`,
          },
        ],
        details: { command, queued: true, minIntervalMs, minPercent, usage },
        terminate: true,
      };
    },
  });
}
