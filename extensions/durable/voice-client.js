// The client part of voice.mjs (bd-6ffaf9), for pi-client: the focused session's daemon voice
// input as the TUI's speech chip (the editor chips draw SPEECH_INDICATOR_EVENT, the chip /stt and
// /ptt light: 🎙 CALL listening, on air, transcribing, armed, muted), and a status line with the
// call's settings and what is being said. It follows voice.mjs's document through pi-client's
// ctx.chord.watchDocument, so every client shows the same call; /call talk and the other verbs
// stay voice.mjs's commands, which any client can send. Ctrl-Space (realtime-agent.js's PTT key)
// controls the daemon's voice input while the focused session has a live call there: the press
// sends /ptt talk (talk, then send); otherwise Ctrl-Space stays the local push-to-talk. In TUI Pi
// (no ctx.chord) it does nothing.
//
// The meter: while the focused session has a live call, this client samples the call's microphone
// itself (the Pulse source and server the daemon records from, from the call's document) with a
// listener of its own, `/meter:<session>`, alongside the daemon's: nothing streams from the
// daemon, and the call's own stream is not touched. A server this machine cannot reach shows no
// meter. settings.json agentUtils.voice.clientMeter=false (or PI_VOICE_CLIENT_METER=0) turns it off.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { AudioLevelMeter } from "../lib/realtime-audio-meter.js";
import { normalizedRms } from "../lib/realtime-vad-segmenter.js";
import { createSpeechIndicatorPublisher, rmsToDb } from "../lib/speech-indicator.js";
import { sessionLabel, speechStreamName } from "../lib/stream-names.js";
import { agentSettingsPath, readAgentSettings } from "../pi-graphics/agent-io.js";
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

const METER_RATE = 8000;
const METER_RETRY_MS = 30_000;

/** Whether this client samples a live call's microphone for its meter. */
export function clientMeterEnabled(env = process.env, agentUtils) {
  const raw = env.PI_VOICE_CLIENT_METER;
  if (raw !== undefined && raw !== "") return !["0", "false", "no", "off"].includes(String(raw).trim().toLowerCase());
  let configured = agentUtils;
  if (configured === undefined) { try { configured = readAgentSettings(agentSettingsPath())?.agentUtils; } catch {} }
  return configured?.voice?.clientMeter !== false;
}

/** parec's arguments for sampling a call's microphone: low rate, mono, as `/meter:<session>`. */
export function meterArgs({ device, server } = {}, label = "") {
  const name = speechStreamName("meter", label);
  return [
    "--raw", "--format=s16le", `--rate=${METER_RATE}`, "--channels=1", "--latency-msec=100",
    `--client-name=${name}`, `--stream-name=${name}`,
    ...(device ? [`--device=${device}`] : []),
    ...(server ? [`--server=${server}`] : []),
  ];
}

/** The recorder: the Nix package's pacat (runtime-paths.json beside this file) --record, else parec. */
function recorder() {
  try {
    const pacat = JSON.parse(readFileSync(new URL("./runtime-paths.json", import.meta.url), "utf8"))?.pacat;
    if (typeof pacat === "string" && pacat.startsWith("/")) return { command: pacat, prefix: ["--record"] };
  } catch {}
  return { command: "parec", prefix: [] };
}

export default function voiceClient(pi, { maxSessions = 16, spawnImpl = spawn, meter: meterEnabled = clientMeterEnabled(), now = () => Date.now(), record = recorder() } = {}) {
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
  // The meter's sampler: one parec on the focused live call's microphone.
  const sampler = { key: null, proc: null, level: new AudioLevelMeter({ width: 12 }), rms: 0, failed: new Map() };
  const stopSampler = () => {
    const { proc } = sampler;
    sampler.key = null;
    sampler.proc = null;
    sampler.rms = 0;
    sampler.level.reset();
    try { proc?.kill?.("SIGTERM"); } catch {}
  };
  const samplerFor = (doc) => {
    const call = doc?.call;
    // Only a live, unmuted call whose server this machine may reach (the daemon's default
    // server, unnamed, may be its own machine's).
    if (!meterEnabled || !call || call.end || call.muted || !call.input?.server) return stopSampler();
    const key = JSON.stringify([focused, call.input.device ?? null, call.input.server]);
    if (sampler.key === key) return;
    stopSampler();
    if (now() - (sampler.failed.get(key) ?? -Infinity) < METER_RETRY_MS) return;
    let proc;
    try { proc = spawnImpl(record.command, [...record.prefix, ...meterArgs(call.input, sessionLabel({ name: call.label, sessionId: focused }))], { stdio: ["ignore", "pipe", "ignore"] }); }
    catch { sampler.failed.set(key, now()); return; }
    sampler.key = key;
    sampler.proc = proc;
    proc.on?.("error", () => {});
    proc.stdout?.on?.("error", () => {});
    proc.stdout?.on?.("data", (chunk) => {
      if (sampler.proc !== proc) return;
      sampler.rms = normalizedRms(chunk);
      sampler.level.pushFrame(chunk);
      show({ sample: true });
    });
    proc.on?.("exit", () => {
      if (sampler.proc !== proc) return;
      // Unreachable, or no such source: no meter for a while, the call goes on.
      sampler.failed.set(key, now());
      stopSampler();
      show({ sample: true });
    });
  };
  const show = ({ sample = false } = {}) => {
    const doc = sessions.get(focused)?.doc ?? null;
    if (!sample) {
      live?.ui?.setStatus?.(STATUS, voiceStatusLine(doc));
      samplerFor(doc);
    }
    const state = voiceIndicator(doc);
    if (state.phase === "disabled") {
      publisher?.dispose();
      publisher = undefined;
      return;
    }
    publisher ||= createSpeechIndicatorPublisher(pi);
    // Its own session's pane only, in pi-client's splits.
    const meter = sampler.proc ? { meter: true, level: sampler.level.level, db: rmsToDb(sampler.rms) } : {};
    publisher.publish({ ...state, ...meter, ...(focused ? { sessionId: String(focused) } : {}) });
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

  // Ctrl-Space: the daemon's push-to-talk while the focused session has a live call there;
  // otherwise the local /ptt (realtime-agent.js), which records this machine's microphone.
  let presses = 0;
  pi.events?.on?.(VOICE_PTT_EVENT, (offer) => {
    const ctx = live;
    const entry = sessions.get(focused);
    if (!entry?.voice || !entry.doc?.call || entry.doc.call.end || typeof ctx?.chord?.call !== "function") return;
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
    stopSampler();
    publisher?.dispose();
    publisher = undefined;
  });
}
