// Native clients for tools/cli/{tts,stt}: remote-cli POST /command, never a CLI hop.
import { open } from "node:fs/promises";
import { constants } from "node:fs";
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
      file = await open(String(path).replace(/^~(?=\/)/, home), constants.O_RDONLY | constants.O_NONBLOCK); // follows managed symlinks
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
    const error = new Error(`speech daemon: ${operation} rejected (${code}); details omitted`);
    error.code = code;
    throw error;
  }
  return reply;
}

export function daemonTtsRequest(text, options = {}, raw = false) {
  if (!String(text).trim() || Buffer.byteLength(String(text)) > 1024 * 1024) throw new Error("speech daemon: text must contain 1–1048576 bytes");
  const request = { text: String(text), raw, format: "pcm", request_id: validRequestId(options.requestId ?? randomUUID()) };
  for (const [field, value] of Object.entries({
    provider: options.daemonProvider, model: options.model, voice: options.voice,
    embedding: options.speakerProfileId ?? options.embedding, lang: options.lang, speed: options.speed,
    style: options.style, styledegree: options.styleDegree ?? options.styledegree,
    pitch: options.pitch, volume: options.volume, role: options.role, instructions: options.instructions,
    sink: options.daemonSink, name: options.streamName,
    // Raw PCM remains mono; pan is applied by the local player exactly once.
    pan: raw ? undefined : options.pan,
  })) {
    if (value !== undefined && value !== null) request[field] = value;
  }
  // Null in local settings explicitly clears string controls; wire null means
  // omitted to the daemon, so use the daemon's empty-string clear form.
  for (const [field, keys] of [["embedding", ["speakerProfileId", "embedding"]], ["lang", ["lang"]], ["style", ["style"]], ["role", ["role"]], ["instructions", ["instructions"]]]) {
    if (keys.some(key => Object.hasOwn(options, key) && options[key] === null)) request[field] = "";
  }
  for (const [key, min, max] of [["speed", .25, 4], ["styledegree", .01, 2], ["pitch", -50, 50], ["volume", 0, 100], ["pan", -1, 1]]) {
    if (request[key] != null && (!Number.isFinite(request[key]) || request[key] < min || request[key] > max)) throw new Error(`speech daemon: invalid ${key}`);
  }
  return request;
}

// Discover on each submission, not once per Pi session: deployments can add or
// remove capabilities while a session is alive. No credentials are cached.
export async function daemonCapabilities(kind, options = {}) {
  const health = await daemonRequest(kind, "/health", { ...options, timeoutMs: 5000 });
  const capabilities = health?.capabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.length > 256 || capabilities.some(c => typeof c !== "string" || c.length > 96)) throw new Error("speech daemon: invalid capabilities");
  return new Set(capabilities);
}

function validRequestId(id) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("speech daemon: invalid request ID");
  return id;
}

// Cancellation gets its own live signal/deadline; the original fetch is already
// aborted. A timeout or broken response is never reported as confirmed silence.
async function cancelOwnedJob(kind, id, options, capabilities) {
  const operation = kind === "tts" ? "tts.cancel" : "stt.transcribe.cancel";
  if (!id || !capabilities.has(operation)) return { id, outcome: "unsupported", settled: false };
  try {
    const timeout = Number(options.cancelTimeoutMs ?? 8000);
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 10000) : 8000;
    const reply = await daemonCommand(kind, operation, { id }, { ...options, signal: undefined, timeoutMs });
    const job = kind === "tts" && reply?.status === "ok" ? reply.job : kind === "stt" && reply?.status === "batch" ? reply.batch : null;
    if (job?.id !== id || !["completed", "failed", "cancelled"].includes(job.state)) throw new Error("speech daemon: invalid cancellation receipt");
    return { id, outcome: job.state, settled: true };
  } catch (error) {
    // The advertised contract creates a tombstone before returning not_found,
    // fencing a racing admission without claiming an old job was cancelled.
    if (error.code === "not_found") return { id, outcome: "not_admitted", settled: true };
    return { id, outcome: error.code === "cancel_pending" ? "pending" : "unconfirmed", settled: false };
  }
}

function requestFailure(error, { kind, id, bound, timeoutMs, submitted, terminal, cancellation }) {
  const aborted = bound.signal.aborted && !bound.isTimeout();
  const reason = bound.isTimeout() ? `timed out after ${timeoutMs}ms` : aborted ? "wait aborted" : error.message;
  const pending = submitted && !terminal && !cancellation?.settled;
  const outcome = cancellation ? `; cancellation:${cancellation.outcome}` : "";
  const failure = new Error(`speech daemon: ${reason}${id ? `; ${kind} job ${id}` : ""}${outcome}${pending ? "; remote work may still continue" : ""}; no automatic resubmission`);
  if (aborted) failure.name = "AbortError";
  failure.jobId = id;
  failure.remotePending = pending;
  if (cancellation) failure.cancellation = cancellation;
  return failure;
}

function validateAudioMetadata(job, request) {
  if (request.pan !== undefined && job.pan !== request.pan) throw new Error("speech daemon: mismatched pan receipt");
  if (request.pan === undefined && job.pan != null) throw new Error("speech daemon: unexpected pan receipt");
  if (job.muted) return;
  const channels = request.pan === undefined ? 1 : 2;
  if ((job.channels != null && job.channels !== channels) || (job.sample_rate != null && job.sample_rate !== 24000)
      || (request.pan !== undefined && (job.channels !== 2 || job.sample_rate !== 24000))) throw new Error("speech daemon: invalid PCM channel/rate metadata");
}

