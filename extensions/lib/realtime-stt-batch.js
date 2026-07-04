// One-shot batch transcription over a PCM buffer for the `/rt stt local-vad`
// mode (bd-9399e7): spawns `stt --stdin --transcription-model <model>` (REST,
// non-streaming), pipes a raw PCM16/24k/mono buffer to stdin, and resolves with
// the transcript. The `stt` CLI's `--stdin` reads exactly this format (see
// realtime-audio.js, the format source of truth).
//
// The arg builder is pure (unit-tested) and `spawnImpl` is injectable so the
// subprocess plumbing can be tested without the `stt` binary or audio.

import { spawn } from "node:child_process";
import { runBoundedSubprocess } from "./bounded-exec.js";

export const DEFAULT_STT_BATCH_MODEL = "mai-transcribe-1.5";

/// Default bound on how long the one-shot `stt` subprocess may run before it is
/// killed and the transcription rejected (bd-adde03).
export const DEFAULT_STT_BATCH_TIMEOUT_MS = 30000;

/// Resolve the batch stt timeout (ms) from PI_RT_LOCAL_VAD_TIMEOUT_MS, else the
/// default. A value of 0 disables the timeout; non-numeric/negative falls back
/// to the default. Pure. (bd-adde03)
export function resolveBatchSttTimeoutMs(env = process.env) {
  const raw = env.PI_RT_LOCAL_VAD_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_STT_BATCH_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_STT_BATCH_TIMEOUT_MS;
  return n;
}

/// Resolve the batch stt model for local-vad: PI_RT_LOCAL_VAD_MODEL or the batch
/// default. Deliberately INDEPENDENT of the realtime-WebSocket transcription
/// model (config.transcriptionModel), which may be a realtime-only model
/// (e.g. gpt-realtime-whisper) that a batch REST `stt` call cannot use.
export function resolveBatchSttModel(env = process.env) {
  const raw = env.PI_RT_LOCAL_VAD_MODEL;
  return typeof raw === "string" && raw.trim() ? raw.trim() : DEFAULT_STT_BATCH_MODEL;
}

/// Build the `stt` argv for one-shot stdin transcription. Pure.
export function buildSttBatchArgs({ model = DEFAULT_STT_BATCH_MODEL, language } = {}) {
  const args = ["--stdin", "--transcription-model", String(model)];
  if (language) args.push("--language", String(language));
  return args;
}

/// Transcribe a raw PCM16/24k/mono `buffer` via a one-shot `stt --stdin`
/// subprocess. Resolves with the trimmed transcript; rejects on spawn error, a
/// non-zero exit (carrying stderr), or a timeout (bd-adde03: a stalled stt call
/// must not hang local-vad's "transcribing" state forever). `command`/`spawnImpl`
/// are injectable; `timeoutMs` defaults to resolveBatchSttTimeoutMs() (0 = off).
export async function transcribePcmBuffer(buffer, { model, language, command = "stt", spawnImpl = spawn, timeoutMs } = {}) {
  const timeout = timeoutMs == null ? resolveBatchSttTimeoutMs() : Number(timeoutMs);
  // bd-adde03/bd-29a134: bound the wait (shared runBoundedSubprocess) so a
  // stalled stt call surfaces an error and local-vad returns to listening
  // instead of hanging "transcribing" forever. onSpawn writes the committed PCM
  // to stdin after the listeners/timer are attached.
  const { code, stdout, stderr } = await runBoundedSubprocess({
    command,
    args: buildSttBatchArgs({ model, language }),
    spawnImpl,
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs: timeout,
    label: "stt",
    onSpawn: (proc) => proc.stdin?.end(buffer ?? Buffer.alloc(0)),
  });
  if (code === 0) return stdout.toString().trim();
  throw new Error(`stt exited ${code}: ${stderr.toString().trim() || "no stderr"}`);
}

/// Wrap raw PCM (default s16le / 24 kHz / mono, the local-vad capture format) in
/// a minimal 44-byte WAV container so it can be uploaded as one audio file.
/// Pure; returns a Buffer. (bd-adde03)
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
  const blockAlign = channels * (bitsPerSample >> 3);
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // audio format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/// Build the OpenAI-compatible one-shot transcription URL from a base URL,
/// normalizing the /v1 suffix (OPENAI_BASE_URL may or may not include it).
/// Pure. (bd-adde03)
export function resolveTranscriptionUrl(baseUrl) {
  let b = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!b) return "";
  if (!/\/v1$/.test(b)) b += "/v1";
  return `${b}/audio/transcriptions`;
}

/// One-shot transcription of a COMPLETE VAD turn (bd-adde03): wrap the committed
/// PCM buffer as WAV and POST it as a single multipart file to
/// <baseUrl>/v1/audio/transcriptions (OpenAI-compatible), returning the trimmed
/// transcript. This is the first-party replacement for the opaque `stt --stdin`
/// subprocess: local-vad already segmented the whole turn, so a one-shot HTTP
/// call we fully control (AbortController timeout, explicit errors) is correct
/// and cannot hang "transcribing" forever. The api key travels only in the
/// Authorization header and is never logged. fetch/FormData/Blob injectable for
/// tests.
export async function transcribeAudioDirect({
  pcm,
  wav,
  model = DEFAULT_STT_BATCH_MODEL,
  baseUrl,
  apiKey,
  language,
  timeoutMs,
  fetchImpl = fetch,
  FormDataImpl = FormData,
  BlobImpl = Blob,
} = {}) {
  const url = resolveTranscriptionUrl(baseUrl);
  if (!url) throw new Error("transcribe: no base URL (set OPENAI_BASE_URL / PI_RT_BASE_URL)");
  const key = String(apiKey || "").trim();
  const audio = wav ?? pcmToWav(pcm);
  const timeout = timeoutMs == null ? resolveBatchSttTimeoutMs() : Number(timeoutMs);

  const form = new FormDataImpl();
  form.append("file", new BlobImpl([audio], { type: "audio/wav" }), "audio.wav");
  form.append("model", String(model));
  form.append("response_format", "json");
  if (language) form.append("language", String(language));

  const controller = Number.isFinite(timeout) && timeout > 0 ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeout) : null;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: form,
      signal: controller?.signal,
    });
  } catch (err) {
    if (controller?.signal?.aborted) throw new Error(`transcribe timed out after ${timeout}ms`);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res?.ok) {
    const body = await res?.text?.().catch?.(() => "") ?? "";
    throw new Error(`transcribe HTTP ${res?.status ?? "?"}: ${String(body).slice(0, 200) || "no body"}`);
  }
  const ct = String(res.headers?.get?.("content-type") || "");
  if (ct.includes("application/json") || ct === "") {
    const j = await res.json();
    return String(j?.text ?? "").trim();
  }
  return String(await res.text()).trim();
}
