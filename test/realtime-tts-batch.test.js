import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  AZURE_SPEECH_PROVIDER,
  CASCADE_DEFAULT_VOICE_SENTINEL,
  resolveCascadeTtsVoice,
  buildTtsBatchArgs,
  synthesizeToPcm,
  speedToProsodyRate,
  isAzureSpeechProvider,
  buildAzureSpeechSsml,
  resolveAzureSpeechCreds,
  synthesizeAzureSpeechDirect,
  DEFAULT_AZURE_SPEECH_ENDPOINT,
} from "../extensions/lib/realtime-tts-batch.js";

test("speedToProsodyRate maps speed to azure prosody rate %", () => {
  assert.equal(speedToProsodyRate(1.5), "+50%");
  assert.equal(speedToProsodyRate(2), "+100%");
  assert.equal(speedToProsodyRate(0.8), "-20%");
  assert.equal(speedToProsodyRate(1), undefined);
  assert.equal(speedToProsodyRate(undefined), undefined);
  assert.equal(speedToProsodyRate(0), undefined);
});

test("buildAzureSpeechSsml wraps voice/embedding/lang/prosody and escapes text", () => {
  const s = buildAzureSpeechSsml({ text: "hi <b> & 'x'", voice: "MAI-Voice-2", lang: "en-GB", speed: 1.5, speakerProfileId: "0daec43c" });
  assert.match(s, /^<speak version='1.0' xmlns='[^']+' xmlns:mstts='[^']+' xml:lang='en-GB'>/);
  assert.match(s, /<voice name='MAI-Voice-2' xml:lang='en-GB'>/);
  assert.match(s, /<mstts:ttsembedding speakerProfileId='0daec43c'>/);
  assert.match(s, /<prosody rate='\+50%'>/);
  assert.match(s, /hi &lt;b&gt; &amp; &apos;x&apos;/);
  // omit ttsembedding + prosody when not supplied
  const plain = buildAzureSpeechSsml({ text: "yo", voice: "en-US-Harper:MAI-Voice-2" });
  assert.doesNotMatch(plain, /ttsembedding|prosody/);
  assert.match(plain, /<voice name='en-US-Harper:MAI-Voice-2'>/);
});

test("isAzureSpeechProvider matches azure-speech only", () => {
  assert.equal(isAzureSpeechProvider("azure-speech"), true);
  assert.equal(isAzureSpeechProvider("AZURE-SPEECH"), true);
  assert.equal(isAzureSpeechProvider("openai"), false);
  assert.equal(isAzureSpeechProvider(undefined), false);
});

test("buildTtsBatchArgs emits SSML body for azure-speech (no --speed) and plain text otherwise", () => {
  const az = buildTtsBatchArgs({ text: "hello", voice: "MAI-Voice-2", model: "azure/speech/azure-tts", provider: "azure-speech", speed: 1.5, speakerProfileId: "abc", lang: "en-GB" });
  assert.equal(az[az.length - 2], "--");
  assert.match(az[az.length - 1], /mstts:ttsembedding speakerProfileId='abc'/);
  assert.ok(!az.includes("--speed"), "azure prosody carries speed, not --speed");
  const plain = buildTtsBatchArgs({ text: "hello", voice: "alloy", speed: 1.5 });
  assert.equal(plain[plain.length - 1], "hello");
  assert.ok(plain.includes("--speed"));
});

// ---------------------------------------------------------------------------
// resolveCascadeTtsVoice
// ---------------------------------------------------------------------------

test("resolveCascadeTtsVoice maps the sentinel/empty to undefined and passes explicit voices", () => {
  assert.equal(resolveCascadeTtsVoice(CASCADE_DEFAULT_VOICE_SENTINEL), undefined);
  assert.equal(resolveCascadeTtsVoice(""), undefined);
  assert.equal(resolveCascadeTtsVoice("   "), undefined);
  assert.equal(resolveCascadeTtsVoice(null), undefined);
  assert.equal(resolveCascadeTtsVoice("en-us-phoebe:MAI-Voice-1"), "en-us-phoebe:MAI-Voice-1");
  assert.equal(resolveCascadeTtsVoice("  cedar  "), "cedar");
});

