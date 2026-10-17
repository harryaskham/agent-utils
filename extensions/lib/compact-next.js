// One-shot operator compaction. Never call ctx.compact() from a live turn:
// that API aborts and waits for the very dispatcher we would be running in.
// Pi's actionable boundary commits a compaction draft before the next request;
// older hosts fall back to an out-of-dispatcher, idle-only manual compaction.
import { parseEnvStyleArgs } from "./env-args.js";

const STATUS = "agent-utils-compact-next";
const HELP = "/compact-next [resume=auto|none|continue|off] [summary instructions] | status | cancel";
const CONTINUE_TYPE = "agent-utils.compact-next-continue";

export function parseCompactNextArgs(input) {
  const text = String(input ?? "").trim();
  if (["status", "cancel", "off", "help"].includes(text)) return { action: text === "off" ? "cancel" : text };
  let resume = "auto";
  const instructions = [];
  for (const token of parseEnvStyleArgs(text).tokens) {
    if (token.startsWith("resume=")) resume = token.slice(7);
    else instructions.push(token);
  }
  if (!["auto", "none", "continue", "off"].includes(resume)) {
    throw new Error(`Unsupported resume mode (empty prompts are not portable). ${HELP}`);
  }
  return { action: "queue", resume, customInstructions: instructions.join(" ") || undefined };
}

// Work from Pi's finalized projection, never raw messages hidden by context edits.
// Retain a recent suffix starting at a user/assistant/custom message, never at a
// tool result. Always retain the just-completed assistant + its whole tool batch.
export function selectCompactNextPrefix(projected, keepRecentTokens, estimateTokens, currentMessageId) {
  let tokens = 0;
  let target = projected.length - 1;
  for (let i = projected.length - 1; i >= 0; i--) {
    tokens += projected[i].messages.reduce((sum, message) => sum + estimateTokens(message), 0);
    target = i;
    if (tokens >= keepRecentTokens) break;
  }
  const current = projected.findIndex(entry => entry.sourceEntry.id === currentMessageId);
  if (current >= 0) target = Math.min(target, current);
  const isCut = entry => entry.sourceEntry.type !== "compaction" && entry.messages.some(message =>
    ["user", "assistant", "custom", "bashExecution", "branchSummary"].includes(message.role));
  let cut = projected.findIndex((entry, i) => i >= target && isCut(entry));
  if (current >= 0 && cut > current) cut = current;
  if (cut < 0) throw new Error("No safe retained-message boundary");
  const messages = projected.slice(0, cut).flatMap(entry => entry.messages).filter(message => message.role !== "system");
  if (!messages.length) throw new Error("Nothing to compact before the retained recent messages");
  return { messages, firstKeptEntryId: projected[cut].sourceEntry.id };
}

export async function summarizeCompactNextBoundary(event, ctx, request, signal, host) {
  const { SettingsManager, getAgentDir, estimateTokens, generateSummaryWithUsage } = host;
  if (!ctx.model) throw new Error("No model selected");
  const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted?.() === true });
  const { keepRecentTokens, reserveTokens } = settings.getCompactionSettings(ctx.model);
  const prefix = selectCompactNextPrefix(event.context.contextEntries, keepRecentTokens, estimateTokens, event.messageEntryId);
  // A preceding boundary extension may propose a compaction with preview-only
  // IDs. Never persist a reference that does not exist in the real branch.
  if (!ctx.sessionManager.getBranch().some(entry => entry.id === prefix.firstKeptEntryId)) {
    throw new Error("Retained boundary changed by another extension; retry /compact-next");
  }
  const result = await generateSummaryWithUsage(
    prefix.messages, ctx.model, reserveTokens, undefined, undefined, signal,
    request.customInstructions, undefined, ctx.thinkingLevel,
    (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
    undefined, undefined, undefined, ctx.sessionManager.getSessionId(),
  );
  return {
    type: "compaction", summary: result.text, firstKeptEntryId: prefix.firstKeptEntryId,
    usage: result.usage, details: { source: "compact-next" },
  };
}

function continueMessage(display = false) {
  return { customType: CONTINUE_TYPE, content: "Continue.", display };
}

// Detached manual compaction cannot preserve the controller's active RPC/AHP
// request. Actionable turn boundaries can, and need no bridge-specific state.
function supportsIdleCompaction(ctx) {
  const bridged = process.env.PI_DISABLE_AHP !== "1" && globalThis[Symbol.for("paratenic.pi.ahp-bridge.v1")]?.enabled;
  return ctx?.mode !== "rpc" && !bridged;
}

