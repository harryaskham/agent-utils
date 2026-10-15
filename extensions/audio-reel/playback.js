// Audio reel playback engine. One owned decoder→sink pipeline at a time:
//
//   PCM16 WAV (mono/stereo) ──fs stream + volume──▶ sink   (no ffmpeg needed)
//   anything else ──ffmpeg -ss -i … -f s16le────────▶ sink
//
// Sinks follow the speech backends: pulse (pacat; honours PULSE_SERVER /
// PULSE_SINK or explicit server/sink), sox (`play`), or ffplay (CoreAudio on
// macOS). Pause/seek/volume restart the pipeline at the tracked position, so
// every backend supports them identically. Nothing here touches TTS mute
// policy, the shared speech queue, default sinks or other streams.
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { parseWavHeader } from "../lib/shared-audio.js";

export const DECODE_RATE = 48000;
export const DECODE_CHANNELS = 2;
export const AUDIO_BACKENDS = Object.freeze(["auto", "pulse", "sox", "ffplay"]);
const BACKEND_ALIASES = new Map([
  ["auto", "auto"], ["pulse", "pulse"], ["pulseaudio", "pulse"], ["pacat", "pulse"], ["paplay", "pulse"], ["pipewire", "pulse"],
  ["sox", "sox"], ["play", "sox"], ["ffplay", "ffplay"], ["coreaudio", "ffplay"], ["ffmpeg", "ffplay"],
]);
const own = (value, key) => Object.hasOwn(value || {}, key);

export function normalizeBackend(value) {
  const backend = BACKEND_ALIASES.get(String(value ?? "auto").trim().toLowerCase());
  if (!backend) throw new Error(`Unsupported audio backend '${value}' (use auto, pulse, sox or ffplay/coreaudio)`);
  return backend;
}