// ---------------------------------------------------------------------------
// buildTtsBatchArgs
// ---------------------------------------------------------------------------

test("buildTtsBatchArgs defaults to stdout + pcm and forces no provider (inherits caco env defaults)", () => {
  assert.deepEqual(buildTtsBatchArgs(), ["--stdout", "--response-format", "pcm"]);
  // sentinel voice is omitted (provider default voice)
  assert.deepEqual(buildTtsBatchArgs({ voice: CASCADE_DEFAULT_VOICE_SENTINEL }), [
    "--stdout", "--response-format", "pcm",
  ]);
});

test("buildTtsBatchArgs passes text as a positional after -- (leading-dash safe)", () => {
  assert.deepEqual(buildTtsBatchArgs({ text: "hello there" }), [
    "--stdout", "--response-format", "pcm", "--", "hello there",
  ]);
  assert.deepEqual(buildTtsBatchArgs({ text: "-dashy" }), [
    "--stdout", "--response-format", "pcm", "--", "-dashy",
  ]);
});

test("buildTtsBatchArgs threads voice/model/baseUrl/instructions, a non-unity speed, and an explicit provider", () => {
  assert.deepEqual(
    buildTtsBatchArgs({
      text: "be warm",
      voice: "cedar",
      model: "azure/speech/azure-tts",
      provider: "openai",
      baseUrl: "http://x",
      speed: 1.2,
      instructions: "warm tone",
    }),
    [
      "--stdout", "--response-format", "pcm",
      "--voice", "cedar",
      "--model", "azure/speech/azure-tts",
      "--provider", "openai",
      "--base-url", "http://x",
      "--speed", "1.2",
      "--instructions", "warm tone",
      "--", "be warm",
    ],
  );
});

test("buildTtsBatchArgs omits a unity / invalid speed and honours an explicit response format", () => {
  assert.ok(!buildTtsBatchArgs({ speed: 1 }).includes("--speed"));
  assert.ok(!buildTtsBatchArgs({ speed: 0 }).includes("--speed"));
  assert.ok(!buildTtsBatchArgs({ speed: "nope" }).includes("--speed"));
  assert.deepEqual(buildTtsBatchArgs({ responseFormat: "wav" }), ["--stdout", "--response-format", "wav"]);
});

// ---------------------------------------------------------------------------
// synthesizeToPcm (injected spawn)
// ---------------------------------------------------------------------------

// A fake `tts` subprocess that emits stdout/stderr + close after listeners attach.
function fakeTts({ exitCode = 0, stdout = null, stderr = "", throwOnSpawn = false } = {}) {
  const calls = { command: null, args: null, opts: null };
  const spawnImpl = (command, args, opts) => {
    if (throwOnSpawn) throw new Error("spawn ENOENT");
    calls.command = command;
    calls.args = args;
    calls.opts = opts;
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    // no stdin: synthesizeToPcm uses positional text, stdin is "ignore"
    queueMicrotask(() => {
      if (stdout) proc.stdout.emit("data", stdout);
      if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
      proc.emit("close", exitCode);
    });
    return proc;
  };
  return { spawnImpl, calls };
}

test("synthesizeToPcm resolves with concatenated PCM and passes text as a positional arg", async () => {
  const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
  const { spawnImpl, calls } = fakeTts({ stdout: pcm });
  const buf = await synthesizeToPcm("hello there", { voice: "cedar", spawnImpl });
  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, pcm);
  assert.equal(calls.command, "tts");
  assert.deepEqual(calls.args, [
    "--stdout", "--response-format", "pcm", "--voice", "cedar", "--", "hello there",
  ]);
  // stdin is not used (ignored) — text rides in argv
  assert.equal(calls.opts.stdio[0], "ignore");
});

test("synthesizeToPcm concatenates multiple stdout chunks", async () => {
  const spawnImpl = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from([1, 2]));
      proc.stdout.emit("data", Buffer.from([3, 4]));
      proc.emit("close", 0);
    });
    return proc;
  };
  const buf = await synthesizeToPcm("hi", { spawnImpl });
  assert.deepEqual(buf, Buffer.from([1, 2, 3, 4]));
});