export default function compactNextExtension(pi, {
  summarize,
  defer = fn => setTimeout(fn, 0),
  cancelDeferred = clearTimeout,
} = {}) {
  let pending = null;
  let timer = null;
  const notify = (ctx, text, level = "info") => ctx?.ui?.notify?.(text, level);
  const status = ctx => ctx?.ui?.setStatus?.(STATUS, pending ? `compact-next · ${pending.phase} · ${pending.resume}` : undefined);
  const clear = ctx => {
    const old = pending;
    pending = null;
    if (timer !== null) cancelDeferred(timer);
    timer = null;
    old?.controller?.abort();
    status(ctx);
  };
  const sameSession = (request, ctx) => pending === request && request.sessionId === ctx.sessionManager.getSessionId();

  const scheduleIdle = ctx => {
    if (!pending || pending.phase !== "queued" || timer !== null) return;
    const request = pending;
    timer = defer(() => {
      timer = null;
      if (!sameSession(request, ctx)) return;
      // A new prompt can win the race out of the dispatcher. Leave the request
      // queued for its next boundary instead of aborting that new work.
      if (ctx.isIdle?.() !== true || ctx.hasPendingMessages?.()) return;
      if (!supportsIdleCompaction(ctx)) {
        clear(ctx);
        notify(ctx, "compact-next: this host needs an active actionable turn boundary; idle RPC/AHP compaction belongs to the controller.", "warning");
        return;
      }
      request.phase = "compacting";
      status(ctx);
      const finish = error => {
        if (!sameSession(request, ctx)) return;
        clear(ctx);
        if (error) { notify(ctx, `compact-next failed: ${error.message || error}`, "error"); return; }
        notify(ctx, "compact-next: compacted");
        if (request.resume === "off") return;
        if (request.resume === "none") {
          notify(ctx, "compact-next: idle host has no prompt-free resume API; left idle. Use resume=auto or resume=continue to start a turn.", "warning");
          return;
        }
        if (ctx.isIdle?.() !== true || ctx.hasPendingMessages?.()) return;
        try {
          pi.sendMessage(continueMessage(request.resume === "continue"), { triggerTurn: true, deliverAs: "followUp" });
        } catch (error) { notify(ctx, `compact-next resume failed: ${error.message || error}`, "error"); }
      };
      try { ctx.compact({ customInstructions: request.customInstructions, onComplete: () => finish(), onError: finish }); }
      catch (error) { finish(error); }
    });
  };

  const boundary = async (event, ctx) => {
    const request = pending;
    if (!request || request.phase !== "queued") return;
    const outcome = event.outcome ?? event.message?.stopReason;
    if (outcome === "aborted" || outcome === "error" || ctx.signal?.aborted) {
      clear(ctx);
      notify(ctx, "compact-next: cancelled because the run stopped or failed");
      return;
    }
    // Pre-actionable-boundary Pi ignores return values from turn_end. Do not
    // summarize or try to compact there; agent_settled is the fallback.
    if (!event.context || !Array.isArray(event.entries) || typeof event.context.canContinue !== "boolean") return;
    if (!sameSession(request, ctx)) { clear(ctx); return; }
    if (timer !== null) cancelDeferred(timer);
    timer = null;
    request.phase = "compacting";
    request.controller = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, request.controller.signal]) : request.controller.signal;
    const leaf = ctx.sessionManager.getLeafId();
    status(ctx);
    try {
      const draft = await summarize(event, ctx, request, signal);
      if (!sameSession(request, ctx) || signal.aborted) {
        if (pending === request) clear(ctx);
        return;
      }
      if (ctx.sessionManager.getLeafId() !== leaf) throw new Error("Session branch changed during summary; retry /compact-next");
      const entries = [...event.entries, draft];
      const canContinue = event.context.canContinue || ctx.hasPendingMessages?.();
      const addMessage = request.resume === "continue" || (request.resume === "auto" && !canContinue);
      if (addMessage) entries.push({ type: "custom_message", ...continueMessage(request.resume === "continue") });
      const resume = request.resume !== "off" && (canContinue || addMessage);
      clear(ctx);
      notify(ctx, "compact-next: summary ready; applying at this boundary");
      if (request.resume === "none" && !canContinue) {
        notify(ctx, "compact-next: retained context ends with an assistant message; no prompt-free continuation is possible. Left settled.", "warning");
      }
      // Preserve earlier extensions' entries and continuation requests. off
      // means no *extra* turn, not cancelling the tool loop or other work.
      return { entries, continue: Boolean(event.continue || resume) };
    } catch (error) {
      if (!sameSession(request, ctx)) return;
      const aborted = signal.aborted;
      clear(ctx);
      notify(ctx, aborted ? "compact-next: cancelled" : `compact-next failed: ${error.message || error}; current work continues unchanged.`, aborted ? "info" : "error");
    }
  };

  pi.registerCommand("compact-next", {
    description: `Compact at the next safe turn/tool-batch boundary, then resume. ${HELP}`,
    handler: async (args, ctx) => {
      let parsed;
      try { parsed = parseCompactNextArgs(args); }
      catch (error) { notify(ctx, error.message, "warning"); return; }
      if (parsed.action === "help") { notify(ctx, HELP); return; }
      if (parsed.action === "status") {
        notify(ctx, pending ? `compact-next: ${pending.phase} · resume=${pending.resume}` : "compact-next: idle");
        return;
      }
      if (parsed.action === "cancel") {
        const inFlightManual = pending?.phase === "compacting" && !pending.controller;
        clear(ctx);
        notify(ctx, inFlightManual ? "compact-next: resume cancelled; already-started manual compaction is left to finish" : "compact-next: cancelled");
        return;
      }
      if (pending) { notify(ctx, "compact-next: already pending; cancel first to change it"); return; }
      pending = { ...parsed, phase: "queued", sessionId: ctx.sessionManager.getSessionId() };
      status(ctx);
      notify(ctx, "compact-next: queued for the next safe boundary (older Pi: waits until idle)");
      if (ctx.isIdle?.()) scheduleIdle(ctx);
    },
  });
  pi.on("turn_end", boundary);
  pi.on("agent_before_settle", boundary);
  pi.on("agent_settled", (event, ctx) => {
    if (event.aborted) { clear(ctx); return; }
    scheduleIdle(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    if (pending?.phase !== "queued") return;
    clear(ctx);
    notify(ctx, "compact-next: satisfied by another compaction");
  });
  for (const name of ["session_start", "session_switch", "session_fork", "session_tree", "session_shutdown"]) {
    pi.on(name, (_event, ctx) => clear(ctx));
  }
}
