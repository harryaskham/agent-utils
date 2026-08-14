import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TTS_PROVIDER,
  DEFAULT_TTS_VOICE,
  DEFAULT_TTS_LANG,
  DEFAULT_TTS_SPEED,
  DEFAULT_TTS_EMBEDDING,
  DEFAULT_AZURE_SPEECH_ENDPOINT,
  speedToProsodyRate,
  buildAzureSpeechSsml,
  resolveAzureSpeechCreds,
  resolveSpeakToolParams,
  cascadeSpeechEnabled,
  synthesizeAzureSpeechDirect,
  synthesizeSpeechDirect,
  buildPcmPlaybackSpec,
  createInterruptiblePcmPlayer,
} from "../extensions/lib/tts.js";

const okFetch = (bytes = [1, 2, 3, 4]) => async () => ({
  ok: true,
  status: 200,
  async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
});

test("shared TTS defaults match /read voice specification", () => {
  assert.equal(DEFAULT_TTS_PROVIDER, "azure");
  assert.equal(DEFAULT_TTS_VOICE, "MAI-Voice-2");
  assert.equal(DEFAULT_TTS_LANG, "en-GB");
  assert.equal(DEFAULT_TTS_SPEED, 2);
  assert.equal(DEFAULT_TTS_EMBEDDING, "0daec43c-911f-4529-820a-16dab73630d3");
});

test("speedToProsodyRate preserves fractional percentages and explicit unity", () => {
  assert.equal(speedToProsodyRate(1.6), "+60.00%");
  assert.equal(speedToProsodyRate(2), "+100.00%");
  assert.equal(speedToProsodyRate(0.8), "-20.00%");
  assert.equal(speedToProsodyRate(1), "+0.00%");
  assert.equal(speedToProsodyRate(null), undefined);
});

test("Azure SSML respects the supplied MAI voice and emits style, embedding, lang, and prosody", () => {
  const ssml = buildAzureSpeechSsml({
    text: "Synchronizing <Caravan> & caravans!",
    voice: "MAI-Voice-2",
    lang: "en-GB",
    speed: 1.6,
    style: "hopeful",
    styleDegree: 1.53,
    embedding: "0daec43c-911f-4529-820a-16dab73630d3",
  });
  assert.match(ssml, /^<speak version='1.0'.* xml:lang='en-GB'>/);
  assert.match(ssml, /<voice name='MAI-Voice-2'>/);
  assert.doesNotMatch(ssml, /DragonLatestNeural|PhoenixLatestNeural/);
  assert.match(ssml, /<mstts:ttsembedding speakerProfileId='0daec43c-911f-4529-820a-16dab73630d3'>/);
  assert.match(ssml, /<lang xml:lang='en-GB'>/);
  assert.match(ssml, /<mstts:express-as style='hopeful' styledegree='1.53'>/);
  assert.match(ssml, /<prosody rate='\+60\.00%'>/);
  assert.match(ssml, /Synchronizing &lt;Caravan&gt; &amp; caravans!/);
});

test("Azure SSML omits wrappers only when their settings are unset", () => {
  const ssml = buildAzureSpeechSsml({
    text: "plain",
    voice: "MAI-Voice-2",
    lang: null,
    speed: null,
    style: null,
    embedding: null,
  });
  assert.doesNotMatch(ssml, /ttsembedding|express-as|prosody|<lang /);
  assert.match(ssml, /<voice name='MAI-Voice-2'>plain<\/voice>/);
});

test("styledegree is validated and ignored without style", () => {
  assert.doesNotThrow(() => buildAzureSpeechSsml({ text: "x", styleDegree: 99 }));
  assert.throws(() => buildAzureSpeechSsml({ text: "x", style: "hopeful", styleDegree: 2.1 }), /between 0.01 and 2/);
});

test("credential and speak resolution use env then shared defaults", () => {
  assert.deepEqual(resolveAzureSpeechCreds({ env: {} }), { endpoint: DEFAULT_AZURE_SPEECH_ENDPOINT, apiKey: "" });
  assert.deepEqual(
    resolveAzureSpeechCreds({ env: { AZURE_SPEECH_ENDPOINT: "https://example.test/", AZURE_SPEECH_API_KEY: "secret" } }),
    { endpoint: "https://example.test", apiKey: "secret" },
  );
  assert.deepEqual(resolveSpeakToolParams({ text: " hi " }, { env: {} }), {
    text: "hi",
    voice: DEFAULT_TTS_VOICE,
    speakerProfileId: DEFAULT_TTS_EMBEDDING,
    lang: DEFAULT_TTS_LANG,
    speed: DEFAULT_TTS_SPEED,
    style: undefined,
    styleDegree: undefined,
  });
  assert.deepEqual(resolveSpeakToolParams({ text: "hi" }, { env: {}, persisted: {
    voice: "PersistedVoice", embedding: "persisted-profile", lang: "cy-GB", speed: 1.4, style: "hopeful", styleDegree: 1.2,
  } }), {
    text: "hi", voice: "PersistedVoice", speakerProfileId: "persisted-profile", lang: "cy-GB", speed: 1.4, style: "hopeful", styleDegree: 1.2,
  });
  assert.equal(resolveSpeakToolParams({ text: "hi", voice: "Explicit" }, { env: { PI_TTS_VOICE: "Env" }, persisted: { voice: "Persisted" } }).voice, "Explicit");
  assert.equal(resolveSpeakToolParams({ text: "hi" }, { env: { PI_TTS_VOICE: "Env" }, persisted: { voice: "Persisted" } }).voice, "Env");
});

