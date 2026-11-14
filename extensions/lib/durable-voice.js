// Voice input for pi-daemon sessions (bd-6ffaf9): /call, and /stt and /ptt, run by the daemon.
//
// A Durable background task holds the session's microphone: a Pulse record stream with the
// session's own device= and server=. It finds speech with TUI /stt's local VAD
// (LocalVadController), transcribes it with the same providers (transcribeSpeech) and submits
// each turn as the user's message: by default as a steer, which reaches a busy agent at its next
// step (send=followup waits for its whole turn; send=interrupt stops the turn first). Sessions
// with live tasks resume at startup, so a call outlives a worker restart.
//
// The settings and the call's state are one session document (VOICE_DOC). Every client follows
// it (durable/voice-client.js draws it with the TUI's speech chip), so all of them show the same
// call. Settings resolve as TUI /stt's: settings.json agentUtils.stt, then the worker's
// environment, then the session's own `key=value` (an overlay, never process.env). Each session
// has its own; any number of sessions may hold calls at once.
//
// A call (/call) hangs up after `hangup_after` without activity (5 minutes by default): the
// operator's speech or the agent's (tts.mjs), whichever was last. The agent can end it with
// end_call. Dictation (/stt, /ptt) stays on until stopped. Input is muted while this session's
// speech plays (tts.mjs), as TUI /stt is.
//
// Voice aliases (settings.json `agentUtils.voice.aliases`, or the older `agentUtils.call.aliases`,
// e.g. `bt: "source=source.bluetooth sink=vsink_agent_call pan=0"`; voice-settings.js) start a
// call or dictation with settings of its own: `/call bt`, `/stt bt`, `/ptt bt`. An alias's
// microphone settings (source=, mode=, send=, …) and its speech output (sink=, pan=, tts=, see
// call-audio.js) last only while it does, so hanging up returns the session to its own /call
// and /tts settings. sink= and pan= typed on /call, /stt or /ptt are for that run only too.
import { spawn } from "node:child_process";
import { createAudioProviders, rejectSurfaceAuthKeys } from "./audio-providers.js";
import { parseEnvStyleArgs } from "./env-args.js";
import { CHANNELS, SAMPLE_RATE, defaultRecordCommand } from "./realtime-audio.js";
import { LocalVadController, describeLocalVadConfig, parseLocalVadConfig } from "./realtime-local-vad.js";
import { resolveBatchSttTimeoutMs } from "./realtime-stt-batch.js";
import { resolveSttSettings, transcribeSpeech } from "./stt-provider.js";
import { sttEnvUpdates } from "./stt-session-values.js";
import { labelUntrustedTranscript } from "./untrusted-transcript.js";
import { VOICE_DOC } from "./voice-doc.js";
import { callOutputFrom, describeCallOutput, lastSpeechActivity, setCallOutput as publishCallOutput, splitCallValues } from "./call-audio.js";
import { DEFAULT_VOICE_SEND, VOICE_WORDS, normalizeVoiceSend, voiceAliases, voiceSendLabel } from "./voice-settings.js";
import { sessionLabel, speechStreamName } from "./stream-names.js";

export { VOICE_DOC };
export const VOICE_TASK = "agent-utils.voice";
export const DEFAULT_HANGUP_AFTER_MS = 5 * 60_000;
/** Settings of the call itself (not STT): its default mode, delivery (send=, or deliver=) and silence hang-up. */
export const VOICE_CALL_KEYS = Object.freeze(["mode", "send", "deliver", "hangup_after"]);
const MAX_PARTIAL = 2000;
const MAX_ERROR = 300;
const AUDIO_INSTANCE = Symbol.for("agent-utils.durable-agent-audio.v1");

/** `5m`, `90s`, `1h`, `500ms`, a bare number of seconds; `off`, `never` or 0 for none. */
export function parseDurationMs(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["off", "never", "none", "0"].includes(text)) return 0;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(text);
  if (!match) return null;
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] ?? "s"];
  return Math.round(Number(match[1]) * unit);
}

function validateCallValues(values, surface) {
  if (values.mode !== undefined && !["vad", "ptt"].includes(String(values.mode).toLowerCase())) throw new Error(`${surface}: mode must be vad or ptt`);
  for (const key of ["send", "deliver"]) if (values[key] !== undefined) normalizeVoiceSend(values[key], surface);
  if (values.hangup_after !== undefined && parseDurationMs(values.hangup_after) === null) throw new Error(`${surface}: hangup_after must be a duration such as 5m, or off`);
}

/**
 * A session's environment and resolved settings: the worker's environment with the session's
 * values over it, and settings.json's agentUtils.stt under both.
 */
