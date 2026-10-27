// Voice input for pi-daemon sessions (bd-6ffaf9): /call, and /stt and /ptt, run by the daemon.
//
// A Durable background task holds the session's microphone: a Pulse record stream with the
// session's own device= and server=. It finds speech with TUI /stt's local VAD
// (LocalVadController), transcribes it with the same providers (transcribeSpeech) and submits
// each turn as the user's message, as a follow-up while the agent works (or a steer). Sessions
// with live tasks resume at startup, so a call outlives a worker restart.
//
// The settings and the call's state are one session document (VOICE_DOC). Every client follows
// it (durable/voice-client.js draws it with the TUI's speech chip), so all of them show the same
// call. Settings resolve as TUI /stt's: settings.json agentUtils.stt, then the worker's
// environment, then the session's own `key=value` (an overlay, never process.env). Each session
// has its own; any number of sessions may hold calls at once.
//
// A call (/call) hangs up after `hangup_after` without speech (5 minutes by default), and the
// agent can end it with end_call. Dictation (/stt, /ptt) stays on until stopped. Input is muted
// while this session's speech plays (tts.mjs), as TUI /stt is.
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

export { VOICE_DOC };
export const VOICE_TASK = "agent-utils.voice";
export const DEFAULT_HANGUP_AFTER_MS = 5 * 60_000;
/** Settings of the call itself (not STT): its default mode, delivery and silence hang-up. */
export const VOICE_CALL_KEYS = Object.freeze(["mode", "deliver", "hangup_after"]);
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
  if (values.deliver !== undefined && !["followup", "follow-up", "steer"].includes(String(values.deliver).toLowerCase())) throw new Error(`${surface}: deliver must be followup or steer`);
  if (values.hangup_after !== undefined && parseDurationMs(values.hangup_after) === null) throw new Error(`${surface}: hangup_after must be a duration such as 5m, or off`);
}

/**
 * A session's environment and resolved settings: the worker's environment with the session's
 * values over it, and settings.json's agentUtils.stt under both.
 */
