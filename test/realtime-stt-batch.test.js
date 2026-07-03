import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  buildSttBatchArgs,
  transcribePcmBuffer,
  resolveBatchSttModel,
  DEFAULT_STT_BATCH_MODEL,
  resolveBatchSttTimeoutMs,
  DEFAULT_STT_BATCH_TIMEOUT_MS,
  pcmToWav,
  resolveTranscriptionUrl,
  transcribeAudioDirect,
} from "../extensions/lib/realtime-stt-batch.js";

test("resolveBatchSttModel reads PI_RT_LOCAL_VAD_MODEL or the batch default, decoupled from the realtime model (bd-84bbf7)", () => {
  assert.equal(resolveBatchSttModel({}), DEFAULT_STT_BATCH_MODEL);
  assert.equal(resolveBatchSttModel({ PI_RT_LOCAL_VAD_MODEL: "custom-batch-1" }), "custom-batch-1");
  assert.equal(resolveBatchSttModel({ PI_RT_LOCAL_VAD_MODEL: "  spaced  " }), "spaced");
  assert.equal(resolveBatchSttModel({ PI_RT_LOCAL_VAD_MODEL: "   " }), DEFAULT_STT_BATCH_MODEL);
  assert.equal(resolveBatchSttModel({ PI_RT_LOCAL_VAD_MODEL: "" }), DEFAULT_STT_BATCH_MODEL);
});

test("buildSttBatchArgs builds stdin/model argv with optional language (bd-9399e7)", () => {
  assert.deepEqual(buildSttBatchArgs(), ["--stdin", "--transcription-model", DEFAULT_STT_BATCH_MODEL]);
  assert.deepEqual(buildSttBatchArgs({ model: "m2" }), ["--stdin", "--transcription-model", "m2"]);
  assert.deepEqual(buildSttBatchArgs({ model: "m2", language: "en" }), [
    "--stdin",
    "--transcription-model",
    "m2",
    "--language",
    "en",
  ]);
});

// A fake `stt` subprocess: wires up as an EventEmitter and emits stdout/stderr +
// close on the next microtask (after transcribePcmBuffer has attached listeners).
function fakeStt({ exitCode = 0, stdout = "", stderr = "", throwOnSpawn = false } = {}) {
  const calls = { command: null, args: null, stdinChunks: [] };
  const spawnImpl = (command, args) => {
    if (throwOnSpawn) throw new Error("spawn ENOENT");
    calls.command = command;
    calls.args = args;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { end: (buf) => calls.stdinChunks.push(buf) };
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    });
    return proc;
  };
  return { spawnImpl, calls };
}

test("transcribePcmBuffer resolves with the trimmed transcript and pipes the buffer (bd-9399e7)", async () => {
  const { spawnImpl, calls } = fakeStt({ stdout: "  hello world \n" });
  const text = await transcribePcmBuffer(Buffer.from([1, 2, 3, 4]), { model: "m2", spawnImpl });
  assert.equal(text, "hello world");
  assert.equal(calls.command, "stt");
  assert.deepEqual(calls.args, ["--stdin", "--transcription-model", "m2"]);
  assert.equal(calls.stdinChunks.length, 1);
  assert.ok(Buffer.isBuffer(calls.stdinChunks[0]));
});

test("transcribePcmBuffer rejects on a non-zero exit, carrying stderr (bd-9399e7)", async () => {
  const { spawnImpl } = fakeStt({ exitCode: 2, stderr: "model not found" });
  await assert.rejects(
    transcribePcmBuffer(Buffer.alloc(0), { spawnImpl }),
    /stt exited 2: model not found/,
  );
});

test("transcribePcmBuffer rejects when spawn itself throws (bd-9399e7)", async () => {
  const { spawnImpl } = fakeStt({ throwOnSpawn: true });
  await assert.rejects(transcribePcmBuffer(Buffer.alloc(0), { spawnImpl }), /spawn ENOENT/);
});

// --- bd-adde03: batch stt timeout + direct one-shot HTTP transcription ---

test("resolveBatchSttTimeoutMs reads PI_RT_LOCAL_VAD_TIMEOUT_MS, else default; 0 disables (bd-adde03)", () => {
  assert.equal(resolveBatchSttTimeoutMs({}), DEFAULT_STT_BATCH_TIMEOUT_MS);
  assert.equal(resolveBatchSttTimeoutMs({ PI_RT_LOCAL_VAD_TIMEOUT_MS: "5000" }), 5000);
  assert.equal(resolveBatchSttTimeoutMs({ PI_RT_LOCAL_VAD_TIMEOUT_MS: "0" }), 0);
  assert.equal(resolveBatchSttTimeoutMs({ PI_RT_LOCAL_VAD_TIMEOUT_MS: "-1" }), DEFAULT_STT_BATCH_TIMEOUT_MS);
  assert.equal(resolveBatchSttTimeoutMs({ PI_RT_LOCAL_VAD_TIMEOUT_MS: "abc" }), DEFAULT_STT_BATCH_TIMEOUT_MS);
});

