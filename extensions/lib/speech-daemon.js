// Native clients for tools/cli/{tts,stt}: remote-cli POST /command, never a CLI hop.
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { combineTimeoutSignal } from "./bounded-exec.js";
import { speechHttp, MAX_SPEECH_AUDIO_BYTES } from "./speech-http.js";
import { holdAssistantSpeaking } from "./half-duplex-state.js";

export function daemonUrl(kind, options = {}) {
  const env = options.env ?? process.env;
  const prefix = kind.toUpperCase();
  let value = options.daemonUrl ?? options.endpoint ?? options.baseUrl ?? env[`PI_${prefix}_DAEMON_URL`] ?? env[`${prefix}_DAEMON_URL`] ?? `http://helsinki:${kind === "tts" ? 7633 : 7634}`;
  value = String(value).trim();
  const bare = !value.includes("://");
  let url;
  try { url = new URL(bare ? `http://${value}` : value); } catch { throw new Error("speech daemon: invalid endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || /\s/.test(value)) {
    throw new Error("speech daemon: endpoint must be HTTP(S) without credentials, query or fragment");
  }
  const authority = value.split("/")[0];
  const hasPort = authority.startsWith("[") ? /\]:\d+$/.test(authority) : authority.includes(":");
  if (bare && !hasPort) url.port = String(kind === "tts" ? 7633 : 7634);
  return url.toString().replace(/\/+$/, "");
}

export async function daemonToken(kind, options = {}) {
  const env = options.env ?? process.env;
  const prefix = kind.toUpperCase();
  // DAMEON is an operator-deployed compatibility spelling; canonical spelling wins.
  const configured = env[`${prefix}_DAEMON_TOKEN`] || env[`${prefix}_DAMEON_TOKEN`];
  let token = configured;
  if (!token) {
    const home = env.HOME || homedir();
    const path = options.tokenFile ?? env[`${prefix}_TOKEN_FILE`] ?? join(env.XDG_CONFIG_HOME || join(home, ".config"), kind, "daemon-token");
    let file;
    try {
      file = await open(String(path).replace(/^~(?=\/)/, home), "r"); // follows managed symlinks
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16384) throw new Error("invalid token file");
      const bytes = Buffer.alloc(16385);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 16384) throw new Error("invalid token file");
      token = bytes.subarray(0, bytesRead).toString("utf8");
    } catch { throw new Error(`speech daemon: cannot read ${kind} token; set ${prefix}_DAEMON_TOKEN or ${prefix}_TOKEN_FILE`); }
    finally { await file?.close(); }
  }
  token = String(token).trim();
  if (!token || token.length > 16384 || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error("speech daemon: invalid bearer token");
  return token;
}

