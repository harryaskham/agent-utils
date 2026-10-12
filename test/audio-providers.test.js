import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import * as audio from "../extensions/lib/audio-providers.js";
import { maiTranscriptionRoot, transcribeMaiAudioDirect } from "../extensions/lib/realtime-stt-batch.js";
import { transcribeSpeech, resolveSttSettings } from "../extensions/lib/stt-provider.js";
import { synthesizeSpeechDirect } from "../extensions/lib/tts.js";
import { ttsSynthesisOptions } from "../extensions/lib/tts-provider-config.js";
import { applyReadConfigValues, defaultReadConfig, createReadModeController } from "../extensions/read-aloud.js";
import { resolveAgentTtsSettings, createAgentSpeechController } from "../extensions/lib/tts-narration.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { makeCascadeTtsSynth, cascadeRosterFromArgs } from "../extensions/lib/realtime-cascade-session.js";
import audioExtension from "../extensions/audio-providers.js";

const dir = mkdtempSync(path.join(os.tmpdir(), "audio-providers-"));
const settingsPath = path.join(dir, "settings.json");
const beforeEnv = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const scope = {};
const env = { PI_AGENT_UTILS_STATE_DIR: path.join(dir, "state"), PI_INCOGNITO: "1" };
function settings(providers, extra = {}) {
  writeFileSync(settingsPath, JSON.stringify({ agentUtils: { ...(providers ? { audio: { providers } } : {}), ...extra } }));
}
const set = (name, values) => audio.setRuntimeAudioProvider(name, values, scope);
const resolve = (name, options = {}) => audio.resolveAudioConnection(name, { env: {}, ...scope, ...options });
const request = options => ({ ...scope, env, ...options });
const broker = () => ({ calls: [], async getToken(o) { this.calls.push(o.az); return "fixture-token"; }, invalidate() {} });
const pcm = Buffer.alloc(4800);
const named = { "azure-work": { type: "azure", auth: "entra", az: "az-token", endpoint: "https://work.cognitiveservices.azure.com" } };
test.beforeEach(() => { scope.audioProviders = audio.createAudioProviders({ settingsPath }); settings(undefined); });
test.after(() => { if (beforeEnv === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = beforeEnv; rmSync(dir, { recursive: true, force: true }); });

test("unconfigured built-ins preserve legacy options, aliases and auth commands", () => {
  settings(undefined, { tts: { providers: { azure: { auth: "entra", az: "az-token" } } } });
  assert.equal(resolve("azure"), undefined);
  const options = { provider: "azure", providerName: "azure", endpoint: "https://legacy", auth: "entra", az: "az-token" };
  assert.deepEqual(audio.withAudioConnection(options), options);
  for (const [name, type] of [["local", "command"], ["direct-azure", "azure"], ["azure-speech", "azure"]]) assert.equal(audio.selectAudioProvider(name).provider, type);
  assert.doesNotThrow(() => audio.rejectSurfaceAuthKeys({ az: "az-token" }, "/read", { providerName: "azure" }));
  assert.doesNotThrow(() => audio.rejectSurfaceAuthKeys({ auth: "entra" }, "/stt", { providerName: "auto" }));
});

test("partial /audio edits inherit legacy auth/endpoint, and reset restores fallback", () => {
  const azure = { auth: "entra", az: "az-token", endpoint: "https://old.cognitiveservices.azure.com/tts" };
  settings(undefined, { tts: { providers: { azure } }, stt: { providers: { azure: { endpoint: "https://old.services.ai.azure.com" } } } });
  set("azure", { az: "another-broker" });
  assert.equal(resolve("azure").auth, "entra"); assert.equal(resolve("azure").endpoint, azure.endpoint);
  assert.equal(resolve("azure", { kind: "stt" }).endpoint, "https://old.services.ai.azure.com");
  assert.equal(resolve("azure", { kind: "stt" }).az, "another-broker");
  audio.resetRuntimeAudioProviders("azure", scope); assert.equal(resolve("azure"), undefined);
});

test("shared resource endpoint and per-capability overrides; custom names ignore fleet auth env", () => {
  settings(named);
  assert.deepEqual(audio.selectAudioProvider("Azure-Work", scope), { provider: "azure", providerName: "azure-work" });
  set("azure-work", { "stt.endpoint": "https://other.services.ai.azure.com" });
  assert.equal(resolve("azure-work").endpoint, named["azure-work"].endpoint);
  assert.equal(resolve("azure-work", { kind: "stt" }).endpoint, "https://other.services.ai.azure.com");
  assert.equal(resolve("azure-work", { env: { AZURE_SPEECH_AZ: "different", AZURE_SPEECH_AUTH: "key" } }).az, "az-token");
  const out = audio.withAudioConnection(request({ providerName: "azure-work", provider: "azure", apiKey: "stale-key", resourceId: "/old", voice: "keep" }));
  assert.equal(out.apiKey, undefined); assert.equal(out.resourceId, undefined); assert.equal(out.voice, "keep");
  assert.throws(() => audio.rejectSurfaceAuthKeys({ az: "local-override" }, "/read", { ...scope, providerName: "azure-work" }), /use \/audio azure-work/);
});

test("built-in env precedence, runtime precedence, validation and private key references", () => {
  settings({ azure: { auth: "entra", az: "az", endpoint: "https://r.cognitiveservices.azure.com" }, gateway: { type: "openai", endpoint: "https://gateway.test/v1", apiKeyEnv: "GATEWAY_KEY" } });
  assert.equal(resolve("azure", { env: { AZURE_SPEECH_AZ: "fleet-broker" } }).az, "fleet-broker");
  set("azure", { az: "runtime-broker" }); assert.equal(resolve("azure", { env: { AZURE_SPEECH_AZ: "fleet-broker" } }).az, "runtime-broker");
  assert.throws(() => audio.withAudioConnection(request({ providerName: "gateway", env: { OPENAI_API_KEY: "wrong-account" } })), /GATEWAY_KEY is not set/);
  assert.equal(audio.withAudioConnection(request({ providerName: "gateway", env: { GATEWAY_KEY: "correct" } })).apiKey, "correct");
  for (const patch of [{ api_key: "secret" }, { endpoint: "https://u:secret@host" }, { az: "bad\ncommand" }, { resource: "http://bad" }, { resource_id: "/invalid" }, { "stt.endpoint.extra": "https://x" }]) assert.throws(() => set("azure", patch));
  assert.throws(() => set("gateway", { az: "az-token" }), /only to azure/);
  assert.throws(() => set("azure", { type: "openai" }), /new name/);
  assert.throws(() => set("unknown", { endpoint: "https://x" }), /needs type/);
});

test("MAI resource aliases normalize without changing non-Azure proxy prefixes", () => {
  for (const suffix of ["", "/", "/stt", "/tts", "/tts/cognitiveservices/v1/"]) assert.equal(maiTranscriptionRoot("https://r.cognitiveservices.azure.com" + suffix), "https://r.services.ai.azure.com");
  assert.equal(maiTranscriptionRoot("https://proxy.example/azure/stt"), "https://proxy.example/azure/stt");
});

test("named STT / PTT dispatch resolves Entra and preserves a deployment override", async () => {
  settings(named); set("azure-work", { "stt.deployment": "custom-transcribe" });
  const b = broker(), seen = [];
  const s = resolveSttSettings({}, { provider: "azure-work", model: "mai-transcribe-2" }, {}, scope.audioProviders);
  const text = await transcribeSpeech(pcm, request({ ...s, azureTokenBroker: b, fetchImpl: async (url, init) => { seen.push({ url, init }); return Response.json({ text: "ok" }); } }));
  assert.equal(text, "ok"); assert.deepEqual(b.calls, ["az-token"]);
  assert.equal(seen[0].url, "https://work.services.ai.azure.com/mai/v1/audio/transcriptions");
  assert.equal(seen[0].init.headers.Authorization, "Bearer fixture-token"); assert.equal(seen[0].init.headers["api-key"], undefined);
  assert.equal(JSON.parse(seen[0].init.body).model, "custom-transcribe");
});

test("auto chooses configured Azure for MAI and does not leak that endpoint into OpenAI", async () => {
  settings({ azure: named["azure-work"] }); const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); return Response.json({ text: "ok" }); };
  await transcribeSpeech(pcm, request({ provider: "auto", model: "mai-transcribe-2", azureTokenBroker: broker(), fetchImpl }));
  await transcribeSpeech(pcm, request({ provider: "auto", model: "whisper-1", fetchImpl }));
  assert.deepEqual(urls, ["https://work.services.ai.azure.com/mai/v1/audio/transcriptions", "https://api.openai.com/v1/audio/transcriptions"]);
});

