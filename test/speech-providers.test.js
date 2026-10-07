import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { daemonUrl, daemonToken, requestDaemonTts, daemonTtsRequest, transcribeDaemonAudio } from "../extensions/lib/speech-daemon.js";
import { buildOpenAiSpeechRequest, synthesizeOpenAiSpeech } from "../extensions/lib/tts-openai.js";
import { synthesizeSpeechDirect, buildPcmPlaybackSpec } from "../extensions/lib/tts.js";
import { defaultReadConfig, applyReadConfigValues, createReadModeController } from "../extensions/read-aloud.js";
import { resolveAgentTtsSettings, createAgentSpeechController } from "../extensions/lib/tts-narration.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { makeCascadeTtsSynth, makeCascadePlay } from "../extensions/lib/realtime-cascade-session.js";
import { resolveSttSettings, transcribeSpeech } from "../extensions/lib/stt-provider.js";
import { DaemonSttSocket } from "../extensions/lib/stt-daemon-stream.js";
import { pcmToWav } from "../extensions/lib/realtime-stt-batch.js";
import { speechHttp } from "../extensions/lib/speech-http.js";

const pcm = Buffer.from([0, 0, 1, 0]);
const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const daemonFetch = (run, capabilities = []) => (url, init) => url.endsWith("/health") ? Promise.resolve(json({ capabilities })) : run(url, init);
const receipt = (request, patch = {}) => ({ status: "ok", job: { id: request.request_id, state: "completed", raw: request.raw, format: "pcm", audio_bytes: pcm.length, audio_path: `/snapshot/audio/${request.request_id}`, ...patch } });
const waitFor = async (predicate) => { const end = Date.now() + 3000; while (!predicate()) { assert.ok(Date.now() < end, "settlement timeout"); await new Promise(r => setTimeout(r, 5)); } };

async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "agent-speech-provider-"));
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    let body;
    try { body = JSON.parse(bytes); } catch {}
    if (req.url === "/health") { respond(res, { capabilities: [] }); return; }
    requests.push({ path: req.url, authorization: req.headers.authorization, body, bytes });
    try { await handler(requests.at(-1), res); }
    catch { res.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, requests, url: `http://127.0.0.1:${server.address().port}`, env: { HOME: root, TTS_DAEMON_TOKEN: "fixture-tts-token", STT_DAEMON_TOKEN: "fixture-stt-token", PI_TTS_MUTE_PATH: join(root, "mute.json") } };
}
const respond = (res, value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };

test("provider switching uses provider defaults, preserves explicit controls and never inherits Azure credentials", () => {
  const azure = defaultReadConfig({ AZURE_SPEECH_ENDPOINT: "https://azure.invalid" });
  const openai = applyReadConfigValues(azure, { provider: "openai", model: "custom-tts", voice: "custom-voice", style: "cheerful" }, {});
  assert.equal(openai.embedding, null);
  assert.equal(openai.speed, 1);
  assert.equal(openai.endpoint, undefined);
  assert.equal(openai.model, "custom-tts");
  const daemon = applyReadConfigValues(openai, { provider: "daemon", daemon_url: "helsinki", playback: "local" }, {});
  assert.equal(daemon.voice, undefined);
  assert.equal(daemon.model, undefined);
  assert.equal(daemon.daemonUrl, "helsinki");
  assert.equal(daemon.playback, "local");
  const configured = resolveAgentTtsSettings({ env: { PI_TTS_PROVIDER: "openai", OPENAI_TTS_MODEL: "chosen", AZURE_SPEECH_ENDPOINT: "https://wrong.invalid" }, persisted: {} }).config;
  assert.equal(configured.model, "chosen");
  assert.equal(configured.endpoint, undefined);
  assert.equal(configured.voice, "alloy");
  for (const provider of ["openai", "daemon"]) {
    const switched = defaultReadConfig({ PI_TTS_PROVIDER: provider }, { provider: "azure", voice: "azure-only", embedding: "azure-profile", endpoint: "https://azure.invalid" });
    assert.equal(switched.endpoint, undefined);
    assert.ok(!switched.embedding);
    assert.notEqual(switched.voice, "azure-only");
    const stt = resolveSttSettings({ PI_STT_PROVIDER: provider }, { provider: "azure", endpoint: "https://azure.invalid", model: "azure-deployment" });
    assert.equal(stt.endpoint, undefined);
    assert.notEqual(stt.model, "azure-deployment");
  }
  assert.equal(resolveSttSettings({ PI_STT_PROVIDER: "daemon" }).model, undefined);
  assert.equal(resolveSttSettings({ PI_STT_PROVIDER: "openai" }).model, "gpt-4o-mini-transcribe");
});