export async function daemonRequest(kind, path, options = {}, input) {
  const token = await daemonToken(kind, options); // reread on every call, including status polls
  return speechHttp(`${daemonUrl(kind, options)}${path}`, {
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? 120000,
    label: "speech daemon",
    json: input !== undefined || path === "/health",
    method: input === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(input === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

export async function daemonCommand(kind, operation, input, options = {}) {
  const reply = await daemonRequest(kind, "/command", options, { operation, input });
  if (reply?.status === "error") {
    const code = /^[a-z0-9_]{1,64}$/.test(reply.error?.code) ? reply.error.code : "remote_error";
    throw new Error(`speech daemon: ${operation} rejected (${code}); details omitted`);
  }
  return reply;
}

export function daemonTtsRequest(text, options = {}, raw = false) {
  if (!String(text).trim() || Buffer.byteLength(String(text)) > 1024 * 1024) throw new Error("speech daemon: text must contain 1–1048576 bytes");
  const request = { text: String(text), raw, format: "pcm", request_id: options.requestId ?? randomUUID() };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.request_id)) throw new Error("speech daemon: invalid request ID");
  for (const [field, value] of Object.entries({
    provider: options.daemonProvider, model: options.model, voice: options.voice,
    embedding: options.speakerProfileId ?? options.embedding, lang: options.lang, speed: options.speed,
    style: options.style, styledegree: options.styleDegree ?? options.styledegree,
    pitch: options.pitch, volume: options.volume, role: options.role, instructions: options.instructions,
    sink: options.daemonSink, name: options.streamName,
  })) {
    if (value !== undefined && value !== null) request[field] = value;
  }
  // Null in local settings explicitly clears string controls; wire null means
  // omitted to the daemon, so use the daemon's empty-string clear form.
  for (const [field, keys] of [["embedding", ["speakerProfileId", "embedding"]], ["lang", ["lang"]], ["style", ["style"]], ["role", ["role"]], ["instructions", ["instructions"]]]) {
    if (keys.some(key => Object.hasOwn(options, key) && options[key] === null)) request[field] = "";
  }
  for (const [key, min, max] of [["speed", .25, 4], ["styledegree", .01, 2], ["pitch", -50, 50], ["volume", 0, 100]]) {
    if (request[key] != null && (!Number.isFinite(request[key]) || request[key] < min || request[key] > max)) throw new Error(`speech daemon: invalid ${key}`);
  }
  return request;
}

export async function requestDaemonTts(text, options = {}, { raw = false } = {}) {
  const request = daemonTtsRequest(text, options, raw);
  const configuredTimeout = Number(options.timeoutMs ?? 120000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
  const bound = combineTimeoutSignal(options.signal, timeoutMs);
  const callOptions = { ...options, signal: bound.signal, timeoutMs: 0 };
  let submitted = false;
  try {
    bound.signal.throwIfAborted();
    submitted = true;
    let reply = await daemonCommand("tts", "tts", request, callOptions);
    for (;;) {
      const job = reply?.job;
      if (reply?.status !== "ok" || job?.id !== request.request_id || job?.raw !== raw || job?.format !== "pcm") throw new Error("speech daemon: mismatched TTS receipt");
      if (job.state === "completed") {
        if (request.provider && job.provider && job.provider !== request.provider) throw new Error("speech daemon: mismatched provider");
        if (!raw || job.muted) return { job, pcm: raw ? Buffer.alloc(0) : undefined };
        const path = `/snapshot/audio/${request.request_id}`;
        if (job.audio_path !== path || !Number.isSafeInteger(job.audio_bytes) || job.audio_bytes <= 0 || job.audio_bytes > MAX_SPEECH_AUDIO_BYTES) throw new Error("speech daemon: invalid audio receipt");
        const pcm = await daemonRequest("tts", path, callOptions);
        if (pcm.length !== job.audio_bytes || pcm.length % 2) throw new Error("speech daemon: invalid PCM length");
        // Best effort, bounded release. Never discard an active job or synthesize again.
        await daemonCommand("tts", "tts.release", { id: job.id }, { ...options, timeoutMs: 1000 }).catch(() => {});
        return { job, pcm };
      }
      if (["failed", "cancelled"].includes(job.state)) throw new Error(`speech daemon: job ${request.request_id} ${job.state}`);
      if (!["queued", "synthesizing", "ready", "playing"].includes(job.state)) throw new Error("speech daemon: unknown job state");
      await sleep(100, undefined, { signal: bound.signal });
      reply = await daemonCommand("tts", "tts.status", { id: request.request_id }, callOptions);
    }
  } catch (error) {
    const reason = bound.isTimeout() ? `timed out after ${timeoutMs}ms` : bound.signal.aborted ? "wait aborted" : error.message;
    const failure = new Error(`speech daemon: ${reason}${submitted ? `; job ${request.request_id} may still ${raw ? "synthesize" : "play"}; no automatic resubmission` : ""}`);
    failure.jobId = request.request_id;
    failure.remotePending = submitted;
    throw failure;
  } finally { bound.cleanup(); }
}

export const usesDaemonPlayback = (options = {}) => options.provider === "daemon" && options.playback !== "local";
export async function playDaemonSpeech(text, options = {}) {
  const release = holdAssistantSpeaking();
  try {
    const { job } = await requestDaemonTts(text, options);
    return { interrupted: false, remote: true, jobId: job.id, muted: !!job.muted };
  } finally { release(); }
}

export async function transcribeDaemonAudio(wav, options = {}) {
  if (!Buffer.isBuffer(wav) || wav.length > 25 * 1024 * 1024) throw new Error("speech daemon: WAV exceeds 25 MiB");
  const input = { audio_base64: wav.toString("base64") };
  for (const [key, value] of Object.entries({ provider: options.daemonProvider, model: options.model, language: options.language, prompt: options.prompt })) {
    if (value != null && value !== "") input[key] = value;
  }
  const reply = await daemonCommand("stt", "stt.transcribe", input, options);
  if (reply?.status !== "transcript" || typeof reply.transcript?.text !== "string") throw new Error("speech daemon: invalid transcript receipt");
  return reply.transcript.text.trim();
}