export function voiceSettings(values = {}, { env = process.env, persisted = {}, audioProviders, surface = "/call", send = DEFAULT_VOICE_SEND } = {}) {
  const sttValues = Object.fromEntries(Object.entries(values).filter(([key]) => !VOICE_CALL_KEYS.includes(key)));
  const { updates, clear } = sttEnvUpdates(sttValues, { env, persisted, audioProviders, surface, devices: true });
  const sessionEnv = { ...env };
  for (const key of clear) delete sessionEnv[key];
  Object.assign(sessionEnv, updates);
  const stt = resolveSttSettings(sessionEnv, persisted, {}, audioProviders);
  const hangup = values.hangup_after === undefined ? DEFAULT_HANGUP_AFTER_MS : parseDurationMs(values.hangup_after);
  return {
    env: sessionEnv,
    stt,
    vad: parseLocalVadConfig(sessionEnv, persisted),
    timeoutMs: resolveBatchSttTimeoutMs(sessionEnv, persisted),
    device: sessionEnv.PULSE_SOURCE || null,
    server: sessionEnv.PULSE_SERVER || null,
    mode: String(values.mode ?? "vad").toLowerCase() === "ptt" ? "ptt" : "vad",
    // How a turn reaches a busy agent: steer (the default), followUp, or interrupt (stop its turn first).
    deliver: normalizeVoiceSend(values.send ?? values.deliver ?? send, surface),
    hangupAfterMs: hangup ?? DEFAULT_HANGUP_AFTER_MS,
  };
}

/**
 * The session's record stream: Pulse's pacat (recorded by the Nix package) with the session's
 * --device and --server; else PI_RT_RECORD_CMD or the TUI's default, run with the session's
 * environment (PULSE_SOURCE, PULSE_SERVER).
 */
export function defaultCapture({ env, executables = {}, streamName, spawnImpl = spawn }) {
  const options = { env, stdio: ["ignore", "pipe", "pipe"] };
  let proc;
  if (!env.PI_RT_RECORD_CMD && executables.pacat) {
    const args = ["--record", "--raw", "--format=s16le", `--rate=${SAMPLE_RATE}`, `--channels=${CHANNELS}`, `--client-name=${streamName}`, `--stream-name=${streamName}`];
    if (env.PULSE_SOURCE) args.push(`--device=${env.PULSE_SOURCE}`);
    if (env.PULSE_SERVER) args.push(`--server=${env.PULSE_SERVER}`);
    proc = spawnImpl(executables.pacat, args, options);
  } else {
    proc = spawnImpl("/bin/sh", ["-c", env.PI_RT_RECORD_CMD || defaultRecordCommand()], options);
  }
  proc.on?.("error", () => {});
  proc.stdout?.on?.("error", () => {});
  proc.stderr?.on?.("error", () => {});
  return proc;
}

/**
 * The Pulse sources a session's environment reaches (`pactl list short sources`, with its
 * PULSE_SERVER): `{ ok, server, sources: [{ name, state }] }`, or `ok: false` and why.
 */
export function defaultListSources({ env, executables = {}, spawnImpl = spawn, timeoutMs = 5_000 }) {
  return new Promise((resolve) => {
    const server = env.PULSE_SERVER || null;
    let out = "";
    let err = "";
    let child;
    try {
      child = spawnImpl(executables.pactl || "pactl", ["list", "short", "sources"], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, server, error: error?.message || String(error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill?.("SIGKILL"); } catch {} }, timeoutMs);
    timer.unref?.();
    child.stdout?.on?.("data", (chunk) => { if (out.length < 64_000) out += chunk; });
    child.stderr?.on?.("data", (chunk) => { if (err.length < 2_000) err += chunk; });
    child.on?.("error", (error) => { clearTimeout(timer); resolve({ ok: false, server, error: error?.message || String(error) }); });
    child.on?.("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve({ ok: false, server, error: err.trim() || `pactl exited with ${code}` }); return; }
      const sources = out.split("\n").map((line) => line.split("\t")).filter((cols) => cols.length >= 2 && cols[1]).map((cols) => ({ name: cols[1], state: (cols[4] ?? "").trim().toLowerCase() }));
      resolve({ ok: true, server, sources });
    });
  });
}

/** One line per source, the session's marked, monitors (an output's loopback) last. */
export function sourcesText(listed, current) {
  if (!listed.ok) return `Pulse sources on ${listed.server ?? "the default server"} could not be listed: ${listed.error}`;
  const sorted = [...listed.sources].sort((a, b) => Number(a.name.endsWith(".monitor")) - Number(b.name.endsWith(".monitor")));
  const lines = sorted.map((source) => `${source.name === current ? "●" : "·"} ${source.name}${source.state ? ` (${source.state})` : ""}`);
  return [`Pulse sources on ${listed.server ?? "the default server"}${current ? "" : " (none chosen: the server's default)"}:`, ...lines].join("\n");
}

const bounded = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};
const isLive = (call) => Boolean(call) && !call.end;

/**
 * One live call in the task: capture, VAD, transcription and delivery, following the document.
 * `patch` commits fields of the call; `submit` delivers a turn; `requestEnd` asks to hang up.
 */
class VoiceCall {
  constructor({ sessionId, taskId, deps, patch, submit, interrupt, requestEnd, sent }) {
    Object.assign(this, { sessionId, taskId, deps, patch, submit, interrupt, requestEnd });
    this.sent = sent;
    this.seen = {};
    this.capture = null;
    this.controller = null;
    this.phase = null;
    this.error = null;
    this.lastHeardAt = deps.now();
    this.ended = new Promise((resolve) => { this.finish = resolve; });
    this.timer = null;
    this.done = false;
  }

  get muted() { return this.seen.muted === true || this.deps.speaking(this.sessionId); }