test("OpenAI request maps expressive controls without SSML and rejects unsupported embedding/model controls", () => {
  const request = buildOpenAiSpeechRequest("Hello <world>", { env: {}, voice: "custom", model: "custom-tts", speed: 1.4, lang: "en-GB", style: "cheerful", styleDegree: 1.2, instructions: "Speak calmly.", role: "a pirate", pitch: -5, volume: 70 });
  assert.equal(request.input, "Hello <world>");
  assert.equal(request.response_format, "pcm");
  assert.match(request.instructions, /Speak calmly.*en-GB.*cheerful.*1.2.*pirate.*5% lower.*70%/);
  assert.equal(request.speed, 1.4);
  assert.throws(() => buildOpenAiSpeechRequest("hi", { embedding: "profile" }), /embeddings/);
  assert.throws(() => buildOpenAiSpeechRequest("hi", { model: "tts-1", style: "cheerful" }), /does not support instructions/);
  assert.throws(() => buildOpenAiSpeechRequest("hi", { speed: 0 }), /speed/);
});

test("OpenAI native HTTP preserves prefix, returns PCM, sends auth only as a header and refuses redirects", async (t) => {
  const f = await fixture(t, (request, res) => {
    if (request.path === "/redirect/v1/audio/speech") { res.writeHead(302, { location: "/stolen" }).end(); return; }
    res.setHeader("Content-Type", "application/octet-stream"); res.end(pcm);
  });
  const options = { env: { OPENAI_API_KEY: "fixture-key" }, endpoint: `${f.url}/proxy/v1/audio/speech` };
  assert.deepEqual(await synthesizeSpeechDirect("hello", { ...options, provider: "openai" }), pcm);
  assert.equal(f.requests[0].path, "/proxy/v1/audio/speech");
  assert.equal(f.requests[0].authorization, "Bearer fixture-key");
  assert.equal(f.requests[0].body.voice, "alloy");
  assert.ok(!JSON.stringify(f.requests[0].body).includes("fixture-key"));
  await assert.rejects(synthesizeOpenAiSpeech("hello", { ...options, endpoint: `${f.url}/redirect` }), /request failed/);
  assert.equal(f.requests.length, 2);
});

test("daemon tokens honor env aliases, managed symlinks and on-disk rotation without exposing secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "speech-token-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "managed"); const tokenFile = join(root, "token");
  await writeFile(target, "first-token\n"); await symlink(target, tokenFile);
  assert.equal(await daemonToken("tts", { env: {}, tokenFile }), "first-token");
  await writeFile(target, "rotated-token\n");
  assert.equal(await daemonToken("tts", { env: {}, tokenFile }), "rotated-token");
  assert.equal(await daemonToken("tts", { env: { TTS_DAEMON_TOKEN: "canonical", TTS_DAMEON_TOKEN: "alias" }, tokenFile }), "canonical");
  assert.equal(await daemonToken("stt", { env: { STT_DAMEON_TOKEN: "alias" }, tokenFile }), "alias");
  await writeFile(target, "a\nb");
  await assert.rejects(daemonToken("tts", { env: {}, tokenFile }), /invalid bearer token/);
  assert.equal(daemonUrl("tts", { daemonUrl: "helsinki" }), "http://helsinki:7633");
  assert.equal(daemonUrl("stt", { daemonUrl: "[::1]" }), "http://[::1]:7634");
  assert.equal(daemonUrl("tts", { daemonUrl: "host:80" }), "http://host");
  assert.throws(() => daemonUrl("tts", { daemonUrl: "https://user:password@host" }), /without credentials/);
});