test("native Azure synthesis posts SSML directly and returns raw PCM", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return (await okFetch()()) ;
  };
  const pcm = await synthesizeAzureSpeechDirect({
    text: "hello",
    voice: "MAI-Voice-2",
    lang: "en-GB",
    speed: 1.6,
    style: "hopeful",
    styleDegree: 1.53,
    speakerProfileId: "profile",
    endpoint: "https://speech.example/",
    apiKey: "secret",
    fetchImpl,
    env: {},
  });
  assert.deepEqual(pcm, Buffer.from([1, 2, 3, 4]));
  assert.equal(request.url, "https://speech.example/cognitiveservices/v1");
  assert.equal(request.options.headers["Ocp-Apim-Subscription-Key"], "secret");
  assert.equal(request.options.headers["Content-Type"], "application/ssml+xml");
  assert.match(request.options.body, /<voice name='MAI-Voice-2'>/);
  assert.match(request.options.body, /style='hopeful'/);
});

test("native synthesis honors the speech policy and rejects unsupported providers", async () => {
  assert.equal(cascadeSpeechEnabled({ env: { PI_CASCADE_SPEECH_ENABLED: "0" } }), false);
  let fetched = false;
  await assert.rejects(
    synthesizeAzureSpeechDirect({
      text: "silent",
      endpoint: "https://speech.example",
      apiKey: "secret",
      env: { PI_CASCADE_SPEECH_ENABLED: "0" },
      fetchImpl: async () => { fetched = true; return okFetch()(); },
    }),
    /disabled by Cacophony node policy/,
  );
  assert.equal(fetched, false);
  await assert.rejects(synthesizeSpeechDirect("hello", { provider: "openai" }), /unsupported direct provider/);
});

test("native synthesis times out a hung fetch", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  await assert.rejects(
    synthesizeAzureSpeechDirect({ text: "hello", endpoint: "https://speech.example", apiKey: "secret", fetchImpl, timeoutMs: 10, env: {} }),
    /timed out after 10ms/,
  );
});

test("Pulse playback spec is raw PCM, named /read, and uses configured server/device", () => {
  const spec = buildPcmPlaybackSpec({ backend: "pulse", server: "pulse.example:4713", device: "@DEFAULT_SINK@", streamName: "/read", env: {} });
  assert.equal(spec.command, "pacat");
  assert.ok(spec.args.includes("--raw"));
  assert.ok(spec.args.includes("--format=s16le"));
  assert.ok(spec.args.includes("--rate=24000"));
  assert.ok(spec.args.includes("--channels=1"));
  assert.ok(spec.args.includes("--server=pulse.example:4713"));
  assert.ok(spec.args.includes("--device=@DEFAULT_SINK@"));
  assert.ok(spec.args.includes("--client-name=/read"));
  assert.ok(spec.args.includes("--stream-name=/read"));
  const auto = buildPcmPlaybackSpec({ backend: "auto", server: "pulse.example:4713", device: "hw_output", env: {} });
  assert.equal(auto.command, "pacat", "auto resolves to Pulse when Pulse routing is configured");
  assert.ok(auto.args.includes("--server=pulse.example:4713"));
});

function fakePlayerSpawn() {
  const processes = [];
  const spawnImpl = (command, args, options) => {
    const proc = new EventEmitter();
    proc.command = command;
    proc.args = args;
    proc.options = options;
    proc.kills = [];
    proc.stdin = new EventEmitter();
    proc.stdin.chunks = [];
    proc.stdin.write = (chunk) => { proc.stdin.chunks.push(Buffer.from(chunk)); return true; };
    proc.stdin.end = () => {};
    proc.stdin.destroy = () => {};
    proc.stderr = new EventEmitter();
    proc.kill = (signal) => { proc.kills.push(signal); return true; };
    processes.push(proc);
    return proc;
  };
  return { spawnImpl, processes };
}

test("interruptible PCM player kills the previous pacat before starting the next", async () => {
  const { spawnImpl, processes } = fakePlayerSpawn();
  const player = createInterruptiblePcmPlayer({ spawnImpl, killDelayMs: 0 });
  const first = player.play(Buffer.from([1, 2]), { backend: "pulse" });
  assert.equal(processes.length, 1);
  const second = player.play(Buffer.from([3, 4]), { backend: "pulse" });
  assert.deepEqual(processes[0].kills, ["SIGTERM"]);
  assert.deepEqual(await first, { interrupted: true });
  processes[1].emit("close", 0, null);
  assert.equal((await second).interrupted, false);
});

test("the shared native library contains no tts CLI subprocess fallback", () => {
  const source = readFileSync(new URL("../extensions/lib/tts.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /spawn\([^\n]*["']tts["']/);
  const compatibility = readFileSync(new URL("../extensions/lib/realtime-tts-batch.js", import.meta.url), "utf8");
  assert.doesNotMatch(compatibility, /synthesizeToPcm|buildTtsBatchArgs/);
});