  /** The document changed: follow it. */
  async apply(doc) {
    if (this.done) return;
    const call = doc?.call;
    if (call?.taskId !== this.taskId || call.end) {
      await this.stop({ discard: call?.taskId === this.taskId && call.end?.discard === true });
      this.finish(call?.taskId === this.taskId ? call.end?.reason ?? "ended" : "replaced");
      return;
    }
    // The call's own settings (an alias's) over the session's, for this call only.
    this.label = typeof call.label === "string" ? call.label : this.label;
    const values = withCallSettings(doc.settings ?? {}, call.overlay?.voice ?? {});
    const settingsKey = JSON.stringify(values);
    const before = this.seen;
    this.seen = { kind: call.kind, mode: call.mode, talking: call.mode === "ptt" && call.talking === true, muted: call.muted === true, settingsKey, discard: call.discard === true };
    // Its speech output (sink, pan) while it lasts: tts.mjs reads it for this session.
    this.publishOutput(call.overlay?.output ?? null);
    // New settings or another mode: the microphone reopens with them.
    const restart = before.settingsKey !== settingsKey || before.mode !== call.mode;
    if (restart) {
      try { this.settings = voiceSettings(values, this.deps); }
      catch (error) {
        this.fail(error);
        await this.stopCapture({ flush: false });
        this.requestEnd({ reason: "settings invalid" });
        return;
      }
      // Where the microphone is, for clients that sample its level alongside (voice-client.js).
      const input = { device: this.settings.device, server: this.settings.server };
      if (JSON.stringify(input) !== JSON.stringify(call.input ?? null)) this.patch({ input });
      await this.stopCapture({ flush: false });
    }
    if (call.mode === "vad") {
      if (!this.capture) this.startCapture({ hold: false });
    } else if (this.seen.talking) {
      if (!this.capture) this.startCapture({ hold: true });
    } else if (before.talking && !restart) {
      await this.release({ discard: this.seen.discard });
    } else if (this.capture) {
      // PTT between presses: the microphone is closed.
      await this.stopCapture({ flush: false });
    }
    if (this.done) return;
    this.setPhase(this.idlePhase());
    this.armTimer();
  }

  publishOutput(output) {
    const key = JSON.stringify(output);
    if (key === this.outputKey) return;
    this.outputKey = key;
    this.deps.setCallOutput(this.sessionId, output);
  }

  idlePhase() {
    if (this.seen.muted) return "muted";
    if (this.seen.mode === "ptt") return this.seen.talking ? "on-air" : "armed";
    return "listening";
  }

  setPhase(phase) {
    if (phase === this.phase) return;
    this.phase = phase;
    this.patch({ phase });
  }

  fail(error) {
    const message = bounded(error?.message || String(error), MAX_ERROR);
    if (message === this.error) return;
    this.error = message;
    this.patch({ error: message });
  }

  startCapture({ hold }) {
    const { settings, deps } = this;
    const controller = new LocalVadController({
      config: settings.vad,
      holdCommits: hold,
      placeholder: "…",
      isSuppressed: () => this.muted,
      transcribe: (pcm, options = {}) => deps.transcribe(pcm, {
        ...settings.stt, model: settings.stt.model, timeoutMs: settings.timeoutMs, ...options,
        persisted: deps.persisted, audioProviders: deps.audioProviders, env: settings.env,
      }),
      insertPartial: (text) => this.patch({ partial: bounded(text, MAX_PARTIAL) }),
      onState: (state) => {
        if (state === "listening") {
          this.lastHeardAt = deps.now();
          this.setPhase("on-air");
        } else if (state === "transcribing" || state === "transcribing-final") this.setPhase("transcribing");
        else if (state === "idle" || state === "held") this.setPhase(this.idlePhase());
      },
      sendTurn: (text) => { void this.deliver(text); },
      onError: (error) => this.fail(error),
    });
    let capture;
    try {
      // `/call:harbour`, `/stt:…`, `/ptt:…`: who listens, in a mixer.
      const kind = this.seen.kind === "call" ? "call" : this.seen.mode === "ptt" ? "ptt" : "stt";
      capture = deps.capture({ env: settings.env, executables: deps.executables, streamName: speechStreamName(kind, this.label || sessionLabel({ sessionId: this.sessionId })), sessionId: this.sessionId });
    } catch (error) {
      this.fail(error);
      this.requestEnd({ reason: "capture failed" });
      return;
    }
    let stderr = "";
    capture.stdout?.on?.("data", (chunk) => {
      if (this.capture !== capture) return;
      controller.pushFrame(chunk).catch((error) => this.fail(error));
    });
    capture.stderr?.on?.("data", (chunk) => { stderr = bounded(`${stderr}${chunk}`.trim(), MAX_ERROR); });
    capture.on?.("exit", (code, signal) => {
      if (this.capture !== capture || this.done) return;
      // The microphone went away (a missing device, a server gone): say why and hang up.
      this.capture = null;
      this.fail(new Error(stderr || `capture exited (${signal ?? code})`));
      this.requestEnd({ reason: "capture ended" });
    });
    this.capture = capture;
    this.controller = controller;
  }

  async stopCapture({ flush }) {
    const { capture, controller } = this;
    this.capture = null;
    this.controller = null;
    try { capture?.kill?.("SIGTERM"); } catch {}
    if (!controller) return;
    if (flush) await controller.flush().catch((error) => this.fail(error));
    controller.dispose();
  }