export function voiceSettings(values = {}, { env = process.env, persisted = {}, audioProviders, surface = "/call" } = {}) {
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
    deliver: String(values.deliver ?? "").toLowerCase() === "steer" ? "steer" : "followUp",
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
    const args = ["--record", "--raw", "--format=s16le", `--rate=${SAMPLE_RATE}`, `--channels=${CHANNELS}`, `--stream-name=${streamName}`];
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
  constructor({ sessionId, taskId, deps, patch, submit, requestEnd, sent }) {
    Object.assign(this, { sessionId, taskId, deps, patch, submit, requestEnd });
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
    const settingsKey = JSON.stringify(doc.settings ?? {});
    const before = this.seen;
    this.seen = { kind: call.kind, mode: call.mode, talking: call.mode === "ptt" && call.talking === true, muted: call.muted === true, settingsKey, discard: call.discard === true };
    // New settings or another mode: the microphone reopens with them.
    const restart = before.settingsKey !== settingsKey || before.mode !== call.mode;
    if (restart) {
      try { this.settings = voiceSettings(doc.settings ?? {}, this.deps); }
      catch (error) {
        this.fail(error);
        await this.stopCapture({ flush: false });
        this.requestEnd({ reason: "settings invalid" });
        return;
      }
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
      capture = deps.capture({ env: settings.env, executables: deps.executables, streamName: `pi-call-${this.sessionId.slice(0, 12)}`, sessionId: this.sessionId });
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
      await this.submit(labelUntrustedTranscript(content, this.settings.env), {
        requestId: `voice:${this.taskId}:${number}`,
        whenBusy: this.settings.deliver === "steer" ? "steer" : "followUp",
      });
      this.sent = number;
      this.lastHeardAt = this.deps.now();
      this.error = null;
      this.patch({ partial: null, sent: number, lastHeardAt: this.lastHeardAt, error: null }, { sent: number });
    } catch (error) {
      this.fail(error);
    }
  }

  armTimer() {
    if (this.timer || this.done) return;
    this.timer = this.deps.setInterval(() => {
      if (this.done || this.seen.kind !== "call" || this.seen.talking) return;
      const after = this.settings?.hangupAfterMs ?? DEFAULT_HANGUP_AFTER_MS;
      if (after > 0 && this.deps.now() - this.lastHeardAt >= after) this.requestEnd({ reason: "silence" });
    }, this.deps.tickMs);
    this.timer?.unref?.();
  }

  async stop({ discard = false } = {}) {
    if (this.done) return;
    this.done = true;
    if (this.timer) this.deps.clearInterval(this.timer);
    this.timer = null;
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
          const call = new VoiceCall({ sessionId: String(task.input?.sessionId ?? ""), taskId, deps, patch, submit, requestEnd, sent });
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
  log = (line) => { try { process.stderr.write(`${line}\n`); } catch {} },
} = {}) {
  return {
    env, persisted, audioProviders, executables, transcribe, speaking, now, tickMs, log,
    capture: capture ?? ((options) => defaultCapture({ ...options, ...(spawnImpl ? { spawnImpl } : {}) })),
    setInterval: setTimer,
    clearInterval: clearTimer,
  };
}

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
        return next;
      });
    },
    /** Start voice input, or change the live one to this kind and mode. */
    async start(commit, { sessionId, conversationId, kind, mode, talking = false }) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        const at = now();
        if (isLive(doc.call)) {
          Object.assign(doc.call, { kind, mode, talking: mode === "ptt" && talking, discard: false });
          return { started: false, call: doc.call };
        }
        const taskId = await tx.createTask(task, { sessionId, startedAt: at }, { ownership: { kind: "conversation" }, conversationId, background: true });
        doc.seq = (Number(doc.seq) || 0) + 1;
        doc.call = {
          number: doc.seq, taskId: String(taskId), kind, mode, startedAt: at, phase: mode === "ptt" && !talking ? "armed" : "listening",
          talking: mode === "ptt" && talking, muted: false, discard: false, partial: null, lastHeardAt: at, sent: 0, error: null, end: null,
        };
        return { started: true, call: doc.call };
      });
    },
    async update(commit, change) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        if (!isLive(doc.call)) return null;
        change(doc.call);
        return doc.call;
      });
    },
    async end(commit, { reason, by, note, discard = false }) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        if (!isLive(doc.call)) return null;
        doc.call.end = { reason, by, at: now(), ...(note ? { note: bounded(note, 200) } : {}), ...(discard ? { discard: true } : {}) };
        return doc.call;
      });
    },
    async read(commit) {
      return commit(async (tx) => {
        const doc = await tx.doc(VOICE_DOC);
        return { settings: { ...(doc.settings ?? {}) }, call: doc.call ? { ...doc.call } : null, last: doc.last ? { ...doc.last } : null };
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
  try { resolved = voiceSettings(state.settings, deps); } catch (error) { return `voice: settings invalid: ${error.message}`; }
  const where = `device:${resolved.device ?? "default"} · server:${resolved.server ?? "default"}`;
  const stt = `provider:${resolved.stt.providerName && resolved.stt.providerName !== resolved.stt.provider ? `${resolved.stt.providerName}(${resolved.stt.provider})` : resolved.stt.provider} · model:${resolved.stt.model ?? "default"}`;
  const call = state.call;
  if (!call) {
    const last = state.last ? ` · last ${state.last.kind} ended (${state.last.reason}) ${formatAgo(now - state.last.endedAt)} ago, ${state.last.sent} sent` : "";
    return `voice:off · ${where} · ${stt}${last}`;
  }
  const hangup = call.kind === "call" ? ` · hangup_after:${resolved.hangupAfterMs ? formatAgo(resolved.hangupAfterMs) : "off"}` : "";
  return `${call.kind}:on · ${call.mode} · ${call.end ? `ending (${call.end.reason})` : call.phase}${call.muted ? " · muted" : ""} · ${where} · ${stt} · ${call.sent ?? 0} sent · ${formatAgo(now - call.startedAt)}${hangup}${call.error ? ` · error: ${call.error}` : ""} · ${describeLocalVadConfig(resolved.vad)}`;
}

const USAGE = {
  call: "/call [vad|ptt] [key=value …] starts a voice call (or changes the live one); /call talk (PTT: start, then send), send, cancel, mute, unmute, hangup, status. Settings: device= server= provider= model= language= energy= … mode= deliver=followup|steer hangup_after=5m|off.",
  stt: "/stt [on|ptt|off|cancel|status|key=value …]: dictation run by the daemon, each turn sent as your message. Settings as /call (device=, server=, provider=, model=, …).",
  ptt: "/ptt [on|talk|send|cancel|off|status|key=value …]: push-to-talk run by the daemon. /ptt talk starts recording; /ptt talk (or send) sends.",
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
  const startOf = (ctx, kind, mode, talking) => ops.start(commitOf(ctx), { sessionId: ctx.sessionId, conversationId: ctx.conversationId, kind, mode, talking });
  const settingsMode = async (ctx) => {
    const { settings } = await ops.read(commitOf(ctx));
    return String(settings.mode ?? "vad").toLowerCase() === "ptt" ? "ptt" : "vad";
  };
  // /call talk and /ptt talk: start PTT (a call if none), or send what was said.
  const talk = async (ctx, kind) => {
    const { call } = await ops.read(commitOf(ctx));
    if (!isLive(call)) {
      await startOf(ctx, kind, "ptt", true);
      return "🎙 talking: /" + (kind === "call" ? "call" : "ptt") + " talk again to send";
    }
    if (call.mode !== "ptt" || !call.talking) {
      await ops.update(commitOf(ctx), (live) => Object.assign(live, { mode: "ptt", talking: true, discard: false }));
      return "🎙 talking";
    }
    await ops.update(commitOf(ctx), (live) => Object.assign(live, { talking: false, discard: false }));
    return "sent";
  };

  const run = (name, kind) => async (args, ctx) => {
    if (!ready(ctx, name)) return;
    const surface = `/${name}`;
    try {
      await prune(ctx);
      const parsed = parseEnvStyleArgs(String(args ?? ""));
      const values = parsed.values;
      if (Object.keys(values).length) {
        rejectSurfaceAuthKeys(values, surface, { providerName: values.provider || deps.env.PI_STT_PROVIDER || deps.persisted.provider || "azure", audioProviders: deps.audioProviders });
        await ops.configure(commitOf(ctx), values, surface);
      }
      if (parsed.positionals.length > 1) throw new Error(`${surface}: unexpected '${parsed.positionals[1]}'`);
      const verb = String(parsed.positionals[0] ?? "").toLowerCase();
      const commit = commitOf(ctx);
      const live = isLive((await ops.read(commit)).call);
      switch (verb) {
        case "help": case "usage": case "?":
          ctx.notify(USAGE[name]);
          return;
        case "status":
          ctx.notify(await status(ctx));
          return;
        case "talk":
          ctx.notify(await talk(ctx, kind));
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
          if (verb === "" && live && Object.keys(values).length) {
            ctx.notify(`${surface}: settings applied · ${await status(ctx)}`);
            return;
          }
          const mode = verb === "vad" || verb === "ptt" ? verb : name === "ptt" ? "ptt" : name === "stt" ? "vad" : await settingsMode(ctx);
          const { started } = await startOf(ctx, kind, mode, false);
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

  const completions = (verbs) => (prefix) => {
    const text = String(prefix ?? "").trimStart().toLowerCase();
    if (/\s/.test(text)) return null;
    return verbs.filter((verb) => verb.startsWith(text)).map((verb) => ({ value: verb, label: verb }));
  };
  return {
    call: { description: `Voice call with this agent, run by the daemon. ${USAGE.call}`, run: run("call", "call"), getArgumentCompletions: completions(["vad", "ptt", "talk", "send", "cancel", "mute", "unmute", "hangup", "status"]) },
    stt: { description: `Speech to text run by the daemon. ${USAGE.stt}`, run: run("stt", "stt"), getArgumentCompletions: completions(["on", "ptt", "off", "cancel", "status"]) },
    ptt: { description: `Push-to-talk run by the daemon. ${USAGE.ptt}`, run: run("ptt", "stt"), getArgumentCompletions: completions(["on", "talk", "send", "cancel", "off", "status"]) },
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