test("synthesizeToPcm rejects empty text without spawning", async () => {
  let spawned = false;
  const spawnImpl = () => { spawned = true; return new EventEmitter(); };
  await assert.rejects(synthesizeToPcm("   ", { spawnImpl }), /empty text/);
  assert.equal(spawned, false);
});

test("synthesizeToPcm rejects on a non-zero exit, carrying stderr", async () => {
  const { spawnImpl } = fakeTts({ exitCode: 3, stderr: "azure auth failed" });
  await assert.rejects(synthesizeToPcm("hi", { spawnImpl }), /tts exited 3: azure auth failed/);
});

test("synthesizeToPcm rejects when spawn itself throws", async () => {
  const { spawnImpl } = fakeTts({ throwOnSpawn: true });
  await assert.rejects(synthesizeToPcm("hi", { spawnImpl }), /spawn ENOENT/);
});

// --- Direct Azure Speech REST path (azure=true cascade) ---

test("resolveAzureSpeechCreds: endpoint defaults to eastus speech URL, key from env, never hardcoded", () => {
  const a = resolveAzureSpeechCreds({ env: {} });
  assert.equal(a.endpoint, DEFAULT_AZURE_SPEECH_ENDPOINT);
  assert.equal(a.endpoint, "https://eastus.tts.speech.microsoft.com");
  assert.equal(a.apiKey, ""); // no default key
  const b = resolveAzureSpeechCreds({ env: { AZURE_SPEECH_ENDPOINT: "https://westus.tts.speech.microsoft.com/", AZURE_SPEECH_API_KEY: "k1" } });
  assert.equal(b.endpoint, "https://westus.tts.speech.microsoft.com"); // trailing slash trimmed
  assert.equal(b.apiKey, "k1");
});

test("synthesizeAzureSpeechDirect: POSTs mstts SSML to /cognitiveservices/v1 with the subscription-key header and returns PCM", async () => {
  let captured = null;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, async arrayBuffer() { return Uint8Array.from([1, 2, 3, 4]).buffer; } };
  };
  const buf = await synthesizeAzureSpeechDirect({
    text: "hello", voice: "MAI-Voice-2", lang: "en-GB", speed: 1.5,
    speakerProfileId: "abc-123", endpoint: "https://eastus.tts.speech.microsoft.com",
    apiKey: "secret-key", fetchImpl,
  });
  assert.deepEqual(buf, Buffer.from([1, 2, 3, 4]));
  assert.equal(captured.url, "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers["Ocp-Apim-Subscription-Key"], "secret-key");
  assert.equal(captured.opts.headers["Content-Type"], "application/ssml+xml");
  assert.match(captured.opts.headers["X-Microsoft-OutputFormat"], /pcm/);
  // SSML carries the embedding tag + voice + lang + prosody.
  assert.match(captured.opts.body, /<mstts:ttsembedding speakerProfileId='abc-123'>/);
  assert.match(captured.opts.body, /<voice name='MAI-Voice-2'/);
  assert.match(captured.opts.body, /xml:lang='en-GB'/);
  assert.match(captured.opts.body, /<prosody rate='\+50%'>/);
});

test("synthesizeAzureSpeechDirect: rejects on empty text, missing endpoint/key, and non-2xx", async () => {
  const okFetch = async () => ({ ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); } });
  await assert.rejects(synthesizeAzureSpeechDirect({ text: "  ", endpoint: "https://e", apiKey: "k", fetchImpl: okFetch }), /empty text/);
  await assert.rejects(synthesizeAzureSpeechDirect({ text: "hi", endpoint: "", apiKey: "k", fetchImpl: okFetch }), /no endpoint/);
  await assert.rejects(synthesizeAzureSpeechDirect({ text: "hi", endpoint: "https://e", apiKey: "", fetchImpl: okFetch }), /no API key/);
  const badFetch = async () => ({ ok: false, status: 401, async text() { return "Unauthorized"; } });
  await assert.rejects(synthesizeAzureSpeechDirect({ text: "hi", endpoint: "https://e", apiKey: "k", fetchImpl: badFetch }), /azure-speech HTTP 401: Unauthorized/);
});