  /** PTT released: send what was said (or drop it), and close the microphone. */
  async release({ discard }) {
    const { capture, controller } = this;
    this.capture = null;
    this.controller = null;
    try { capture?.kill?.("SIGTERM"); } catch {}
    if (!controller) return;
    if (discard) controller.discardHeld();
    else await controller.commitHeld().catch((error) => this.fail(error));
    controller.dispose();
    if (discard) this.patch({ partial: null, discard: false });
  }

  async deliver(text) {
    const content = String(text ?? "").trim();
    if (!content) return;
    const number = this.sent + 1;
    try {
      // interrupt: stop the agent's turn first (the session's own background work goes on).
      if (this.settings.deliver === "interrupt") await this.interrupt?.();
      await this.submit(labelUntrustedTranscript(content, this.settings.env), {
        requestId: `voice:${this.taskId}:${number}`,
        whenBusy: this.settings.deliver === "followUp" ? "followUp" : "steer",
      });
      this.sent = number;
      this.lastHeardAt = this.deps.now();
      this.error = null;
      this.patch({ partial: null, sent: number, lastHeardAt: this.lastHeardAt, error: null }, { sent: number });
    } catch (error) {
      this.fail(error);
    }
  }

  /** When the call last had activity: the operator's speech, or the agent's (tts.mjs). */
  lastActivity() {
    const now = this.deps.now();
    if (this.deps.speaking(this.sessionId)) return now;
    return Math.max(this.lastHeardAt, Number(this.deps.lastSpeech(this.sessionId)) || 0);
  }

  armTimer() {
    if (this.timer || this.done) return;
    this.timer = this.deps.setInterval(() => {
      if (this.done || this.seen.kind !== "call" || this.seen.talking) return;
      const after = this.settings?.hangupAfterMs ?? DEFAULT_HANGUP_AFTER_MS;
      if (after > 0 && this.deps.now() - this.lastActivity() >= after) this.requestEnd({ reason: "silence" });
    }, this.deps.tickMs);
    this.timer?.unref?.();
  }

  async stop({ discard = false } = {}) {
    if (this.done) return;
    this.done = true;
    if (this.timer) this.deps.clearInterval(this.timer);
    this.timer = null;
    // The call's speech output goes with it: speech is as the session's /tts says again.
    if (this.outputKey !== undefined && this.outputKey !== "null") this.deps.setCallOutput(this.sessionId, null);
    this.outputKey = undefined;
    if (this.seen.mode === "ptt" && this.seen.talking) await this.release({ discard });
    else await this.stopCapture({ flush: !discard });
  }
}

/**
 * The voice task: one per live call. Input `{ sessionId, startedAt }`; checkpoint
 * `{ phase: "live", sent }` (turns delivered, so a turn retried after a restart has the same
 * request id).
 */
export function createVoiceTask(options = {}) {
  const deps = voiceDeps(options);
  const finish = (runtime, context, outcome) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(VOICE_DOC);
      const call = doc.call;
      if (call?.taskId === String(runtime.taskId)) {
        doc.last = { kind: call.kind, mode: call.mode, startedAt: call.startedAt, endedAt: deps.now(), reason: call.end?.reason ?? outcome.reason ?? "ended", sent: call.sent ?? 0 };
        doc.call = null;
      }
      return { status: "terminal", outcome };
    }, context);
  // A task token as Durable's defineTask returns ({ definition }); the commands find its
  // dependencies on it, out of sight of Durable.
  const token = {
    definition: {
      name: VOICE_TASK,
      version: 1,
      initial: () => ({ phase: "live", sent: 0 }),
      phases: {
        async live(task, runtime, context) {
          const taskId = String(runtime.taskId);
          const watch = await runtime.watchDoc(VOICE_DOC, context);
          if (watch.value?.call?.taskId !== taskId || watch.value.call.end) {
            await watch.stop().catch(() => undefined);
            await finish(runtime, context, { status: "completed", result: { reason: watch.value?.call?.end?.reason ?? "ended" }, reason: "ended" });
            return;
          }
          const sent = Number(task.state.checkpoint?.sent) || 0;
          // Commits in order, so the document's phases follow the call's. Only a delivered turn
          // changes the checkpoint (its count names the next turn's request id).
          let chain = Promise.resolve();
          const patch = (fields, checkpoint) => {
            chain = chain.then(() => runtime.commit(async (tx) => {
              const doc = await tx.doc(VOICE_DOC);
              if (doc.call?.taskId === taskId && !doc.call.end) Object.assign(doc.call, fields);
              return checkpoint?.sent === undefined ? undefined : { status: "running", checkpoint: { phase: "live", sent: checkpoint.sent } };
            }, context)).catch((error) => deps.log(`agent-utils voice: commit failed: ${error?.message || error}`));
            return chain;
          };
          const requestEnd = ({ reason }) => runtime.commit(async (tx) => {
            const doc = await tx.doc(VOICE_DOC);
            if (doc.call?.taskId === taskId && !doc.call.end) doc.call.end = { reason, by: "daemon", at: deps.now() };
            return undefined;
          }, context).catch((error) => deps.log(`agent-utils voice: hang-up failed: ${error?.message || error}`));
          const conversation = await runtime.conversation(runtime.conversationId, context);
          const submit = async (content, { requestId, whenBusy }) => {
            if (conversation === undefined) throw new Error("the session's conversation is gone");
            await conversation.submit({ type: "input", content, whenBusy, requestId }, context);
          };
          const interrupt = async () => {
            if (typeof conversation?.abort === "function") await conversation.abort(context);
          };
          const call = new VoiceCall({ sessionId: String(task.input?.sessionId ?? ""), taskId, deps, patch, submit, interrupt, requestEnd, sent });
          const onAbort = () => { void call.stop({ discard: true }).then(() => call.finish("aborted")); };
          runtime.signal?.addEventListener?.("abort", onAbort, { once: true });
          // Follow the document in order: the value read, then every change.
          let updates = call.apply(watch.value);
          watch.start(async (value) => { updates = updates.then(() => call.apply(value)); await updates; });
          await updates;
          let reason;
          try {
            reason = await call.ended;
          } finally {
            runtime.signal?.removeEventListener?.("abort", onAbort);
            await watch.stop().catch(() => undefined);
            await call.stop();
            await chain;
          }
          if (runtime.signal?.aborted) throw runtime.signal.reason ?? new Error("aborted");
          await finish(runtime, context, { status: "completed", result: { reason, sent: call.sent }, reason });
        },
      },
      async abort(_task, runtime, context) {
        await finish(runtime, context, { status: "aborted", reason: "voice input stopped" });
      },
    },
  };
  Object.defineProperty(token, "deps", { value: deps, enumerable: false });
  return token;
}

