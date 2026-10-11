import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  azureAuthSettings, azureTokenArgs, createAzureTokenBroker, azureAuthHeaders,
} from "../extensions/lib/azure-speech-auth.js";
import { synthesizeAzureSpeechDirect, azureSpeechUrl } from "../extensions/lib/tts.js";
import { defaultReadConfig, applyReadConfigValues, createReadModeController } from "../extensions/read-aloud.js";
import { resolveAgentTtsSettings, createAgentSpeechController } from "../extensions/lib/tts-narration.js";
import { ttsSynthesisOptions, speechCredentialStatus } from "../extensions/lib/tts-provider-config.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { makeCascadeTtsSynth } from "../extensions/lib/realtime-cascade-session.js";
import { resolveSttSettings, transcribeSpeech } from "../extensions/lib/stt-provider.js";
import { readPersistedSttSettings } from "../extensions/lib/realtime-settings.js";

const now = 1791710000000;
const pcm = Buffer.from([1, 0, 2, 0]);
const resourceId = "/subscriptions/fixture/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/speech";
const azure = { auth: "entra", az: "fixture-az", endpoint: "https://speech.cognitiveservices.azure.com/tts" };
const jwt = exp => `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
function fixtureSpawn(reply = () => ({ accessToken: "fixture-token", expires_on: (now + 3600000) / 1000 }), { delayed = false } = {}) {
  const processes = [];
  function spawn(command, args, options) {
    const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.command = command; proc.args = args; proc.options = options; proc.kills = [];
    proc.kill = sig => { proc.kills.push(sig); queueMicrotask(() => proc.emit("close", null)); };
    proc.finish = () => { proc.stdout.emit("data", Buffer.from(JSON.stringify(reply(processes.length)))); proc.emit("close", 0); };
    processes.push(proc);
    if (!delayed) queueMicrotask(proc.finish);
    return proc;
  }
  return { spawn, processes };
}

test("Azure key mode is the default; entra/broker policy resolves without provider changes", async () => {
  const fallback = azureAuthSettings({ env: {} });
  assert.equal(fallback.auth, "key"); assert.equal(fallback.az, "az");
  assert.deepEqual(azureTokenArgs(), ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com/", "--output", "json", "--only-show-errors"]);
  assert.deepEqual(azureTokenArgs({ resource: "https://other.invalid/", tenant: "tenant", subscription: "subscription" }).slice(-4), ["--tenant", "tenant", "--subscription", "subscription"]);
  const persisted = { providers: { azure } };
  const read = defaultReadConfig({}, persisted);
  const agent = resolveAgentTtsSettings({ env: {}, persisted }).config;
  for (const config of [read, agent]) {
    assert.equal(config.provider, "azure"); assert.equal(config.auth, "entra"); assert.equal(config.az, "fixture-az"); assert.equal(config.endpoint, azure.endpoint);
    assert.match(speechCredentialStatus(config, {}), /auth:entra.*broker:fixture-az/);
    assert.equal(ttsSynthesisOptions(config).auth, "entra");
  }
  assert.equal(defaultReadConfig({ AZURE_SPEECH_ENDPOINT: "https://legacy.invalid" }, persisted).endpoint, azure.endpoint, "explicit provider endpoint supersedes legacy regional env");
  assert.equal(resolveAgentTtsSettings({ env: { PI_TTS_AZURE_AUTH: "key", AZURE_SPEECH_AUTH: "entra", PI_TTS_AZURE_AZ: "other-az" }, persisted }).config.auth, "key");
  assert.equal(resolveAgentTtsSettings({ env: { PI_TTS_PROVIDER: "azure" }, persisted: { provider: "openai", endpoint: "https://openai.invalid" } }).config.endpoint, undefined, "provider switch never reattaches a foreign endpoint");
  assert.equal(applyReadConfigValues(read, { auth: "key", az: "another-az" }, {}).az, "another-az");
  const openai = applyReadConfigValues(read, { provider: "openai" }, {});
  assert.equal(openai.auth, undefined); assert.equal(openai.az, undefined); assert.equal(openai.endpoint, undefined);
  assert.throws(() => azureAuthSettings({ options: { auth: "invalid" }, env: {} }), /auth must be/);
  assert.throws(() => azureAuthSettings({ options: { az: "bad\ncommand" }, env: {} }), /executable/);
  assert.equal(azureSpeechUrl("https://eastus.tts.speech.microsoft.com"), "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
  assert.equal(azureSpeechUrl("https://speech.cognitiveservices.azure.com"), "https://speech.cognitiveservices.azure.com/tts/cognitiveservices/v1");
  assert.equal(azureSpeechUrl(azure.endpoint), "https://speech.cognitiveservices.azure.com/tts/cognitiveservices/v1");
  assert.throws(() => azureSpeechUrl("https://user:secret@bad.invalid"), /without credentials/);
  const notUsed = { getToken() { assert.fail("key auth must not run a broker"); } };
  assert.deepEqual((await azureAuthHeaders({ auth: "key", apiKey: "fixture-key", azureTokenBroker: notUsed, env: {} })).headers, { "api-key": "fixture-key" });
});

test("token broker caches, refreshes before UTC expiry, serializes concurrent acquisitions and separates identities", async () => {
  let time = now;
  const f = fixtureSpawn(n => ({ accessToken: `token-${n}`, expires_on: (time + 3600000) / 1000 }));
  const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => time });
  const opts = { az: "/path/with spaces/az-token", env: { HOME: "/fixture", PATH: "/bin" } };
  try {
    const tokens = await Promise.all(Array.from({ length: 8 }, () => broker.getToken(opts)));
    assert.equal(new Set(tokens).size, 1); assert.equal(f.processes.length, 1);
    assert.equal(f.processes[0].command, opts.az); assert.equal(f.processes[0].options.stdio[0], "ignore"); assert.equal(f.processes[0].options.stdio[2], "ignore");
    time += 50 * 60000;
    assert.equal(await broker.getToken(opts), "token-1");
    time += 6 * 60000;
    assert.equal(await broker.getToken(opts), "token-2", "refresh five minutes before expiry");
    broker.invalidate(opts, "token-1");
    assert.equal(await broker.getToken(opts), "token-2", "late 401 can't invalidate a refreshed successor");
    broker.invalidate(opts, "token-2");
    assert.equal(await broker.getToken(opts), "token-3");
    for (const changed of [{ tenant: "other" }, { subscription: "other" }, { resource: "https://other.invalid" }, { az: "other-az" }, { env: { HOME: "/other" } }]) await broker.getToken({ ...opts, ...changed });
    assert.equal(f.processes.length, 8);
    assert.deepEqual(Object.keys(broker.status()).sort(), ["cached", "pending"], "diagnostics never include credentials");
  } finally { broker.dispose(); }
});

test("UTC expires_on wins over local expiresOn; JWT exp supports old remote az brokers", async () => {
  const f = fixtureSpawn(() => ({ accessToken: jwt((now + 3600000) / 1000), expiresOn: "1900-01-01 00:00:00" }));
  const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now });
  try { assert.equal(await broker.getToken({ env: {} }), jwt((now + 3600000) / 1000)); }
  finally { broker.dispose(); }
  for (const value of [{ accessToken: "secret", expiresOn: "2099-01-01 00:00:00" }, { accessToken: "secret", expires_on: now / 1000 }, { accessToken: "secret\nheader", expires_on: (now + 3600000) / 1000 }]) {
    const fake = fixtureSpawn(() => value); const b = createAzureTokenBroker({ spawnImpl: fake.spawn, now: () => now });
    try { await assert.rejects(b.getToken({ env: {} }), e => /expiry|accessToken/.test(e.message) && !e.message.includes("secret")); }
    finally { b.dispose(); }
  }
});

test("cancelling one token waiter doesn't cancel another; cancelling the last stops the acquisition", async () => {
  const f = fixtureSpawn(undefined, { delayed: true });
  const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now });
  try {
    const a = new AbortController();
    const first = broker.getToken({ az: "fixture-az", env: {}, signal: a.signal });
    const second = broker.getToken({ az: "fixture-az", env: {} });
    a.abort(); await assert.rejects(first, { name: "AbortError" });
    assert.deepEqual(f.processes[0].kills, []);
    f.processes[0].finish(); assert.equal(await second, "fixture-token");
    const c = new AbortController();
    const cancelled = broker.getToken({ az: "other-az", env: {}, signal: c.signal });
    c.abort(); await assert.rejects(cancelled, { name: "AbortError" });
    assert.ok(f.processes[1].kills.includes("SIGTERM"));
    const next = broker.getToken({ az: "other-az", env: {} });
    assert.equal(f.processes.length, 3); f.processes[2].finish(); await next;
  } finally { broker.dispose(); }
});

test("a hung/failed/oversized token broker is bounded and never exposes output", async () => {
  const f = fixtureSpawn(undefined, { delayed: true });
  const b = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now, timeoutMs: 15 });
  try {
    await assert.rejects(b.getToken({ env: {} }), /broker timed out/);
    assert.ok(f.processes[0].kills.includes("SIGTERM"));
    const bad = b.getToken({ env: {} }); f.processes[1].emit("close", 1);
    await assert.rejects(bad, /exited 1.*output omitted/);
    const huge = b.getToken({ env: {} }); f.processes[2].stdout.emit("data", Buffer.alloc(128 * 1024 + 1, 65));
    await assert.rejects(huge, /exceeded 128 KiB/);
    assert.equal(b.status().cached, 0);
  } finally { b.dispose(); }
});

test("token cache is bounded across distinct accounts", async () => {
  const f = fixtureSpawn(); const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now });
  try {
    for (let i = 0; i < 40; i++) await broker.getToken({ az: "fixture", tenant: `tenant-${i}`, env: {} });
    assert.equal(broker.status().cached, 32);
  } finally { broker.dispose(); }
});

test("Azure HTTP uses only the selected auth header, refreshes after 401 without replay and shares the token with STT", async () => {
  const f = fixtureSpawn(n => ({ accessToken: `token-${n}`, expires_on: (now + 3600000) / 1000 }));
  const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now });
  const requests = [];
  const common = { auth: "entra", az: "az-token", azureTokenBroker: broker, env: { AZURE_SPEECH_API_KEY: "disabled-key" }, endpoint: azure.endpoint };
  const fetchImpl = async (url, init) => { requests.push({ url, init }); return new Response(requests.length === 1 ? "upstream secret" : pcm, { status: requests.length === 1 ? 401 : 200 }); };
  try {
    await assert.rejects(synthesizeAzureSpeechDirect({ ...common, text: "fixture", fetchImpl }), /HTTP 401; response body omitted/);
    assert.equal(requests.length, 1, "no automatic HTTP retry");
    await synthesizeAzureSpeechDirect({ ...common, text: "fixture", fetchImpl });
    assert.equal(f.processes.length, 2, "next request reacquires invalidated auth");
    assert.equal(requests[1].init.headers.Authorization, "Bearer token-2");
    assert.equal(requests[1].init.headers["Ocp-Apim-Subscription-Key"], undefined);
    assert.ok(!requests[1].init.body.includes("token-"));
    const stt = await transcribeSpeech(pcm, { ...common, provider: "azure", resourceId, endpoint: "https://stt.cognitiveservices.azure.com", fetchImpl: async (url, init) => { requests.push({ url, init }); return new Response('{"text":"fixture transcript"}', { headers: { "content-type": "application/json" } }); } });
    assert.equal(stt, "fixture transcript"); assert.equal(f.processes.length, 2, "one broker cache across TTS and STT");
    assert.equal(requests[2].init.headers.Authorization, "Bearer token-2", "MAI uses raw bearer, never Speech aad# wrapper");
    assert.equal(requests[2].init.headers["api-key"], undefined);
    assert.equal(requests[2].url, "https://stt.services.ai.azure.com/mai/v1/audio/transcriptions");
    const wrapped = await azureAuthHeaders({ ...common, resourceId }, { speechResource: true });
    assert.equal(wrapped.headers.Authorization, `Bearer aad#${resourceId}#token-2`);
  } finally { broker.dispose(); }
});