test("OpenAI named providers retain key auth for both synthesis and transcription", async () => {
  settings({ gateway: { type: "openai", endpoint: "https://gateway.test/v1", apiKeyEnv: "WORK_KEY" } });
  const seen = [], config = request({ provider: "openai", providerName: "gateway", env: { ...env, WORK_KEY: "key-fixture" } });
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers }); return String(url).includes("transcriptions") ? Response.json({ text: "ok" }) : new Response(pcm); };
  await synthesizeSpeechDirect("fixture", { ...config, fetchImpl }); await transcribeSpeech(pcm, { ...config, fetchImpl });
  assert.deepEqual(seen.map(v => v.url), ["https://gateway.test/v1/audio/speech", "https://gateway.test/v1/audio/transcriptions"]);
  assert.ok(seen.every(v => v.headers.Authorization === "Bearer key-fixture"));
});

test("read, TTS/narration and choices observe the same session provider edits", async () => {
  settings(named);
  const selected = { provider: "azure-work" }, captured = [];
  const synthesize = async (_text, options) => { captured.push({ az: options.az, endpoint: options.endpoint, name: options.providerName }); return pcm; };
  const player = { play: async () => {}, interrupt: async () => {}, dispose: async () => {} };
  const read = createReadModeController({ ...scope, env, persistedTts: selected, synthesize, player });
  const tts = createAgentSpeechController({ env, initialConfig: resolveAgentTtsSettings({ ...scope, env, persisted: selected }).config, synthesize, player });
  const choices = createChoiceSpeaker({ ...scope, env, persisted: selected, synthesize, player });
  try {
    await read.speak("read one"); await tts.speak("tts one"); await choices.speak("choices one");
    set("azure-work", { az: "updated-broker" });
    await read.speak("read two"); await tts.speak("narrate two", { speechKind: "narrate" }); await choices.speak("choices two");
    assert.deepEqual(captured.map(c => c.az), ["az-token", "az-token", "az-token", "updated-broker", "updated-broker", "updated-broker"]);
    assert.ok(captured.every(c => c.name === "azure-work"));
  } finally { await read.dispose(); await tts.dispose(); await choices.dispose(); }
});