/** The voice aliases from settings: name → its `key=value …` (a string, or an object of values). */
export const callAliases = voiceAliases;

/** /call's, /stt's and /ptt's own words: never alias names. */
const CALL_VERBS = VOICE_WORDS;

/** The session's settings with a call's own over them (`source=` and `device=` are one setting). */
export function withCallSettings(settings = {}, own = {}) {
  const merged = { ...settings };
  if (Object.hasOwn(own, "device") || Object.hasOwn(own, "source")) {
    delete merged.device;
    delete merged.source;
  }
  return { ...merged, ...own };
}

function describeValues(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join(" ");
}

function voiceDeps({
  env = process.env,
  persisted = {},
  audioProviders = createAudioProviders({}),
  executables = {},
  capture,
  spawnImpl,
  transcribe = (pcm, options) => transcribeSpeech(pcm, options),
  speaking = (sessionId) => globalThis[AUDIO_INSTANCE]?.isSpeaking?.(sessionId) === true,
  now = () => Date.now(),
  setInterval: setTimer = setInterval,
  clearInterval: clearTimer = clearInterval,
  tickMs = 1000,
  listSources,
  log = (line) => { try { process.stderr.write(`${line}\n`); } catch {} },
  aliases = {},
  send = DEFAULT_VOICE_SEND,
  setCallOutput = publishCallOutput,
  lastSpeech = lastSpeechActivity,
} = {}) {
  return {
    env, persisted, audioProviders, executables, transcribe, speaking, now, tickMs, log,
    aliases: callAliases(aliases), send: normalizeVoiceSend(send, "agentUtils.voice.send"), setCallOutput, lastSpeech,
    capture: capture ?? ((options) => defaultCapture({ ...options, ...(spawnImpl ? { spawnImpl } : {}) })),
    listSources: listSources ?? ((options) => defaultListSources({ executables, ...options, ...(spawnImpl ? { spawnImpl } : {}) })),
    setInterval: setTimer,
    clearInterval: clearTimer,
  };
}

/**
 * A plain copy of a value read in a commit. Durable's drafts are proxies that throw once their
 * transaction settles ("Cannot use a settled overlay"), nested objects (a call's overlay) too.
 */
const plain = (value) => (value === undefined || value === null ? value ?? null : JSON.parse(JSON.stringify(value)));

/** Voice operations over a Durable commit (a command's harness, or a tool's api). */
export function voiceOperations({ task, now = () => Date.now() }) {
  const deps = task.deps;
  return {
    /** Merge validated settings: each value as typed; an empty value removes it. */
    async configure(commit, values, surface) {
      validateCallValues(values, surface);
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        const next = { ...(doc.settings ?? {}) };
        for (const [key, value] of Object.entries(values)) {
          if (String(value).trim() === "") delete next[key];
          else next[key] = String(value);
        }
        // Throws on a bad value or unknown key before anything is kept.
        voiceSettings(next, { ...deps, surface });
        doc.settings = next;
        return plain(next);
      });
    },
    /** Start voice input, or change the live one to this kind and mode. */
    async start(commit, { sessionId, conversationId, kind, mode, talking = false, overlay, label }) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        const at = now();
        if (isLive(doc.call)) {
          Object.assign(doc.call, { kind, mode, talking: mode === "ptt" && talking, discard: false });
          if (overlay !== undefined) doc.call.overlay = overlay;
          return { started: false, call: plain(doc.call) };
        }
        const taskId = await tx.createTask(task, { sessionId, startedAt: at }, { ownership: { kind: "conversation" }, conversationId, background: true });
        doc.seq = (Number(doc.seq) || 0) + 1;
        doc.call = {
          number: doc.seq, taskId: String(taskId), kind, mode, startedAt: at, phase: mode === "ptt" && !talking ? "armed" : "listening",
          talking: mode === "ptt" && talking, muted: false, discard: false, partial: null, lastHeardAt: at, sent: 0, error: null, end: null,
          overlay: overlay ?? null,
          ...(label ? { label: String(label) } : {}),
        };
        return { started: true, call: plain(doc.call) };
      });
    },
    async update(commit, change) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        if (!isLive(doc.call)) return null;
        change(doc.call);
        return plain(doc.call);
      });
    },
    async end(commit, { reason, by, note, discard = false }) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        if (!isLive(doc.call)) return null;
        doc.call.end = { reason, by, at: now(), ...(note ? { note: bounded(note, 200) } : {}), ...(discard ? { discard: true } : {}) };
        return plain(doc.call);
      });
    },
    async read(commit) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        return { settings: plain(doc.settings ?? {}), call: plain(doc.call), last: plain(doc.last) };
      });
    },
    /** Forget a call whose task is gone (it ended without saying so). */
    async reconcile(commit, liveTaskIds) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        if (doc.call && !liveTaskIds.has(String(doc.call.taskId))) {
          doc.last = { kind: doc.call.kind, mode: doc.call.mode, startedAt: doc.call.startedAt, endedAt: now(), reason: "gone", sent: doc.call.sent ?? 0 };
          doc.call = null;
        }
      });
    },
  };
}