test("TTS/STT deadlines cover broker wait; no request occurs after cancellation or missing executable", async () => {
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return new Response(pcm); };
  for (const kind of ["tts", "stt"]) {
    const f = fixtureSpawn(undefined, { delayed: true });
    const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now });
    try {
      const options = { auth: "entra", az: "fixture", env: {}, endpoint: "https://resource.cognitiveservices.azure.com", azureTokenBroker: broker, fetchImpl, timeoutMs: 15 };
      await assert.rejects(kind === "tts" ? synthesizeAzureSpeechDirect({ ...options, text: "fixture" }) : transcribeSpeech(pcm, { ...options, provider: "azure" }), /timed out after 15ms/);
      assert.ok(f.processes[0].kills.includes("SIGTERM")); assert.equal(fetched, 0);
    } finally { broker.dispose(); }
  }
  const broker = createAzureTokenBroker({ spawnImpl: () => { throw new Error("secret broker trace"); } });
  try { await assert.rejects(synthesizeAzureSpeechDirect({ text: "x", auth: "entra", env: {}, azureTokenBroker: broker, fetchImpl }), e => /could not start/.test(e.message) && !e.message.includes("secret")); }
  finally { broker.dispose(); }
});

test("all speech surfaces carry nested Azure auth, preserving voice and settings", async () => {
  const persisted = { providers: { azure }, voice: "explicit-voice", embedding: "profile" };
  const seen = [];
  const synthesize = async (_text, options) => { seen.push(options); return pcm; };
  const player = { play: async () => {}, interrupt() {}, dispose() {} };
  const read = createReadModeController({ env: {}, persistedTts: persisted, synthesize, player });
  const agent = createAgentSpeechController({ env: {}, initialConfig: resolveAgentTtsSettings({ env: {}, persisted }).config, synthesize, player });
  const choice = createChoiceSpeaker({ env: {}, persisted, synthesize, player });
  try {
    await read.speak("read"); await agent.speak("tts"); await agent.speak("narrate", { speechKind: "narrate" }); await choice.speak("choice");
    assert.equal(seen.length, 4);
    for (const options of seen) { assert.equal(options.auth, "entra"); assert.equal(options.az, azure.az); assert.equal(options.endpoint, azure.endpoint); assert.equal(options.voice, "explicit-voice"); }
    const f = fixtureSpawn(); const broker = createAzureTokenBroker({ spawnImpl: f.spawn, now: () => now });
    try {
      let request;
      await makeCascadeTtsSynth({ env: {}, persisted, fetchImpl: async (url, init) => { request = { url, init }; return new Response(pcm); } })("cascade", { azureTokenBroker: broker });
      assert.equal(request.url, azure.endpoint + "/cognitiveservices/v1"); assert.equal(request.init.headers.Authorization, "Bearer fixture-token");
    } finally { broker.dispose(); }
    const stt = resolveSttSettings({}, { model: "mai-transcribe-2", providers: { azure: { az: "stt-az", endpoint: "https://stt.invalid" } } }, persisted);
    assert.equal(stt.auth, "entra"); assert.equal(stt.az, "stt-az"); assert.equal(stt.endpoint, "https://stt.invalid");
    assert.equal(stt.resourceId, undefined);
  } finally { read.dispose(); agent.dispose(); choice.dispose(); }
});