test("daemon TTS submits once, polls to settlement, rotates tokens and downloads only exact bounded PCM", async (t) => {
  let request; let tokenPath;
  const f = await fixture(t, async (row, res) => {
    if (row.path.startsWith("/snapshot/audio/")) { res.end(pcm); return; }
    if (row.body.operation === "tts") {
      request = row.body.input;
      await writeFile(tokenPath, "rotated");
      respond(res, receipt(request, { state: "queued" }));
    } else respond(res, receipt(request));
  });
  tokenPath = join(f.root, "token"); await writeFile(tokenPath, "initial");
  const result = await requestDaemonTts("test body", { env: {}, tokenFile: tokenPath, daemonUrl: f.url, requestId: "job-1", daemonProvider: "azure", voice: "MAI-Voice-2.1-Flash", embedding: "profile", style: "hopeful", styleDegree: 1.2, speed: 2 }, { raw: true });
  assert.deepEqual(result.pcm, pcm);
  assert.equal(request.provider, "azure");
  assert.equal(request.styledegree, 1.2);
  assert.equal(request.embedding, "profile");
  assert.equal(f.requests.filter(r => r.body?.operation === "tts").length, 1);
  assert.equal(f.requests[0].authorization, "Bearer initial");
  assert.ok(f.requests.slice(1).every(r => r.authorization === "Bearer rotated"));
  assert.ok(f.requests.some(r => r.body?.operation === "tts.release"));
});

test("daemon server playback has no raw download, ambient Pulse routing or automatic local fallback", async (t) => {
  const f = await fixture(t, (row, res) => respond(res, receipt(row.body.input)));
  const result = await requestDaemonTts("server output", { env: { ...f.env, PULSE_SERVER: "client-pulse", PULSE_SINK: "client-sink" }, daemonUrl: f.url, daemonSink: "server-sink", streamName: "/tts" });
  assert.equal(result.job.raw, false);
  assert.equal(result.pcm, undefined);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.input.sink, "server-sink");
  assert.equal(f.requests[0].body.input.name, "/tts");
  assert.ok(!JSON.stringify(f.requests[0].body).includes("client-"));
  assert.ok(!Object.hasOwn(daemonTtsRequest("x", {}), "voice"));
});

test("daemon rejects receipt/path confusion and reports indeterminate admission without replay or global mute", async () => {
  let calls = 0;
  const options = { env: { TTS_DAEMON_TOKEN: "fixture" }, daemonUrl: "http://fixture.invalid", requestId: "job-1" };
  await assert.rejects(requestDaemonTts("private", { ...options, fetchImpl: daemonFetch(async () => { calls++; throw new Error("secret URL/body"); }) }), /tts job job-1; remote work may still continue; no automatic resubmission/);
  assert.equal(calls, 1);
  await assert.rejects(requestDaemonTts("private", { ...options, fetchImpl: daemonFetch(async () => json(receipt({ request_id: "wrong", raw: false }))) }), /mismatched TTS receipt/);
  await assert.rejects(requestDaemonTts("private", { ...options, fetchImpl: daemonFetch(async () => json(receipt({ request_id: "job-1", raw: true }, { audio_path: "http://evil/token" }))) }, { raw: true }), /invalid audio receipt/);
  const abort = new AbortController();
  const operations = [];
  const pending = requestDaemonTts("private", { ...options, signal: abort.signal, fetchImpl: daemonFetch(async (_url, init) => { const { operation, input } = JSON.parse(init.body); operations.push(operation); queueMicrotask(() => abort.abort()); return json(receipt(input, { state: "queued" })); }) });
  await assert.rejects(pending, /wait aborted.*cancellation:unsupported.*remote work may still continue/);
  assert.deepEqual(operations, ["tts"]);
});