function formatAgo(ms) {
  if (ms >= 3_600_000) return `${Math.floor(ms / 3_600_000)}h`;
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.max(0, Math.floor(ms / 1000))}s`;
}

/** One line: the call, where it records from and how it transcribes. */
export function voiceStatus(state, deps, now = Date.now()) {
  let resolved;
  const overlay = state.call?.overlay ?? null;
  try { resolved = voiceSettings(withCallSettings(state.settings, overlay?.voice ?? {}), deps); } catch (error) { return `voice: settings invalid: ${error.message}`; }
  const where = `device:${resolved.device ?? "default"} · server:${resolved.server ?? "default"} · send:${voiceSendLabel(resolved.deliver)}`;
  const stt = `provider:${resolved.stt.providerName && resolved.stt.providerName !== resolved.stt.provider ? `${resolved.stt.providerName}(${resolved.stt.provider})` : resolved.stt.provider} · model:${resolved.stt.model ?? "default"}`;
  const call = state.call;
  if (!call) {
    const last = state.last ? ` · last ${state.last.kind} ended (${state.last.reason}) ${formatAgo(now - state.last.endedAt)} ago, ${state.last.sent} sent` : "";
    return `voice:off · ${where} · ${stt}${last}`;
  }
  const hangup = call.kind === "call" ? ` · hangup_after:${resolved.hangupAfterMs ? formatAgo(resolved.hangupAfterMs) : "off"} (since the last speech, either side)` : "";
  const own = overlay ? ` · ${overlay.alias ? `alias:${overlay.alias}` : `this ${call.kind === "call" ? "call" : "dictation"}`}${overlay.output ? ` · speech ${describeCallOutput(overlay.output)}` : ""} (until ${call.kind === "call" ? "hang-up" : "it stops"})` : "";
  return `${call.kind}:on${own} · ${call.mode} · ${call.end ? `ending (${call.end.reason})` : call.phase}${call.muted ? " · muted" : ""} · ${where} · ${stt} · ${call.sent ?? 0} sent · ${formatAgo(now - call.startedAt)}${hangup}${call.error ? ` · error: ${call.error}` : ""} · ${describeLocalVadConfig(resolved.vad)}`;
}

const USAGE = {
  call: "/call [ALIAS] [vad|ptt] [key=value …] starts a voice call (or changes the live one); /call ALIAS uses an alias from settings (agentUtils.voice.aliases; /call aliases lists them), whose settings last until hang-up; /call talk (PTT: start, then send), send, cancel, mute, unmute, hangup, status; /call devices lists the microphones (Pulse sources). Settings: device= (source=) server= provider= model= language= energy= … mode= send=steer|followup|interrupt (how a turn reaches a busy agent; steer by default) hangup_after=5m|off (after the last speech, either side); for this call only: sink= pan= tts=on|off (the agent's speech).",
  stt: "/stt [ALIAS] [on|ptt|off|cancel|status|key=value …]: dictation run by the daemon, each turn sent as your message. Settings and aliases as /call (device=, server=, send=, sink=, pan=, …); an alias's, and sink=/pan=, last until it stops.",
  ptt: "/ptt [ALIAS] [on|talk|send|cancel|off|status|key=value …]: push-to-talk run by the daemon. /ptt talk starts recording; /ptt talk (or send) sends. Settings and aliases as /call.",
};

/** /call, /stt and /ptt for pi-daemon sessions. */
export function createVoiceCommands({ task, now = () => Date.now() } = {}) {
  const ops = voiceOperations({ task, now });
  const deps = task.deps;
  const commitOf = (ctx) => (change) => ctx.harness.commit(change, ctx.context);
  const ready = (ctx, name) => {
    if (typeof ctx.harness?.commit === "function") return true;
    ctx.notify(`/${name} needs pi-daemon 1.10 or later (module commands with the Durable harness).`);
    return false;
  };
  const prune = async (ctx) => {
    if (typeof ctx.harness.inspect !== "function") return;
    const tasks = (await ctx.harness.inspect(ctx.context)).tasks.filter((entry) => entry.record.kind === VOICE_TASK && !entry.record.abortRequested);
    await ops.reconcile(commitOf(ctx), new Set(tasks.map((entry) => String(entry.record.id))));
  };
  const status = async (ctx) => voiceStatus(await ops.read(commitOf(ctx)), deps, now());
  // The session's name (or a short id), for the microphone's Pulse name.
  const labelOf = async (ctx) => {
    let name;
    try { name = await ctx.getSessionName?.(); } catch {}
    return sessionLabel({ name, sessionId: ctx.sessionId });
  };
  const startOf = async (ctx, kind, mode, talking, overlay) => ops.start(commitOf(ctx), { sessionId: ctx.sessionId, conversationId: ctx.conversationId, kind, mode, talking, overlay, label: await labelOf(ctx) });
  const settingsMode = async (ctx) => {
    const { settings } = await ops.read(commitOf(ctx));
    return String(settings.mode ?? "vad").toLowerCase() === "ptt" ? "ptt" : "vad";
  };
  // /call talk and /ptt talk: start PTT (a call if none), or send what was said.
  const talk = async (ctx, kind, overlay) => {
    const { call } = await ops.read(commitOf(ctx));
    if (!isLive(call)) {
      await startOf(ctx, kind, "ptt", true, overlay);
      return "🎙 talking: /" + (kind === "call" ? "call" : "ptt") + " talk again to send";
    }
    if (call.mode !== "ptt" || !call.talking) {
      await ops.update(commitOf(ctx), (live) => Object.assign(live, { mode: "ptt", talking: true, discard: false }));
      return "🎙 talking";
    }
    await ops.update(commitOf(ctx), (live) => Object.assign(live, { talking: false, discard: false }));
    return "sent";
  };

  const aliasesText = () => {
    const names = Object.keys(deps.aliases);
    return names.length === 0
      ? "No voice aliases: add them to settings.json agentUtils.voice.aliases (bt: \"source=… sink=… pan=0\")."
      : `Voice aliases (their settings last until hang-up, or until /stt or /ptt stops):\n${names.map((alias) => `· ${alias}: ${describeValues(deps.aliases[alias])}`).join("\n")}`;
  };

  const run = (name, kind) => async (args, ctx) => {
    if (!ready(ctx, name)) return;
    const surface = `/${name}`;
    try {
      await prune(ctx);
      const parsed = parseEnvStyleArgs(String(args ?? ""));
      let positionals = [...parsed.positionals];
      // /call ALIAS (and /stt ALIAS, /ptt ALIAS): an alias's settings, with any typed after it over
      // them, until it stops.
      let alias;
      if (positionals.length && !CALL_VERBS.has(String(positionals[0]).toLowerCase())) {
        const named = String(positionals[0]).toLowerCase();
        if (!Object.hasOwn(deps.aliases, named)) throw new Error(`${surface}: unknown '${positionals[0]}'. ${aliasesText()}\n${USAGE[name]}`);
        alias = named;
        positionals = positionals.slice(1);
      }
      const typed = splitCallValues(parsed.values);
      const named = alias ? splitCallValues(deps.aliases[alias]) : { voice: {}, output: {} };
      // Typed microphone settings are the session's, kept for later calls (as before); with an
      // alias they are this call's, like the alias's own. Speech output is always this call's.
      const kept = alias ? {} : typed.voice;
      const ownVoice = alias ? { ...named.voice, ...typed.voice } : {};
      const output = callOutputFrom({ ...named.output, ...typed.output }, surface);
      const providerName = (values) => values.provider || deps.env.PI_STT_PROVIDER || deps.persisted.provider || "azure";
      for (const values of [kept, ownVoice]) {
        if (Object.keys(values).length) rejectSurfaceAuthKeys(values, surface, { providerName: providerName(values), audioProviders: deps.audioProviders });
      }
      const state = await ops.read(commitOf(ctx));
      const next = { ...state.settings, ...kept };
      for (const key of Object.keys(kept)) if (String(kept[key]).trim() === "") delete next[key];
      const effective = withCallSettings(next, ownVoice);
      if (Object.keys(kept).length || Object.keys(ownVoice).length) {
        validateCallValues(effective, surface);
        const resolved = voiceSettings(effective, { ...deps, surface });
        // A device the session's Pulse server does not have is refused, with the ones it has.
        const choosesDevice = [kept, ownVoice].some((values) => ["device", "source", "server"].some((key) => Object.hasOwn(values, key) && String(values[key]).trim() !== ""));
        if (choosesDevice && resolved.device !== null) {
          const listed = await deps.listSources({ env: resolved.env });
          if (listed.ok && !listed.sources.some((source) => source.name === resolved.device)) {
            throw new Error(`${surface}: no Pulse source '${resolved.device}'. ${sourcesText(listed, null)}`);
          }
        }
      }
      if (Object.keys(kept).length) await ops.configure(commitOf(ctx), kept, surface);
      // This call's own settings: an alias replaces the live call's; sink=/pan= alone join them.
      const current = isLive(state.call) ? state.call.overlay ?? null : null;
      const overlay = alias
        ? { alias, voice: ownVoice, output }
        : output
          ? { ...(current ?? { voice: {} }), output: { ...(current?.output ?? {}), ...output } }
          : undefined;
      if (positionals.length > 1) throw new Error(`${surface}: unexpected '${positionals[1]}'`);
      const verb = String(positionals[0] ?? "").toLowerCase();
      const commit = commitOf(ctx);
      const live = isLive((await ops.read(commit)).call);
      switch (verb) {
        case "help": case "usage": case "?":
          ctx.notify(USAGE[name]);
          return;
        case "status":
          ctx.notify(await status(ctx));
          return;
        case "devices": case "sources": {
          const resolved = voiceSettings((await ops.read(commit)).settings, { ...deps, surface });
          ctx.notify(`${sourcesText(await deps.listSources({ env: resolved.env }), resolved.device)}\nChoose one with ${surface} device=NAME.`);
          return;
        }
        case "talk":
          ctx.notify(await talk(ctx, kind, overlay));
          return;
        case "aliases":
          ctx.notify(aliasesText());
          return;
        case "send":
          ctx.notify((await ops.update(commit, (call) => Object.assign(call, { talking: false, discard: false }))) ? "sent" : `${surface}: nothing live`);
          return;
        case "cancel":
          if (!live) { ctx.notify(`${surface}: nothing live`); return; }
          await ops.update(commit, (call) => Object.assign(call, { talking: false, discard: call.talking === true, partial: null }));
          ctx.notify("cancelled: nothing sent");
          return;
        case "mute": case "unmute":
          ctx.notify((await ops.update(commit, (call) => { call.muted = verb === "mute"; })) ? (verb === "mute" ? "muted" : "unmuted") : `${surface}: nothing live`);
          return;
        case "hangup": case "end": case "stop": case "off":
          ctx.notify((await ops.end(commit, { reason: kind === "call" ? "hung up" : "stopped", by: "you" })) ? `${kind === "call" ? "call" : name} ended` : `${surface}: nothing live`);
          return;
        case "": case "on": case "start": case "vad": case "ptt": {
          // Settings alone change a live call; with none live they start one, as TUI /stt does.
          if (verb === "" && live && overlay === undefined && Object.keys(kept).length) {
            ctx.notify(`${surface}: settings applied · ${await status(ctx)}`);
            return;
          }
          const ownMode = String(ownVoice.mode ?? "").toLowerCase();
          const mode = verb === "vad" || verb === "ptt" ? verb : name === "ptt" ? "ptt" : name === "stt" ? "vad" : ownMode === "ptt" || ownMode === "vad" ? ownMode : await settingsMode(ctx);
          const { started } = await startOf(ctx, kind, mode, false, overlay);
          ctx.notify(`${started ? "started" : "changed"} · ${await status(ctx)}`);
          return;
        }
        default:
          throw new Error(`${surface}: unknown '${verb}'. ${USAGE[name]}`);
      }
    } catch (error) {
      ctx.notify(String(error?.message || error).startsWith(surface) ? String(error.message) : `${surface}: ${error?.message || error}`);
    }
  };

  // The verbs; after device= (or source=), the sources the session's Pulse server has.
  const completions = (verbs) => async (prefix, ctx) => {
    const raw = String(prefix ?? "");
    const device = /^(.*?(?:^|\s)(?:device|source)=)(\S*)$/.exec(raw);
    if (device !== null) {
      let settings = {};
      try {
        const doc = typeof ctx?.harness?.snapshot === "function" ? await ctx.harness.snapshot(VOICE_DOC, ctx.context) : undefined;
        settings = doc?.settings ?? {};
      } catch {}
      let env;
      try { env = voiceSettings(settings, deps).env; } catch { return null; }
      const listed = await deps.listSources({ env });
      if (!listed.ok) return null;
      return listed.sources
        .filter((source) => source.name.startsWith(device[2]))
        .map((source) => ({ value: `${device[1]}${source.name}`, label: source.name, ...(source.state ? { description: source.state } : {}) }));
    }
    const text = raw.trimStart().toLowerCase();
    if (/\s/.test(text)) return null;
    return [...verbs, "devices"].filter((verb) => verb.startsWith(text)).map((verb) => ({ value: verb, label: verb }));
  };
  return {
    call: { description: `Voice call with this agent, run by the daemon. ${USAGE.call}`, run: run("call", "call"), getArgumentCompletions: completions([...Object.keys(deps.aliases), "vad", "ptt", "talk", "send", "cancel", "mute", "unmute", "hangup", "status", "aliases"]) },
    stt: { description: `Speech to text run by the daemon. ${USAGE.stt}`, run: run("stt", "stt"), getArgumentCompletions: completions([...Object.keys(deps.aliases), "on", "ptt", "off", "cancel", "status", "aliases"]) },
    ptt: { description: `Push-to-talk run by the daemon. ${USAGE.ptt}`, run: run("ptt", "stt"), getArgumentCompletions: completions([...Object.keys(deps.aliases), "on", "talk", "send", "cancel", "off", "status", "aliases"]) },
  };
}

/** The agent's end_call tool: hang up when what it hears is not meant for it. */
export function createVoiceTools({ task, now = () => Date.now() } = {}) {
  const ops = voiceOperations({ task, now });
  const text = (value) => {
    const output = [{ type: "text", text: value }];
    return { output, content: output };
  };
  return [
    {
      name: "end_call",
      description: "Hang up the voice call (or stop dictation) in this session: the daemon stops listening to the user's microphone. Use it when the conversation is over, or when what you hear is plainly not meant for you.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string", description: "Why, in a few words (shown to the user)." } },
        additionalProperties: false,
      },
      async execute(args, api, context) {
        const ended = await ops.end((change) => api.commit(change, context), { reason: "agent hung up", by: "agent", note: String(args?.reason ?? "") });
        return text(ended ? "Call ended." : "No call is live.");
      },
    },
  ];
}