test("cascade and direct/Pebble calls keep distinct provider ownership", async () => {
  settings(named); const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, headers: init.headers }); return new Response(pcm); };
  const roster = cascadeRosterFromArgs("provider=azure-work", { ...scope, env: {}, persisted: {} });
  assert.equal(roster.roster.participants[0].providerName, "azure-work");
  const synth = makeCascadeTtsSynth({ ...scope, env, fetchImpl, persisted: { provider: "azure-work" } });
  // Use key mode with a fixture key to avoid ever invoking the real az broker.
  set("azure-work", { auth: "key", api_key_env: "AUDIO_TEST_KEY" });
  await makeCascadeTtsSynth({ ...scope, env: { ...env, AUDIO_TEST_KEY: "key" }, fetchImpl, persisted: { provider: "azure-work" } })("fixture");
  assert.match(seen[0].url, /work\.cognitiveservices\.azure\.com\/tts\/cognitiveservices\/v1/);
  const b = broker();
  await transcribeMaiAudioDirect({ pcm, endpoint: "https://pebble.cognitiveservices.azure.com/stt", auth: "entra", az: "pebble-broker", azureTokenBroker: b, fetchImpl: async url => { assert.match(url, /pebble.services.ai.azure.com\/mai/); return Response.json({ text: "ok" }); } });
  assert.deepEqual(b.calls, ["pebble-broker"]);
});