export async function requestDaemonTts(text, options = {}, { raw = false } = {}) {
  const request = daemonTtsRequest(text, options, raw);
  const configuredTimeout = Number(options.timeoutMs ?? 120000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120000;
  const bound = combineTimeoutSignal(options.signal, timeoutMs);
  const callOptions = { ...options, signal: bound.signal, timeoutMs: 0 };
  let submitted = false, terminal = false;
  let capabilities = new Set();
  const warnings = [];
  try {
    bound.signal.throwIfAborted();
    capabilities = await daemonCapabilities("tts", callOptions);
    if (request.pan !== undefined && !capabilities.has("pan")) {
      if (options.panSource !== "session") throw new Error("speech daemon: per-request pan unsupported; upgrade the TTS daemon or use playback=local");
      delete request.pan;
      warnings.push("TTS daemon lacks pan support; automatic session pan omitted until deployment.");
    }
    bound.signal.throwIfAborted();
    submitted = true;
    let reply = await daemonCommand("tts", "tts", request, callOptions);
    for (;;) {
      const job = reply?.job;
      if (reply?.status !== "ok" || job?.id !== request.request_id || job?.raw !== raw || job?.format !== "pcm") throw new Error("speech daemon: mismatched TTS receipt");
      terminal = ["completed", "failed", "cancelled"].includes(job.state);
      if (job.state === "completed") {
        if (request.provider && job.provider && job.provider !== request.provider) throw new Error("speech daemon: mismatched provider");
        validateAudioMetadata(job, request);
        if (!raw || job.muted) return { job, pcm: raw ? Buffer.alloc(0) : undefined, warnings };
        const path = `/snapshot/audio/${request.request_id}`;
        if (job.audio_path !== path || !Number.isSafeInteger(job.audio_bytes) || job.audio_bytes <= 0 || job.audio_bytes > MAX_SPEECH_AUDIO_BYTES) throw new Error("speech daemon: invalid audio receipt");
        const pcm = await daemonRequest("tts", path, callOptions);
        if (pcm.length !== job.audio_bytes || pcm.length % 2) throw new Error("speech daemon: invalid PCM length");
        await daemonCommand("tts", "tts.release", { id: job.id }, { ...options, timeoutMs: 1000 }).catch(() => {});
        return { job, pcm, warnings };
      }
      if (terminal) throw new Error(`speech daemon: job ${request.request_id} ${job.state}`);
      if (!["queued", "synthesizing", "ready", "playing"].includes(job.state)) throw new Error("speech daemon: unknown job state");
      await sleep(100, undefined, { signal: bound.signal });
      reply = await daemonCommand("tts", "tts.status", { id: request.request_id }, callOptions);
    }
  } catch (error) {
    bound.cleanup(); // Freeze the original timeout/cancel cause during cleanup.
    // Only caller intent cancels. A queue wait timeout/network failure never
    // discards admitted speech, and a conflicting ID never cancels another job.
    const cancellation = submitted && options.signal?.aborted && error.code !== "id_conflict"
      ? await cancelOwnedJob("tts", request.request_id, options, capabilities) : undefined;
    throw requestFailure(error, { kind: "tts", id: request.request_id, bound, timeoutMs, submitted, terminal, cancellation });
  } finally { bound.cleanup(); }
}

export const usesDaemonPlayback = (options = {}) => options.provider === "daemon" && options.playback !== "local";
export async function playDaemonSpeech(text, options = {}) {
  const release = holdAssistantSpeaking();
  try {
    const { job, warnings } = await requestDaemonTts(text, options);
    return { interrupted: false, remote: true, jobId: job.id, muted: !!job.muted, warnings };
  } finally { release(); }
}

export async function transcribeDaemonAudio(wav, options = {}) {
  if (!Buffer.isBuffer(wav) || wav.length > 25 * 1024 * 1024) throw new Error("speech daemon: WAV exceeds 25 MiB");
  const input = { audio_base64: wav.toString("base64") };
  for (const [key, value] of Object.entries({ provider: options.daemonProvider, model: options.model, language: options.language, prompt: options.prompt })) {
    if (value != null && value !== "") input[key] = value;
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs >= 0 ? options.timeoutMs : 30000;
  const bound = combineTimeoutSignal(options.signal, timeoutMs);
  const callOptions = { ...options, signal: bound.signal, timeoutMs: 0 };
  let capabilities = new Set(), id, submitted = false;
  try {
    bound.signal.throwIfAborted();
    capabilities = await daemonCapabilities("stt", callOptions);
    if (capabilities.has("stt.transcribe.cancel")) {
      id = validRequestId(options.requestId ?? randomUUID());
      input.request_id = id;
    } else if (options.requestId !== undefined) throw new Error("speech daemon: STT request identity unsupported; upgrade the STT daemon");
    bound.signal.throwIfAborted();
    submitted = true;
    const reply = await daemonCommand("stt", "stt.transcribe", input, callOptions);
    if (reply?.status !== "transcript" || typeof reply.transcript?.text !== "string" || (id && reply.id !== id)) throw new Error("speech daemon: invalid transcript receipt");
    return reply.transcript.text.trim();
  } catch (error) {
    bound.cleanup();
    const cancellation = submitted && options.signal?.aborted && error.code !== "id_conflict"
      ? await cancelOwnedJob("stt", id, options, capabilities) : undefined;
    throw requestFailure(error, { kind: "stt", id, bound, timeoutMs, submitted, cancellation });
  } finally { bound.cleanup(); }
}