test("STT inherits Azure auth from shared settings, never TTS endpoint/resource ID", async t => {
  const root = await mkdtemp(join(tmpdir(), "speech-entra-settings-")); t.after(() => rm(root, { recursive: true, force: true }));
  const settings = join(root, "settings.json");
  const original = JSON.stringify({ agentUtils: { tts: { providers: { azure: { ...azure, resourceId } } }, stt: { model: "mai-transcribe-2", providers: { azure: { az: "stt-broker" } } } } });
  await writeFile(settings, original);
  const stt = readPersistedSttSettings(settings);
  assert.equal(stt.providers.azure.auth, "entra"); assert.equal(stt.providers.azure.az, "stt-broker"); assert.equal(stt.providers.azure.endpoint, undefined); assert.equal(stt.providers.azure.resourceId, undefined);
});

test("real broker executable and managed symlink cross the TTS HTTP boundary with no key or audio subprocess", async t => {
  const root = await mkdtemp(join(tmpdir(), "speech-entra-process-")); t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "broker fixture"); const command = join(root, "az-token");
  const token = "process-fixture-token";
  const body = JSON.stringify({ accessToken: token, expires_on: Math.floor(Date.now() / 1000) + 3600 });
  await writeFile(target, `#!/bin/sh\n[ "$1 $2 $3" = "account get-access-token --resource" ] || exit 2\nprintf '%s\\n' '${body}'\n`); await chmod(target, 0o700); await symlink(target, command);
  const requests = [];
  const server = createServer(async (req, res) => { const chunks = []; for await (const data of req) chunks.push(data); requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() }); res.end(pcm); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const broker = createAzureTokenBroker(); t.after(() => broker.dispose());
  const bytes = await synthesizeAzureSpeechDirect({ text: "synthetic fixture", auth: "entra", az: command, env: {}, azureTokenBroker: broker, endpoint: `http://127.0.0.1:${server.address().port}` });
  assert.deepEqual(bytes, pcm); assert.equal(requests.length, 1); assert.equal(requests[0].headers.authorization, `Bearer ${token}`); assert.equal(requests[0].headers["ocp-apim-subscription-key"], undefined); assert.ok(!requests[0].body.includes(token));
});
