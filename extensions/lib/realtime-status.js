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
import {
  audioInputBackendLabel,
  audioOutputBackendLabel,
  defaultRecordCommand,
  defaultPlaybackCommand,
} from "./realtime-audio.js";
import { normalizeBaseUrl, numberEnv } from "./realtime-helpers.js";

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

export function statusLines(session, config, { full = false } = {}) {
  const conn = session.connected ? "●" : (session.connecting ? "◐" : "○");
  const mic = session.mic ? `mic:${session.micMode || "on"}` : "mic:off";
  const provider = config.directAzure ? "azure" : "proxy";
  const outBackend = audioOutputBackendLabel(config);
  const inBackend = audioInputBackendLabel(config);
  const reason = config.reasoningEffort === "off"
    ? ""
    : ` · reason:${config.reasoningEffort}${session.reasoningRejected ? "!" : ""}${(!config.directAzure && !config.sendReasoning) ? " unsent" : ""}`;
  const speed = config.speed && config.speed !== 1 ? ` · speed:${config.speed}${session.speedRejected ? "!" : ""}` : "";
  const phase = session.phase && session.phase !== "idle" ? ` · ${session.phase}` : "";
  const clip = session.latestClipId ? ` · clip:${session.latestClipId}` : "";
  const mode = session.state?.mode?.({ sttOnly: config.sttOnly }) || (config.sttOnly ? "stt" : "connected");
  const restore = config.previousModel ? ` · ↩${config.previousModel.provider}/${config.previousModel.id}` : "";
  const summary = config.summaryContext ? "summary:on" : "summary:off";
  const chime = config.chimeEnabled ? "chime:on" : "chime:off";
  const input = session.lastTurnInputMode ? ` · input:${session.lastTurnInputMode}` : "";
  const compact = [
    `${conn} rt ${config.model} · mode:${mode} · audio:${config.audioEnabled ? "on" : "off"} · ${mic} · backend:${outBackend}/${inBackend}${phase}`,
    `trans:${config.transcriptionModel} · voice:${config.voice}${speed} · hist:${session.forwardedMessageCount} · ${summary} · ${chime}${input} · ${provider}${reason}${clip}${restore}`,
    `mic capture: ${micCaptureSummary(session)} · next: ${realtimeNextStepHint(session, config)}`,
  ];
  if (!full) return compact;
  return [
    ...compact,
    `baseUrl: ${normalizeBaseUrl(config.baseUrl)}`,
    realtimeContextDiagnosticLine(session, config),
    `azureEndpoint: ${config.azureEndpoint || "<unset>"}`,
    `azureDeployment: ${config.azureDeployment || config.model}`,
    `record: ${config.recordCommand || defaultRecordCommand()}`,
    `playback: ${config.playbackCommand || defaultPlaybackCommand()}`,
    `playbackStarted: ${config.lastPlaybackStartedAt ? new Date(config.lastPlaybackStartedAt).toLocaleTimeString() : "<never>"}`,
    `nextStep: ${realtimeNextStepHint(session, config)}`,
    `playbackExit: ${config.lastPlaybackExit || "<none>"}`,
    `playbackError: ${config.lastPlaybackError || "<none>"}`,
  ];
}

export function realtimePanelLines(session, config) {
  const compact = statusLines(session, config);
  const threshold = config.vadThreshold ?? numberEnv("PI_RT_VAD_THRESHOLD", 0.7);
  const speed = config.speed && config.speed !== 1 ? `${config.speed}` : "1";
  return [
    ...compact,
    `vad: thresh:${threshold} · silence:${numberEnv("PI_RT_VAD_SILENCE_MS", 1100)}ms · chime:${config.chimeEnabled ? "on" : "off"} · speed:${speed}`,
    `pulse: server:${process.env.PULSE_SERVER || "<unset>"} · source:${process.env.PULSE_SOURCE || "<default>"} · sink:${process.env.PULSE_SINK || "<default>"}`,
    `next: ${realtimeNextStepHint(session, config)}`,
    "controls: /rt-stop · /rt-cancel · /rt mic vad · /rt audio toggle · /rt thresh=0.85 · /rt status full · /rt off",
  ];
}