test("HTTP timeout covers body consumption, error text is redacted and response bytes are bounded", async (t) => {
  const f = await fixture(t, (row, res) => {
    if (row.path === "/error") { res.writeHead(500); res.end("secret body"); }
    else { res.writeHead(200, { "content-type": "application/octet-stream" }); res.write(pcm); }
  });
  await assert.rejects(speechHttp(`${f.url}/stall`, { timeoutMs: 25 }), /timed out after 25ms/);
  await assert.rejects(speechHttp(`${f.url}/error`), /HTTP 500; response body omitted/);
  await assert.rejects(speechHttp("http://fixture.invalid", { maxBytes: 1, fetchImpl: async () => new Response(pcm) }), /exceeds size limit/);
});

test("all TTS controllers forward native OpenAI options without Azure session voice overrides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "speech-surfaces-")); t.after(() => rm(root, { recursive: true, force: true }));
  const env = { HOME: root, PI_TTS_PROVIDER: "openai", PI_TTS_MODEL: "model-x", PI_TTS_VOICE: "voice-x", PI_TTS_INSTRUCTIONS: "Calm." };
  const seen = []; const played = [];
  const synthesize = async (_text, options) => { seen.push(options); return pcm; };
  const player = { play: async (bytes) => { played.push(bytes); }, interrupt() {}, dispose() {} };
  const read = createReadModeController({ env, synthesize, player });
  const agent = createAgentSpeechController({ env, synthesize, player });
  const choices = createChoiceSpeaker({ env, synthesize, player });
  choices.assignSession({ sessionManager: { getSessionId: () => "fixture-session" } });
  await read.speak("read"); await agent.speak("reply"); await agent.speak("summary", { speechKind: "narrate" });
  await choices.speak("choose");
  assert.equal(seen.length, 4); assert.equal(played.length, 4);
  for (const options of seen) {
    assert.equal(options.provider, "openai"); assert.equal(options.voice, "voice-x");
    assert.equal(options.model, "model-x"); assert.equal(options.instructions, "Calm.");
    assert.ok(!options.speakerProfileId);
  }
  read.dispose(); agent.dispose(); choices.dispose();
});

test("cascade defers daemon admission to ordered playback and keeps chat URLs out of TTS", async () => {
  const calls = [];
  const synth = makeCascadeTtsSynth({ env: { PI_TTS_PROVIDER: "daemon", TTS_DAEMON_TOKEN: "fixture" }, fetchImpl: daemonFetch(async (url, init) => { const call = JSON.parse(init.body); calls.push({ url, ...call }); return json(receipt(call.input)); }) });
  const audio = await synth("hello", { provider: "daemon", baseUrl: "https://chat.invalid", daemonUrl: "http://fixture.invalid", voice: "embedding:default" });
  assert.equal(calls.length, 0);
  await makeCascadePlay({ playImpl: () => assert.fail("no local playback") })({}, audio);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, "http://fixture.invalid/command");
  assert.ok(!Object.hasOwn(calls[0].input, "voice"));
});

test("STT daemon and OpenAI paths send complete WAV and all supported options without CLI or credential leakage", async (t) => {
  const f = await fixture(t, (row, res) => respond(res, row.body?.operation === "stt.transcribe" ? { status: "transcript", transcript: { text: " daemon transcript " } } : { text: " openai transcript " }));
  const daemon = await transcribeSpeech(pcm, { provider: "daemon", env: f.env, daemonUrl: f.url, language: "en", prompt: "Vocabulary", daemonProvider: "openai" });
  assert.equal(daemon, "daemon transcript");
  const input = f.requests[0].body.input;
  assert.equal(input.provider, "openai"); assert.equal(input.prompt, "Vocabulary"); assert.equal(input.language, "en");
  assert.equal(Buffer.from(input.audio_base64, "base64").subarray(0, 4).toString(), "RIFF");
  assert.ok(!Object.hasOwn(input, "model"));
  const openai = await transcribeSpeech(pcm, { provider: "openai", env: { OPENAI_API_KEY: "fixture" }, endpoint: `${f.url}/prefix/v1/audio/transcriptions`, model: "model-x", language: "en", prompt: "Vocabulary" });
  assert.equal(openai, "openai transcript");
  assert.equal(f.requests[1].path, "/prefix/v1/audio/transcriptions");
  assert.match(f.requests[1].bytes.toString(), /name="prompt"\r\n\r\nVocabulary/);
  assert.deepEqual(await transcribeDaemonAudio(pcmToWav(pcm), { env: f.env, daemonUrl: f.url }), "daemon transcript");
});