function outputValue(value, name) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 1024 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Audio output ${name} must be a bounded string without control characters`);
  return value;
}

/// Validate a partial output override. `null`/"" for server/sink explicitly
/// selects the default (it is not "inherit").
export function normalizeOutputPatch(patch = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("Audio output must be an object");
  const allowed = new Set(["backend", "server", "sink", "device"]);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`Unsupported audio output setting '${key}'`);
  if (own(patch, "sink") && own(patch, "device") && patch.sink !== patch.device) throw new Error("Audio output sink and device must agree");
  const out = {};
  if (own(patch, "backend") && patch.backend !== undefined) out.backend = normalizeBackend(patch.backend);
  if (own(patch, "server")) out.server = outputValue(patch.server, "server");
  if (own(patch, "sink") || own(patch, "device")) out.sink = outputValue(patch.sink ?? patch.device, "sink");
  return out;
}

/// Effective output for one playback: explicit settings, then PI_AUDIO_*,
/// then the standard Pulse environment, then platform defaults.
export function resolveAudioOutput(output = {}, env = process.env, platform = process.platform) {
  const patch = normalizeOutputPatch(output);
  const server = own(patch, "server") ? patch.server : outputValue(env.PI_AUDIO_SERVER || env.PULSE_SERVER || null, "server");
  const sink = own(patch, "sink") ? patch.sink : outputValue(env.PI_AUDIO_SINK || env.PULSE_SINK || null, "sink");
  let backend = patch.backend ?? normalizeBackend(env.PI_AUDIO_BACKEND || "auto");
  const requested = backend;
  if (backend === "auto") backend = server || sink || platform !== "darwin" ? "pulse" : "ffplay";
  return { backend, requested, server, sink, serverExplicit: own(patch, "server"), sinkExplicit: own(patch, "sink") };
}

export function describeAudioOutput(resolved) {
  if (resolved.backend === "pulse") return `pulse · sink ${resolved.sink || "default"} · server ${resolved.server || "local"}`;
  if (resolved.backend === "sox") return `sox${resolved.sink ? ` · device ${resolved.sink}` : ""}`;
  return "ffplay (system output)";
}

function childEnvironment(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (/(?:API_KEY|_TOKEN|DAEMON_TOKEN|DAMEON_TOKEN|_SECRET)$/i.test(key)) delete out[key];
  }
  return out;
}

export function streamLabel(value) {
  return String(value || "clip").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 120) || "clip";
}

export function buildSinkSpec({ backend, server = null, sink = null, serverExplicit = false, sinkExplicit = false, rate = DECODE_RATE, channels = DECODE_CHANNELS, streamName = "clip", env = process.env } = {}) {
  const childEnv = childEnvironment(env);
  if (server) childEnv.PULSE_SERVER = server;
  else if (serverExplicit) delete childEnv.PULSE_SERVER;
  if (sinkExplicit && !sink) delete childEnv.PULSE_SINK;
  const name = streamLabel(streamName);
  if (backend === "pulse") {
    const args = ["--playback", "--raw", "--format=s16le", `--rate=${rate}`, `--channels=${channels}`, "--latency-msec=120"];
    if (server) args.push(`--server=${server}`);
    if (sink) args.push(`--device=${sink}`);
    args.push("--client-name=pi audio reel", `--stream-name=${name}`);
    return { command: "pacat", args, env: childEnv };
  }
  if (backend === "sox") {
    if (sink) childEnv.AUDIODEV = sink;
    return { command: "play", args: ["-q", "-t", "raw", "-b", "16", "-e", "signed-integer", "-L", "-r", String(rate), "-c", String(channels), "-"], env: childEnv };
  }
  if (backend === "ffplay") {
    return { command: "ffplay", args: ["-nodisp", "-autoexit", "-loglevel", "error", "-window_title", name, "-f", "s16le", "-ar", String(rate), "-ch_layout", channels === 1 ? "mono" : "stereo", "-i", "-"], env: childEnv };
  }
  throw new Error(`Unsupported audio backend '${backend}'`);
}

export function buildDecoderSpec({ path, startMs = 0, volume = 1, rate = DECODE_RATE, channels = DECODE_CHANNELS, command = "ffmpeg" } = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) throw new Error("Decoder input must be an absolute path");
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  if (startMs > 0) args.push("-ss", (startMs / 1000).toFixed(3));
  // file: prevents a path from being interpreted as another ffmpeg protocol.
  args.push("-i", `file:${path}`, "-vn", "-sn", "-dn");
  if (Math.abs(volume - 1) > 0.001) args.push("-af", `volume=${Math.max(0, volume).toFixed(3)}`);
  args.push("-acodec", "pcm_s16le", "-f", "s16le", "-ar", String(rate), "-ac", String(channels), "pipe:1");
  return { command, args };
}

/// PCM16 gain stage that never splits a sample across chunks.
export function createPcm16VolumeTransform(volume = 1) {
  const gain = Math.max(0, Number(volume) || 0);
  let carry = null;
  return new Transform({
    transform(chunk, _encoding, callback) {
      let data = carry ? Buffer.concat([carry, chunk]) : chunk;
      carry = null;
      if (data.length & 1) { carry = data.subarray(data.length - 1); data = data.subarray(0, data.length - 1); }
      if (Math.abs(gain - 1) < 0.001) return callback(null, data);
      const out = Buffer.allocUnsafe(data.length);
      for (let i = 0; i + 1 < data.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE(i) * gain))), i);
      callback(null, out);
    },
  });
}

/// Choose the native PCM16 WAV path or ffmpeg. Reads at most the first 1 MiB.
export async function planPlayback(path, { startMs = 0, openImpl = open } = {}) {
  let wav = null;
  const handle = await openImpl(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Audio clip is not a regular file");
    const prefix = Buffer.alloc(Math.min(info.size, 1024 * 1024));
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    wav = parseWavHeader(prefix.subarray(0, bytesRead), info.size);
  } finally { await handle.close(); }
  if (wav && wav.format === 1 && wav.bitsPerSample === 16 && wav.channels >= 1 && wav.channels <= 2) {
    const frame = Math.min(Math.floor((startMs / 1000) * wav.sampleRate), Math.floor(wav.dataBytes / wav.blockAlign));
    const start = wav.dataOffset + frame * wav.blockAlign;
    return { kind: "wav", start, end: wav.dataOffset + wav.dataBytes, rate: wav.sampleRate, channels: wav.channels, durationMs: wav.durationMs };
  }
  return { kind: "ffmpeg", rate: DECODE_RATE, channels: DECODE_CHANNELS, durationMs: wav?.durationMs };
}

export function probeDurationMs(path, { execFileImpl = nodeExecFile, timeoutMs = 5000, command = "ffprobe" } = {}) {
  return new Promise((resolve) => {
    try {
      execFileImpl(command, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", `file:${path}`], { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout) => {
        const seconds = Number.parseFloat(String(stdout || "").trim());
        resolve(!error && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined);
      });
    } catch { resolve(undefined); }
  });
}

const tail = (text, chunk) => `${text}${String(chunk)}`.slice(-600);
function missingBinary(error, command) {
  return error?.code === "ENOENT"
    ? new Error(command === "ffmpeg" ? "ffmpeg is required to play this format (PCM16 WAV plays without it)" : `${command} not found for the selected audio backend; choose another with /audio-output backend=…`)
    : error;
}

/// Owned pipeline with position tracking. Events: { type: "ended"|"error", key, error? }.
export class AudioPlayback {
  constructor({ spawnImpl = nodeSpawn, now = () => performance.now(), env = () => process.env, ffmpeg = "ffmpeg", killDelayMs = 300, onEvent = () => {}, openImpl = open } = {}) {
    Object.assign(this, { spawnImpl, now, envSource: env, ffmpeg, killDelayMs, onEvent, openImpl });
    this.generation = 0;
    this.record = null;
    this.state = { status: "idle", key: null, offsetMs: 0, startedAt: 0, durationMs: undefined, error: null, output: null, pipeline: null };
  }

  env() { return typeof this.envSource === "function" ? this.envSource() : this.envSource; }

  positionMs() {
    const s = this.state;
    const raw = s.status === "playing" ? s.offsetMs + Math.max(0, this.now() - s.startedAt) : s.offsetMs;
    return Math.max(0, Number.isFinite(s.durationMs) ? Math.min(raw, s.durationMs) : raw);
  }

  snapshot() {
    return { status: this.state.status, key: this.state.key, positionMs: Math.round(this.positionMs()), durationMs: this.state.durationMs, error: this.state.error, output: this.state.output, pipeline: this.state.pipeline };
  }

  /// Start `item` (needs .key and an absolute .path) at positionMs.
  async play(item, { positionMs = 0, volume = 1, output = {}, label } = {}) {
    this.#kill();
    const generation = ++this.generation;
    const env = this.env();
    const resolved = resolveAudioOutput(output, env);
    let plan;
    try { plan = await planPlayback(item.path, { startMs: positionMs, openImpl: this.openImpl }); }
    catch (error) { if (generation === this.generation) this.#fail(generation, item.key, error); throw error; }
    if (generation !== this.generation) return this.snapshot();
    const durationMs = Number.isFinite(plan.durationMs) ? plan.durationMs : item.durationMs;
    const startMs = Number.isFinite(durationMs) ? Math.min(Math.max(0, positionMs), durationMs) : Math.max(0, positionMs);
    const sinkSpec = buildSinkSpec({ ...resolved, rate: plan.rate, channels: plan.channels, streamName: label || item.label, env });
    const record = { generation, key: item.key, killed: false, sink: null, decoder: null, source: null, sinkStderr: "", decoderStderr: "", sinkDone: null, decoderDone: plan.kind === "wav" ? { code: 0 } : null, timers: [] };
    this.record = record;
    try {
      record.sink = this.spawnImpl(sinkSpec.command, sinkSpec.args, { stdio: ["pipe", "ignore", "pipe"], env: sinkSpec.env });
    } catch (error) { this.#fail(generation, item.key, missingBinary(error, sinkSpec.command)); throw error; }
    record.sink.on?.("error", (error) => this.#fail(generation, item.key, missingBinary(error, sinkSpec.command)));
    record.sink.stderr?.on?.("data", (chunk) => { record.sinkStderr = tail(record.sinkStderr, chunk); });
    record.sink.stdin?.on?.("error", () => {}); // EPIPE follows a sink diagnostic or a kill.
    record.sink.once?.("close", (code, signal) => { record.sinkDone = { code, signal }; this.#settle(record); });
    if (plan.kind === "wav") {
      const source = createReadStream(item.path, { start: plan.start, end: Math.max(plan.start, plan.end - 1) });
      record.source = source;
      source.on("error", (error) => this.#fail(generation, item.key, error));
      if (plan.end > plan.start) source.pipe(createPcm16VolumeTransform(volume)).pipe(record.sink.stdin);
      else { source.destroy(); record.sink.stdin?.end?.(); }
    } else {
      const decoderSpec = buildDecoderSpec({ path: item.path, startMs, volume, rate: plan.rate, channels: plan.channels, command: this.ffmpeg });
      try {
        record.decoder = this.spawnImpl(decoderSpec.command, decoderSpec.args, { stdio: ["ignore", "pipe", "pipe"], env: childEnvironment(env) });
      } catch (error) { this.#fail(generation, item.key, missingBinary(error, "ffmpeg")); throw error; }
      record.decoder.on?.("error", (error) => this.#fail(generation, item.key, missingBinary(error, "ffmpeg")));
      record.decoder.stderr?.on?.("data", (chunk) => { record.decoderStderr = tail(record.decoderStderr, chunk); });
      record.decoder.stdout?.on?.("error", () => {});
      record.decoder.stdout?.pipe?.(record.sink.stdin);
      record.decoder.once?.("close", (code, signal) => { record.decoderDone = { code, signal }; this.#settle(record); });
    }
    this.state = { status: "playing", key: item.key, offsetMs: startMs, startedAt: this.now(), durationMs, error: null, output: resolved, pipeline: plan.kind, volume };
    return this.snapshot();
  }

  pause() {
    if (this.state.status !== "playing") return this.snapshot();
    const position = this.positionMs();
    this.#kill();
    this.generation++;
    this.state = { ...this.state, status: "paused", offsetMs: position };
    return this.snapshot();
  }

  stop() {
    this.#kill();
    this.generation++;
    this.state = { ...this.state, status: this.state.key ? "stopped" : "idle", offsetMs: 0, error: null };
    return this.snapshot();
  }

  /// Park the cursor on `item` at positionMs without playing; the next
  /// resume starts there. Stops any other clip's pipeline.
  cue(item, positionMs = 0) {
    if (this.state.status === "playing" || this.state.key !== item.key) { this.#kill(); this.generation++; }
    const durationMs = Number.isFinite(item.durationMs) ? item.durationMs : this.state.key === item.key ? this.state.durationMs : undefined;
    const offsetMs = Math.max(0, Number.isFinite(durationMs) ? Math.min(positionMs, durationMs) : positionMs);
    this.state = { ...this.state, status: "paused", key: item.key, durationMs, offsetMs, error: null };
    return this.snapshot();
  }

  dispose() { this.#kill(); this.generation++; this.state = { ...this.state, status: "idle" }; }

  #settle(record) {
    if (record.killed || record.generation !== this.generation) return;
    const { sinkDone, decoderDone } = record;
    // A failing decoder closes the sink's stdin cleanly; wait for both, unless
    // the sink itself failed, which must stop the decoder immediately.
    if (sinkDone && sinkDone.code !== 0 && sinkDone.code !== null) {
      const detail = record.sinkStderr.trim();
      return this.#fail(record.generation, record.key, new Error(`audio output exited ${sinkDone.code}${detail ? `: ${detail}` : ""}`));
    }
    if (decoderDone && decoderDone.code !== 0 && decoderDone.code !== null) {
      const detail = record.decoderStderr.trim();
      return this.#fail(record.generation, record.key, new Error(`ffmpeg exited ${decoderDone.code}${detail ? `: ${detail}` : ""}`));
    }
    if (!sinkDone || !decoderDone) return;
    if (sinkDone.signal || decoderDone.signal) return this.#fail(record.generation, record.key, new Error(`audio pipeline stopped by ${sinkDone.signal || decoderDone.signal}`));
    this.record = null;
    this.state = { ...this.state, status: "ended", offsetMs: Number.isFinite(this.state.durationMs) ? this.state.durationMs : this.positionMs() };
    this.onEvent({ type: "ended", key: record.key });
  }

  #fail(generation, key, error) {
    if (generation !== this.generation) return;
    this.#kill();
    this.generation++;
    const message = String(error?.message || error).slice(0, 600);
    this.state = { ...this.state, status: "error", key, error: message, offsetMs: this.positionMs() };
    this.onEvent({ type: "error", key, error: message });
  }

  #kill() {
    const record = this.record;
    this.record = null;
    if (!record || record.killed) return;
    record.killed = true;
    try { record.source?.destroy?.(); } catch {}
    for (const child of [record.decoder, record.sink]) {
      if (!child) continue;
      try { child.stdout?.unpipe?.(); } catch {}
      try { child.stdin?.destroy?.(); } catch {}
      try { child.kill?.("SIGTERM"); } catch {}
      let exited = false;
      child.once?.("exit", () => { exited = true; });
      if (this.killDelayMs > 0) {
        const timer = setTimeout(() => { if (!exited && child.exitCode == null && child.signalCode == null) { try { child.kill?.("SIGKILL"); } catch {} } }, this.killDelayMs);
        timer.unref?.();
      }
    }
  }
}