test("transcribePcmBuffer times out + kills a stalled subprocess instead of hanging (bd-adde03)", async () => {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end() {} };
  let killed = null;
  proc.kill = (sig) => { killed = sig; };
  const spawnImpl = () => proc; // never emits "close" -> would hang without the timeout
  await assert.rejects(
    transcribePcmBuffer(Buffer.from([0]), { spawnImpl, timeoutMs: 20 }),
    /stt timed out after 20ms/,
  );
  assert.equal(killed, "SIGTERM");
});

test("pcmToWav wraps PCM in a valid 44-byte WAV header (bd-adde03)", () => {
  const pcm = Buffer.from([1, 2, 3, 4]);
  const wav = pcmToWav(pcm, { sampleRate: 24000, channels: 1, bitsPerSample: 16 });
  assert.equal(wav.length, 44 + 4);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.toString("ascii", 12, 16), "fmt ");
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(4), 36 + 4); // RIFF chunk size
  assert.equal(wav.readUInt16LE(20), 1); // PCM
  assert.equal(wav.readUInt16LE(22), 1); // channels
  assert.equal(wav.readUInt32LE(24), 24000); // sample rate
  assert.equal(wav.readUInt16LE(34), 16); // bits per sample
  assert.equal(wav.readUInt32LE(40), 4); // data size
  assert.deepEqual(wav.subarray(44), pcm);
});

test("resolveTranscriptionUrl normalizes the /v1 suffix (bd-adde03)", () => {
  assert.equal(resolveTranscriptionUrl("http://p:4000"), "http://p:4000/v1/audio/transcriptions");
  assert.equal(resolveTranscriptionUrl("http://p:4000/"), "http://p:4000/v1/audio/transcriptions");
  assert.equal(resolveTranscriptionUrl("http://p:4000/v1"), "http://p:4000/v1/audio/transcriptions");
  assert.equal(resolveTranscriptionUrl("http://p:4000/v1/"), "http://p:4000/v1/audio/transcriptions");
  assert.equal(resolveTranscriptionUrl(""), "");
});

function fakeRes({ ok = true, status = 200, json, text, contentType = "application/json" } = {}) {
  return {
    ok,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? contentType : null) },
    json: async () => json,
    text: async () => (text != null ? text : JSON.stringify(json)),
  };
}

test("transcribeAudioDirect POSTs one WAV to /v1/audio/transcriptions and returns {text} (bd-adde03)", async () => {
  let captured;
  const fetchImpl = async (url, opts) => { captured = { url, opts }; return fakeRes({ json: { text: "  hello world " } }); };
  const out = await transcribeAudioDirect({
    pcm: Buffer.from([1, 2, 3, 4]),
    model: "mai-transcribe-1.5",
    baseUrl: "http://proxy:4000",
    apiKey: "sk-xyz",
    fetchImpl,
  });
  assert.equal(out, "hello world");
  assert.equal(captured.url, "http://proxy:4000/v1/audio/transcriptions");
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers.Authorization, "Bearer sk-xyz");
  assert.ok(captured.opts.body instanceof FormData, "body is multipart FormData");
});

test("transcribeAudioDirect throws on a non-2xx response (bd-adde03)", async () => {
  const fetchImpl = async () => fakeRes({ ok: false, status: 500, text: "boom", contentType: "text/plain" });
  await assert.rejects(
    transcribeAudioDirect({ pcm: Buffer.from([0]), baseUrl: "http://p:1", apiKey: "k", fetchImpl }),
    /transcribe HTTP 500: boom/,
  );
});

test("transcribeAudioDirect aborts + throws a clear error on timeout (bd-adde03)", async () => {
  const fetchImpl = (_url, opts) => new Promise((_resolve, reject) => {
    opts.signal?.addEventListener?.("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(
    transcribeAudioDirect({ pcm: Buffer.from([0]), baseUrl: "http://p:1", apiKey: "k", timeoutMs: 20, fetchImpl }),
    /transcribe timed out after 20ms/,
  );
});

test("transcribeAudioDirect throws when no base URL is configured (bd-adde03)", async () => {
  await assert.rejects(
    transcribeAudioDirect({ pcm: Buffer.from([0]), baseUrl: "", apiKey: "k", fetchImpl: async () => fakeRes({ json: { text: "x" } }) }),
    /no base URL/,
  );
});
