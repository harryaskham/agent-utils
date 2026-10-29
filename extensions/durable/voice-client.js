// The client part of voice.mjs (bd-6ffaf9), for pi-client: the focused session's daemon voice
// input as the TUI's speech chip (the editor chips draw SPEECH_INDICATOR_EVENT, the chip /stt and
// /ptt light: 🎙 CALL listening, on air, transcribing, armed, muted), and a status line with the
// call's settings and what is being said. It follows voice.mjs's document through pi-client's
// ctx.chord.watchDocument, so every client shows the same call; /call talk and the other verbs
// stay voice.mjs's commands, which any client can send. Ctrl-Space (realtime-agent.js's PTT key)
// controls the daemon's voice input when the focused session's daemon has it: the press sends
// /ptt talk there (open the microphone, then send). In TUI Pi (no ctx.chord) it does nothing.
import { createSpeechIndicatorPublisher } from "../lib/speech-indicator.js";
import { VOICE_DOC } from "../lib/voice-doc.js";
import { VOICE_PTT_EVENT } from "../lib/voice-ptt.js";

const STATUS = "agent-utils-voice";
const PHASES = new Set(["listening", "on-air", "transcribing", "armed", "muted"]);
const MAX_SAID = 60;

const surfaceOf = (call) => (call.kind === "call" ? "CALL" : call.mode === "ptt" ? "PTT" : "STT");
const verbOf = (call) => (call.kind === "call" ? "/call" : "/ptt");

/** The speech chip's state for a voice document. */
export function voiceIndicator(doc) {
  const call = doc?.call;
  if (!call) return { phase: "disabled" };
  const surface = surfaceOf(call);
  if (call.end) return { phase: "sent", surface, hint: "ended" };
  if (call.muted) return { phase: "muted", surface, hint: "muted" };
  const phase = PHASES.has(call.phase) ? call.phase : "listening";
  const hint = phase === "armed" ? `${verbOf(call)} talk`
    : phase === "on-air" && call.mode === "ptt" ? "talk again: send"
    : call.error ? "stt failed" : "";
  return { phase, surface, hint, transcribing: phase === "transcribing" };
}

const oneLine = (text, max) => {
  const value = String(text ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
  return value.length > max ? `…${value.slice(value.length - max + 1)}` : value;
};

/** The status line for a voice document: the call, where it records from, and what is being said. */
export function voiceStatusLine(doc) {
  const call = doc?.call;
  if (!call) return undefined;
  const settings = doc.settings ?? {};
  const device = settings.device ?? settings.source;
  const where = [device, settings.server].filter(Boolean).join(" @ ");
  const parts = [`${call.kind === "call" ? "☎ call" : "🎙 stt"} · ${call.mode}${call.end ? ` · ending (${call.end.reason})` : ` · ${call.muted ? "muted" : call.phase}`}`];
  if (where) parts.push(where);
  if (call.sent) parts.push(`${call.sent} sent`);
  if (call.error) parts.push(`error: ${oneLine(call.error, 80)}`);
  const said = oneLine(call.partial, MAX_SAID);
  if (said && said !== "…") parts.push(`“${said}”`);
  return parts.join(" · ");
}

export default function voiceClient(pi, { maxSessions = 16 } = {}) {
  // Each followed session's document: sessionId -> { doc, stop, stopped, voice }, `voice` once
  // its daemon is known to run voice input (its commands include /call).
  const sessions = new Map();
  let live;
  let focused;
  // The chip shows only while the focused session has voice input: the publisher exists only
  // then, so the local /stt and /ptt (realtime-agent.js) keep the chip otherwise.
  let publisher;

  const sessionIdOf = (ctx) => {
    try {
      return ctx?.sessionManager?.getSessionId?.();
    } catch {
      return undefined;
    }
  };
  const show = () => {
    const doc = sessions.get(focused)?.doc ?? null;
    live?.ui?.setStatus?.(STATUS, voiceStatusLine(doc));
    const state = voiceIndicator(doc);
    if (state.phase === "disabled") {
      publisher?.dispose();
      publisher = undefined;
      return;
    }
    publisher ||= createSpeechIndicatorPublisher(pi);
    // Its own session's pane only, in pi-client's splits.
    publisher.publish({ ...state, ...(focused ? { sessionId: String(focused) } : {}) });
  };

  const follow = (ctx, sessionId) => {
    if (!sessionId || sessions.has(sessionId) || typeof ctx?.chord?.watchDocument !== "function") return;
    const entry = { doc: null, stop: undefined, stopped: false, voice: false };
    sessions.set(sessionId, entry);
    Promise.resolve(ctx.chord.call?.("session.commands", {}))
      .then((result) => { entry.voice = Array.isArray(result?.items) && result.items.some((command) => command?.name === "call"); })
      .catch(() => {});
    while (sessions.size > maxSessions) {
      const [oldest, gone] = sessions.entries().next().value;
      sessions.delete(oldest);
      gone.stopped = true;
      gone.stop?.();
    }
    const { definition } = VOICE_DOC;
    Promise.resolve(
      ctx.chord.watchDocument({ kind: definition.kind, version: definition.version, scope: definition.scope }, (value) => {
        if (entry.stopped) return;
        entry.doc = value;
        if (sessionId === focused) show();
      }),
    ).then(
      (stopper) => {
        if (entry.stopped) stopper?.();
        else entry.stop = stopper;
      },
      () => {
        if (sessions.get(sessionId) === entry) sessions.delete(sessionId);
      },
    );
  };

  // Ctrl-Space: the daemon's push-to-talk, when the focused session's daemon has voice input.
  let presses = 0;
  pi.events?.on?.(VOICE_PTT_EVENT, (offer) => {
    const ctx = live;
    if (!sessions.get(focused)?.voice || typeof ctx?.chord?.call !== "function") return;
    offer?.take?.();
    presses += 1;
    Promise.resolve(ctx.chord.call("conversation.submit", { requestId: `voice-ptt-${Date.now()}-${presses}`, content: "/ptt talk" }))
      .catch((error) => ctx.ui?.notify?.(`/ptt talk: ${error?.message || error}`, "error"));
  });

  pi.on("session_start", (_event, ctx) => {
    if (typeof ctx?.chord?.watchDocument !== "function") return;
    live = ctx;
    focused = sessionIdOf(ctx);
    follow(ctx, focused);
    show();
  });
  pi.on("session_shutdown", () => {
    for (const entry of sessions.values()) {
      entry.stopped = true;
      entry.stop?.();
    }
    sessions.clear();
    publisher?.dispose();
    publisher = undefined;
  });
}