test("daemon STT stream deduplicates event cursors, serializes appends, closes and aborts owned sessions", async () => {
  const calls = []; let opened = 0;
  const fetchImpl = async (_url, init) => {
    const call = JSON.parse(init.body); calls.push(call);
    const { operation, input } = call;
    if (operation === "stt.stream.events") return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), { once: true }));
    if (operation === "stt.stream.open") return json({ status: "stream", session: `session-${++opened}`, provider: "openai", model: "test", rate: 24000, events: [], closed: false });
    if (operation === "stt.stream.abort") return json({ status: "stream", session: input.session, events: [], closed: true });
    const events = [{ seq: 1, event: { type: "committed", item: "item-1" } }, { seq: 2, event: { type: "completed", item: "item-1", text: "hello" } }];
    return json({ status: "stream", session: input.session, events, closed: operation === "stt.stream.close" });
  };
  const socket = new DaemonSttSocket({ env: { STT_DAEMON_TOKEN: "fixture" }, daemonUrl: "http://fixture.invalid", fetchImpl });
  const messages = []; socket.on("message", line => messages.push(JSON.parse(line))); socket.on("error", error => assert.fail(error.message));
  await socket.openStream();
  socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  await socket.chain;
  assert.equal(messages.filter(m => m.type.endsWith("completed")).length, 1);
  assert.equal(socket.queueBytes, 0);
  assert.equal(calls.filter(c => c.operation === "stt.stream.append").length, 2);
  socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  await socket.chain;
  await socket.close();
  assert.equal(socket.readyState, 3);
  assert.ok(calls.some(c => c.operation === "stt.stream.abort" && c.input.session === "session-2"));
});

test("server playback reaches read, narration and choices without any local PCM player", async (t) => {
  const f = await fixture(t, (row, res) => respond(res, receipt(row.body.input)));
  const env = { ...f.env, PI_TTS_PROVIDER: "daemon", PI_TTS_DAEMON_URL: f.url };
  const player = { play: () => assert.fail("unexpected local PCM"), interrupt() {}, dispose() {} };
  const synthesize = () => assert.fail("unexpected raw synthesis");
  const read = createReadModeController({ env, player, synthesize });
  const agent = createAgentSpeechController({ env, player, synthesize });
  const choices = createChoiceSpeaker({ env, player, synthesize });
  try {
    await read.speak("read"); await agent.speak("reply");
    await agent.speak("narration", { speechKind: "narrate", streamName: "/narrate" });
    await choices.speak("choice");
    assert.equal(f.requests.length, 4);
    assert.deepEqual(f.requests.map(r => r.body.input.name), ["/read", "/tts", "/narrate", "/choices"]);
    for (const row of f.requests) { assert.equal(row.body.input.raw, false); assert.ok(!Object.hasOwn(row.body.input, "voice")); }
  } finally { read.dispose(); agent.dispose(); choices.dispose(); }
});

