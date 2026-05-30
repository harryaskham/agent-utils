// Realtime session-status / context-diagnostics formatters extracted from
// realtime-agent.js (bd-e1914a). These turn a session + config into the
// next-step hint, mic-capture summary, and context-window diagnostics shown in
// the status panel. Pure over their inputs; deps come from realtime-models
// (model detection) and realtime-summary (token estimation).

import { isRealtimeModel } from "./realtime-models.js";
import {
  REALTIME_CONTEXT_WINDOW_TOKENS,
  estimateRealtimeContextTokens,
  estimateRealtimeSummaryContextTokens,
} from "./realtime-summary.js";

export function realtimeNextStepHint(session, config) {
  if (session.mic) {
    const action = session.micMode === "ptt" ? "/rt-stop sends PTT audio" : "/rt-stop commits current mic buffer";
    return `${action}; /rt-cancel discards; /rt-off closes session`;
  }
  if (session.connected || session.connecting) return "/rt mic vad starts listening; /rt-stop closes socket; /rt-off restores text model";
  if (config.sttOnly) return "/rt stt vad starts speech-to-text; /rt-off clears realtime state";
  return "/rt start vad begins realtime; /rt stt ptt transcribes into current model; /rt-doctor checks setup";
}

export function micCaptureSummary(session) {
  if (!session.mic) return "inactive";
  const bytes = session.lastMicBytes || 0;
  const mode = session.micMode || "on";
  return `${mode} active · ${bytes} bytes${bytes === 0 ? " · waiting for audio" : ""}`;
}

export function realtimeContextDiagnostics(session, config) {
  const ctx = session.lastCtx || {};
  const model = isRealtimeModel(ctx.model) ? ctx.model : null;
  const contextWindow = Number(model?.contextWindow || REALTIME_CONTEXT_WINDOW_TOKENS);
  const settings = ctx.settingsManager?.getCompactionSettings?.();
  const reserveTokens = Number(settings?.reserveTokens ?? 16_384);
  const thresholdTokens = Math.max(0, contextWindow - reserveTokens);
  const messages = ctx.agent?.state?.messages || ctx.sessionManager?.buildSessionContext?.()?.messages || null;
  const context = messages
    ? { systemPrompt: ctx.agent?.systemPrompt || ctx.systemPrompt || "", messages, tools: ctx.tools || [] }
    : null;
  const fullTokens = context ? estimateRealtimeContextTokens(context) : null;
  const summaryTokens = context ? estimateRealtimeSummaryContextTokens(context) : null;
  const pct = (tokens) => tokens == null || !contextWindow ? "n/a" : `${((tokens / contextWindow) * 100).toFixed(1)}%`;
  const thresholdPct = contextWindow ? `${((thresholdTokens / contextWindow) * 100).toFixed(1)}%` : "n/a";
  return {
    contextWindow,
    reserveTokens,
    keepRecentTokens: settings?.keepRecentTokens ?? null,
    thresholdTokens,
    thresholdPct,
    fullTokens,
    fullPct: pct(fullTokens),
    summaryTokens,
    summaryPct: pct(summaryTokens),
  };
}

export function realtimeContextDiagnosticLine(session, config) {
  const d = realtimeContextDiagnostics(session, config);
  const observed = d.fullTokens == null
    ? "estimate:n/a"
    : `full:${d.fullTokens.toLocaleString()} (${d.fullPct}) · summary:${d.summaryTokens.toLocaleString()} (${d.summaryPct})`;
  return `context: window:${d.contextWindow.toLocaleString()} · compactAt:${d.thresholdTokens.toLocaleString()} (${d.thresholdPct}) · reserve:${d.reserveTokens.toLocaleString()}${d.keepRecentTokens != null ? ` · keep:${Number(d.keepRecentTokens).toLocaleString()}` : ""} · ${observed}`;
}
