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
import { formatLevelLabel } from "./realtime-audio-meter.js";
import { spawnSync } from "node:child_process";
import { truncateDiagnostic, isAuthFailure, isMicPermissionFailure } from "./realtime-text.js";

// Collapse whitespace and bound a free-text reason for a compact status line so
// a long disconnect/error string cannot blow out the single-line status render.
export function shortReason(value, max = 48) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}\u2026` : text;
}

export function realtimeNextStepHint(session, config) {
  const base = realtimeNextStepBase(session, config);
  // When a recent mic/response error is recorded, point the operator at the
  // doctor so the next-step hint stays actionable instead of silent on failure.
  const hasError = !!(session?.lastMicError || session?.lastResponseError);
  return hasError ? `${base} \u00b7 /rt-doctor diagnoses the recent error` : base;
}

function realtimeNextStepBase(session, config) {
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
  // "Show audio input": render the live smoothed input level (written in the
  // mic-capture path as session.inputLevel, 0..1) via the shared meter
  // formatter. Defensive: only when a finite level is present, so synthetic
  // sessions / pre-capture states keep the byte-only summary.
  const level = Number.isFinite(session.inputLevel)
    ? ` · level:${formatLevelLabel(session.inputLevel, { width: 8 })}`
    : "";
  return `${mode} active · ${bytes} bytes${level}${bytes === 0 ? " · waiting for audio" : ""}`;
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
  // Connection robustness/UX: surface an in-flight reconnect or a recorded drop
  // reason in the compact view so a flapping socket is visible without /rt status
  // full. Reconnect bookkeeping lives on config (see diagnosticLines); fall back
  // to session for safety.
  const reconnectAttempts = Number(config.reconnectAttempts ?? session.reconnectAttempts ?? 0) || 0;
  const reconnectMax = Number(config.reconnectMaxAttempts ?? session.reconnectMaxAttempts ?? 0) || 0;
  const disconnectReason = config.lastDisconnectReason || session.lastDisconnectReason || "";
  const reconnecting = (session.connecting && reconnectAttempts > 0)
    ? ` · reconnecting:${reconnectAttempts}${reconnectMax ? `/${reconnectMax}` : ""}`
    : "";
  const dropped = (!session.connected && !session.connecting && disconnectReason)
    ? ` · dropped:${shortReason(disconnectReason)}`
    : "";
  const compact = [
    `${conn} rt ${config.model} · mode:${mode} · audio:${config.audioEnabled ? "on" : "off"} · ${mic} · backend:${outBackend}/${inBackend}${phase}${reconnecting}${dropped}`,
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

export function commandAvailable(name) {
  const result = spawnSync("/bin/sh", ["-lc", `command -v ${name} >/dev/null 2>&1`], { encoding: "utf8" });
  return result.status === 0;
}

export function envPresent(...names) {
  return names.find((name) => !!process.env[name]);
}

export function diagnosticLines(session, config) {
  const provider = config.directAzure ? "azure" : "openai/proxy";
  const backend = process.env.PI_RT_AUDIO_BACKEND || "pulse";
  const record = config.recordCommand || defaultRecordCommand();
  const playback = config.playbackCommand || defaultPlaybackCommand();
  const apiKey = config.directAzure
    ? envPresent("PI_RT_AZURE_API_KEY", "AZURE_CANADACENTRAL_API_KEY", "AZURE_OPENAI_API_KEY")
    : envPresent("PI_RT_API_KEY", "OPENAI_API_KEY");
  const requirements = [
    `parec:${commandAvailable("parec") ? "ok" : "missing"}`,
    `pacat:${commandAvailable("pacat") ? "ok" : "missing"}`,
    `ffmpeg:${commandAvailable("ffmpeg") ? "ok" : "missing"}`,
    `ffplay:${commandAvailable("ffplay") ? "ok" : "missing"}`,
    `sox-rec:${commandAvailable("rec") ? "ok" : "missing"}`,
  ].join(" · ");
  const pulse = [
    `PULSE_SERVER=${process.env.PULSE_SERVER || "<unset>"}`,
    `PULSE_SOURCE=${process.env.PULSE_SOURCE || "<default>"}`,
    `PULSE_SINK=${process.env.PULSE_SINK || "<default>"}`,
  ].join(" · ");
  const hints = [];
  const responseError = truncateDiagnostic(session.lastResponseError || "");
  const micError = truncateDiagnostic(session.lastMicError || "");
  const playbackError = truncateDiagnostic(config.lastPlaybackError || "");
  if (!apiKey) hints.push(config.directAzure ? "auth: set PI_RT_AZURE_API_KEY or AZURE_OPENAI_API_KEY" : "auth: set OPENAI_API_KEY or PI_RT_API_KEY");
  if (responseError && isAuthFailure(responseError)) hints.push("auth: realtime server rejected credentials; refresh the API key/token and retry /rt-doctor");
  if (/\bparec\b/.test(record) && !commandAvailable("parec")) hints.push("audio input: install PulseAudio tools (macOS: brew install pulseaudio) or set PI_RT_RECORD_CMD");
  if (/\bpacat\b/.test(playback) && !commandAvailable("pacat")) hints.push("audio output: install PulseAudio tools (macOS: brew install pulseaudio) or set PI_RT_PLAYBACK_CMD");
  if (/ffmpeg/.test(record) && !commandAvailable("ffmpeg")) hints.push("audio input: install ffmpeg for CoreAudio/AVFoundation capture or set PI_RT_RECORD_CMD");
  if (/ffplay/.test(playback) && !commandAvailable("ffplay")) hints.push("audio output: install ffmpeg/ffplay or set PI_RT_PLAYBACK_CMD");
  if ((micError || playbackError) && isMicPermissionFailure(`${micError}\n${playbackError}`)) hints.push("macOS audio permission: grant microphone/accessibility permission to the terminal/Pi process, then restart Pi");
  if (micError && /No such file|not found|command not found/i.test(micError)) hints.push("audio input: record command failed to start; check PI_RT_RECORD_CMD and PATH");
  if (playbackError && /No such file|not found|command not found/i.test(playbackError)) hints.push("audio output: playback command failed to start; check PI_RT_PLAYBACK_CMD and PATH");
  if (backend === "pulse") hints.push(process.env.PULSE_SERVER
    ? "Pulse-first setup active; confirm phone sink/source with PULSE_SINK/PULSE_SOURCE if audio routes incorrectly"
    : "Pulse is the default backend; if using phone sink/source, set/confirm PULSE_SERVER/SINK/SOURCE, or override PI_RT_AUDIO_BACKEND for local devices");
  if (session.phase === "transcribing" && session.pendingCommitTimer) hints.push("waiting for transcription; /rt-cancel discards stuck mic input");
  const reconnectAttempts = Number(config.reconnectAttempts || 0) || 0;
  const reconnectMax = Number(config.reconnectMaxAttempts || 0) || 0;
  if (config.autoReconnect && reconnectMax > 0 && reconnectAttempts >= reconnectMax) hints.push(`auto-reconnect exhausted after ${reconnectAttempts}/${reconnectMax} attempts; /rt start re-establishes the session`);
  // GA-only realtime model rejected by a beta-routing endpoint/proxy. The error
  // text is upstream-verbatim ('... is only available on the GA API'); the real
  // fix is the proxy routing realtime via OpenAI's GA API, not a client header
  // change (proven empirically: identical error with and without OpenAI-Beta).
  const gaScan = `${responseError}\n${config.lastDisconnectReason || ""}`;
  const gaOnly = /only available on the GA API/i.test(gaScan);
  if (gaOnly) hints.push("realtime model rejected as GA-only ('... is only available on the GA API'): the model is GA but the realtime endpoint/proxy is routing via the BETA interface. Fix is upstream \u2014 the LiteLLM proxy must route realtime through OpenAI's GA API; a client-side beta-header change alone does NOT connect. For a direct Azure GA endpoint, set PI_RT_AZURE_API_VERSION=none.");
  else if (responseError && !isAuthFailure(responseError)) hints.push("realtime server returned an error (see lastResponseError); verify the model id, base URL, and provider/proxy routing, then /rt-doctor");

  return [
    "Realtime doctor",
    ...statusLines(session, config, { full: true }),
    `provider: ${provider} · apiKey:${apiKey || "<missing>"}`,
    `audioBackend: ${backend} · ${audioOutputBackendLabel(config)}/${audioInputBackendLabel(config)}`,
    `pulse: ${pulse}`,
    `commands: ${requirements}`,
    `vad: threshold:${config.vadThreshold ?? numberEnv("PI_RT_VAD_THRESHOLD", 0.7)} · silence:${numberEnv("PI_RT_VAD_SILENCE_MS", 1100)}ms · prefix:${numberEnv("PI_RT_VAD_PREFIX_PADDING_MS", 300)}ms`,
    `state: ${JSON.stringify(session.state?.snapshot?.({ sttOnly: config.sttOnly, audioEnabled: config.audioEnabled }) || {})}`,
    `micBytes: ${session.lastMicBytes || 0} · muteFor:${Math.max(0, session.micMuteUntilTs - Date.now())}ms · pendingTranscript:${session.pendingSpokenTranscripts.length} · micRestart:${session.micRestartAttempts || 0}${session.micRestartTimer ? " pending" : ""}`,
    `micError: ${micError || "<none>"}`,
    `reconnect: ${config.autoReconnect ? "on" : "off"} · attempts:${config.reconnectAttempts || 0}/${config.reconnectMaxAttempts || 0} · next:${config.nextReconnectAt ? Math.max(0, config.nextReconnectAt - Date.now()) : 0}ms · last:${config.lastDisconnectReason || "<none>"}`,
    `lastResponseError: ${responseError || "<none>"}`,
    `hint: ${hints.length ? hints.join("; ") : "configuration looks internally consistent"}`,
  ];
}