test("admitted options stay pinned while next requests see updated provider state", () => {
  settings(named); const c = applyReadConfigValues(defaultReadConfig({}, {}, {}, scope.audioProviders), { provider: "azure-work" }, {});
  const first = ttsSynthesisOptions(c, { env: {} }); set("azure-work", { az: "new" });
  assert.equal(audio.withAudioConnection(first).az, "az-token"); assert.equal(ttsSynthesisOptions(c, { env: {} }).az, "new");
});

test("different Pi buses isolate state, different facades share it, final release clears it", () => {
  const emitter = new EventEmitter(), pi = () => ({ events: { emit: (...a) => emitter.emit(...a), on: (n, fn) => { emitter.on(n, fn); return () => emitter.off(n, fn); } } });
  const a = audio.bindAudioProviders(pi()), b = audio.bindAudioProviders(pi()), other = audio.bindAudioProviders({ events: new EventEmitter() });
  assert.equal(a.providers, b.providers); assert.notEqual(a.providers, other.providers);
  audio.setRuntimeAudioProvider("example", { type: "openai", endpoint: "https://one.test" }, { audioProviders: a.providers });
  assert.equal(audio.resolveAudioConnection("example", { audioProviders: b.providers }).endpoint, "https://one.test");
  assert.throws(() => audio.selectAudioProvider("example", { audioProviders: other.providers }));
  a.release(); assert.equal(b.providers.closed, false); b.release(); assert.equal(b.providers.closed, true); assert.equal(emitter.listenerCount("agent-utils:audio-providers.v1"), 0); other.release();
});

function harness() {
  const commands = new Map(), handlers = new Map(), entries = [], notes = [];
  const pi = { events: new EventEmitter(), registerCommand: (n, c) => commands.set(n, c), on: (e, h) => handlers.set(e, h), appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  const binding = audio.bindAudioProviders(pi, { settingsPath }); audioExtension(pi);
  const ctx = { ui: { notify: (m, level) => notes.push({ m, level }) }, sessionManager: { getEntries: () => entries } };
  return { commands, handlers, entries, notes, ctx, binding };
}
test("/audio commits only provider overrides to its own session entry, restores and resets", async () => {
  const h = harness(), original = readFileSync(settingsPath, "utf8");
  try {
    await h.commands.get("audio").handler("work type=azure auth=entra az=az-token endpoint=https://work.cognitiveservices.azure.com", h.ctx);
    assert.equal(h.notes.at(-1).level, "info"); assert.equal(h.entries.at(-1).customType, "audio-runtime-settings");
    assert.equal(h.entries.length, 1); assert.equal(readFileSync(settingsPath, "utf8"), original);
    h.binding.providers.overrides.clear(); h.handlers.get("session_start")({}, h.ctx);
    assert.equal(audio.resolveAudioConnection("work", { audioProviders: h.binding.providers }).az, "az-token");
    await h.commands.get("audio").handler("work api_key=do-not-store", h.ctx); assert.equal(h.entries.length, 1);
    assert.ok(!JSON.stringify(h.entries).includes("do-not-store"));
    await h.commands.get("audio").handler("work reset", h.ctx); assert.equal(h.binding.providers.overrides.size, 0);
  } finally { h.handlers.get("session_shutdown")(); h.binding.release(); }
});
test("settings cancellation and late UI completion after shutdown never commit", async () => {
  const h = harness();
  let resolve; h.ctx.ui.select = () => new Promise(done => { resolve = done; });
  const pending = h.commands.get("audio").handler("settings", h.ctx);
  h.handlers.get("session_shutdown")();
  Object.defineProperty(h.ctx, "ui", { get() { throw new Error("stale ctx"); } });
  resolve("+ new provider"); await pending;
  assert.equal(h.entries.length, 0); h.binding.release();
});