test("daemon streaming maps provisional text and releases final transcripts in commit order", () => {
  const socket = new DaemonSttSocket(); socket.session = "fixture";
  const seen = []; socket.on("message", line => seen.push(JSON.parse(line)));
  const events = [
    { type: "committed", item: "a" }, { type: "committed", item: "b" },
    { type: "delta", item: "a", text: "hel" }, { type: "partial", item: "a", text: "lo" },
    { type: "completed", item: "b", text: "second" }, { type: "completed", item: "a", text: "first" },
  ].map((event, i) => ({ seq: i + 1, event }));
  socket.accept({ status: "stream", session: "fixture", events, closed: false });
  assert.equal(seen.find(m => m.type.endsWith("partial")).transcript, "hello");
  assert.deepEqual(seen.filter(m => m.type.endsWith("completed")).map(m => m.transcript), ["first", "second"]);
  socket.accept({ status: "stream", session: "fixture", events, closed: false });
  assert.equal(seen.length, 6);
});

test("a failed daemon append is not replayed; its owned session is aborted", async () => {
  const operations = [];
  const socket = new DaemonSttSocket({ env: { STT_DAEMON_TOKEN: "fixture" }, daemonUrl: "http://fixture.invalid", fetchImpl: async (_url, init) => {
    const { operation } = JSON.parse(init.body); operations.push(operation);
    if (operation === "stt.stream.open") return json({ status: "stream", session: "fixture", rate: 24000, events: [], closed: false });
    if (operation === "stt.stream.append") throw new Error("private transport detail");
    return json({ status: "stream", session: "fixture", events: [], closed: true });
  } });
  const errors = []; socket.on("error", error => errors.push(error.message));
  await socket.openStream();
  const closed = new Promise(resolve => socket.once("close", resolve));
  socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm.toString("base64") }));
  await socket.chain; await closed;
  assert.deepEqual(operations, ["stt.stream.open", "stt.stream.append", "stt.stream.abort"]);
  assert.equal(errors.length, 1); assert.ok(!errors[0].includes("private"));
  assert.equal(socket.readyState, 3);
});

test("RealtimeSession uses the daemon stream and cleans it up without upstream credentials or microphone capture", async (t) => {
  const f = await fixture(t, async (row, res) => {
    const { operation } = row.body;
    const events = operation === "stt.stream.append" ? [
      { seq: 1, event: { type: "committed", item: "one" } }, { seq: 2, event: { type: "completed", item: "one", text: "fixture transcript" } },
    ] : [];
    if (operation === "stt.stream.events") await new Promise(r => setTimeout(r, 10));
    respond(res, { status: "stream", session: "fixture", rate: 24000, provider: "openai", model: "fixture", events, closed: operation === "stt.stream.abort" });
  });
  const changes = { PI_STT_PROVIDER: "daemon", PI_STT_DAEMON_URL: f.url, STT_DAEMON_TOKEN: "fixture-stt-token", PI_CODING_AGENT_DIR: f.root };
  const saved = Object.fromEntries(Object.keys(changes).map(k => [k, process.env[k]]));
  Object.assign(process.env, changes);
  const { __RealtimeSessionForTest } = await import("../extensions/realtime-agent.js");
  const sent = [];
  const session = new __RealtimeSessionForTest({ sendUserMessage: text => sent.push(text) }, { sttOnly: true, desiredListenMode: "ptt", audioEnabled: false, autoReconnect: false });
  try {
    await session.connect({ ui: { notify() {}, setStatus() {} } });
    assert.ok(session.ws instanceof DaemonSttSocket);
    session.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
    await waitFor(() => sent.length);
    assert.deepEqual(sent, ["fixture transcript"]);
    assert.equal(session.mic, null);
  } finally {
    await session.close(false);
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert.ok(f.requests.some(r => r.body.operation === "stt.stream.abort"));
});

test("PCM players do not inherit daemon/upstream credentials", () => {
  const spec = buildPcmPlaybackSpec({ env: { TTS_DAEMON_TOKEN: "private", STT_DAMEON_TOKEN: "private", OPENAI_API_KEY: "private", AZURE_SPEECH_API_KEY: "private", PULSE_COOKIE: "routing" } });
  assert.ok(!Object.values(spec.env).includes("private"));
  assert.equal(spec.env.PULSE_COOKIE, "routing");
});
