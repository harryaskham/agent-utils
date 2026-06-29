import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { buildParticipantRoster, MODE_CASCADE, ORDER_FIXED } from "../extensions/lib/realtime-participants.js";
import {
  CascadeController,
  makeCascadeRunTurn,
  makeCascadeSpeak,
  makeCascadeSynth,
  makeCascadeTtsSynth,
  makeCascadePlay,
  cascadeRosterFromArgs,
} from "../extensions/lib/realtime-cascade-session.js";

function roster() {
  return buildParticipantRoster({ mode: MODE_CASCADE, participants: "var,cedar", main: { name: "main" }, env: {} }).participants;
}

// ---------------------------------------------------------------------------
// CascadeController
// ---------------------------------------------------------------------------

test("CascadeController requires a runTurn dep", () => {
  assert.throws(() => new CascadeController({ roster: roster() }), /requires a runTurn/);
});

test("handleHumanUtterance runs a round, accumulates conversation, and advances the round counter", async () => {
  const c = new CascadeController({
    roster: roster(),
    order: ORDER_FIXED,
    runTurn: (p) => `${p.name} reply`,
  });
  const r1 = await c.handleHumanUtterance("hello");
  assert.deepEqual(r1.turns.map((t) => t.name), ["main", "var", "cedar"]);
  assert.equal(c.round, 1);
  assert.deepEqual(c.conversation.map((e) => e.text), ["hello", "main reply", "var reply", "cedar reply"]);

  const r2 = await c.handleHumanUtterance("again");
  assert.equal(c.round, 2);
  // second round sees the first round's conversation as history
  assert.equal(r2.conversation[0].text, "hello");
  assert.ok(r2.conversation.some((e) => e.text === "again"));
});

test("handleHumanUtterance ignores empty text", async () => {
  let ran = 0;
  const c = new CascadeController({ roster: roster(), order: ORDER_FIXED, runTurn: () => { ran += 1; return "x"; } });
  assert.equal(await c.handleHumanUtterance("   "), null);
  assert.equal(await c.handleHumanUtterance(""), null);
  assert.equal(ran, 0);
  assert.equal(c.round, 0);
});

test("handleHumanUtterance drops an overlapping human turn while a round is in flight (one at a time)", async () => {
  let resolveTurn;
  const gate = new Promise((res) => { resolveTurn = res; });
  let calls = 0;
  const c = new CascadeController({
    roster: roster(),
    order: ORDER_FIXED,
    runTurn: async () => { calls += 1; await gate; return "ok"; },
  });
  const first = c.handleHumanUtterance("one");
  // while the first round is awaiting its first turn, a second utterance arrives
  const second = await c.handleHumanUtterance("two");
  assert.equal(second, null, "overlapping utterance dropped");
  resolveTurn();
  await first;
  assert.equal(c.round, 1);
});

test("reset clears the conversation and round counter", async () => {
  const c = new CascadeController({ roster: roster(), order: ORDER_FIXED, runTurn: (p) => `${p.name} r` });
  await c.handleHumanUtterance("hi");
  c.reset();
  assert.equal(c.round, 0);
  assert.deepEqual(c.conversation, []);
});

test("maxHistory keeps only the most recent conversation entries across rounds", async () => {
  const c = new CascadeController({ roster: roster(), order: ORDER_FIXED, runTurn: (p) => `${p.name} r`, maxHistory: 4 });
  // each round adds 1 human + 3 replies = 4 entries; with cap 4, only the last round survives
  await c.handleHumanUtterance("round one");
  await c.handleHumanUtterance("round two");
  assert.equal(c.conversation.length, 4);
  assert.equal(c.conversation[0].text, "round two");
  assert.deepEqual(c.conversation.map((e) => e.speaker), ["Human", "main", "var", "cedar"]);
});

test("maxHistory unset (0) leaves the conversation unbounded", async () => {
  const c = new CascadeController({ roster: roster(), order: ORDER_FIXED, runTurn: (p) => `${p.name} r` });
  await c.handleHumanUtterance("a");
  await c.handleHumanUtterance("b");
  assert.equal(c.conversation.length, 8); // 2 rounds * (1 human + 3 replies)
});

test("handleHumanUtterance records lastError and clears busy when a turn throws", async () => {
  const c = new CascadeController({ roster: roster(), order: ORDER_FIXED, runTurn: () => { throw new Error("llm boom"); } });
  await assert.rejects(c.handleHumanUtterance("hi"), /llm boom/);
  assert.equal(c.busy, false);
  assert.match(c.lastError, /llm boom/);
});

// ---------------------------------------------------------------------------
// makeCascadeRunTurn
// ---------------------------------------------------------------------------

test("makeCascadeRunTurn calls chat-completions with per-participant model/base-url over defaults", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "hi" } }] }), text: async () => "" };
  };
  const runTurn = makeCascadeRunTurn({ defaultModel: "default-model", defaultBaseUrl: "http://default:1", fetchImpl, envRead: () => undefined });

  await runTurn({ name: "var", model: "peer-model", baseUrl: "http://peer:2" }, [{ role: "user", content: "x" }]);
  await runTurn({ name: "main" }, [{ role: "user", content: "y" }]);

  assert.equal(seen[0].url, "http://peer:2/v1/chat/completions");
  assert.equal(seen[0].body.model, "peer-model");
  assert.equal(seen[1].url, "http://default:1/v1/chat/completions");
  assert.equal(seen[1].body.model, "default-model");
});

test("makeCascadeRunTurn caps reply length by default (maxTokens) and allows override", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "x" } }] }), text: async () => "" }; };
  const def = makeCascadeRunTurn({ defaultModel: "m", fetchImpl, envRead: () => undefined });
  await def({ name: "p" }, []);
  assert.equal(bodies[0].max_tokens, 200);
  const wide = makeCascadeRunTurn({ defaultModel: "m", maxTokens: 1000, fetchImpl, envRead: () => undefined });
  await wide({ name: "p" }, []);
  assert.equal(bodies[1].max_tokens, 1000);
});

// ---------------------------------------------------------------------------
// makeCascadeSpeak
// ---------------------------------------------------------------------------

test("makeCascadeSpeak requires a playImpl", () => {
  assert.throws(() => makeCascadeSpeak({}), /requires a playImpl/);
});

test("makeCascadeSpeak synthesises with the participant voice and plays the pcm", async () => {
  const synthCalls = [];
  const played = [];
  const synthImpl = async (text, opts) => { synthCalls.push({ text, opts }); return Buffer.from([1, 2, 3]); };
  const playImpl = async (pcm, p) => { played.push({ bytes: pcm.length, name: p?.name }); };
  const speak = makeCascadeSpeak({ synthImpl, playImpl });

  await speak({ name: "cedar", voice: "cedar", ttsModel: "tm", baseUrl: "http://v" }, "hello");
  assert.equal(synthCalls.length, 1);
  assert.equal(synthCalls[0].text, "hello");
  assert.equal(synthCalls[0].opts.voice, "cedar");
  assert.equal(synthCalls[0].opts.model, "tm");
  assert.deepEqual(played, [{ bytes: 3, name: "cedar" }]);
});

test("makeCascadeSpeak skips empty text and empty pcm without playing", async () => {
  let plays = 0;
  const speak = makeCascadeSpeak({ synthImpl: async () => Buffer.alloc(0), playImpl: async () => { plays += 1; } });
  await speak({ name: "x", voice: "v" }, "   ");   // empty text: no synth, no play
  await speak({ name: "x", voice: "v" }, "real");  // empty pcm: synth but no play
  assert.equal(plays, 0);
});

// ---------------------------------------------------------------------------
// cascadeRosterFromArgs
// ---------------------------------------------------------------------------

test("cascadeRosterFromArgs maps n/participants/order and main overrides onto a cascade roster", () => {
  const { roster, values } = cascadeRosterFromArgs("n=3 participants=var,cedar order=fixed voice=embedding:harry model=gpt-x", { env: {} });
  assert.equal(roster.mode, MODE_CASCADE);
  assert.equal(roster.order, "fixed");
  assert.equal(roster.participants.length, 3);
  // main override applied
  assert.equal(roster.participants[0].voice, "embedding:harry");
  assert.equal(roster.participants[0].model, "gpt-x");
  assert.deepEqual(roster.participants.slice(1).map((p) => p.name), ["var", "cedar"]);
  assert.equal(values.participants, "var,cedar");
});

test("cascadeRosterFromArgs defaults to a single cascade participant on empty args", () => {
  const { roster } = cascadeRosterFromArgs("", { env: {} });
  assert.equal(roster.mode, MODE_CASCADE);
  assert.equal(roster.participants.length, 1);
});

test("cascadeRosterFromArgs threads a per-main base_url and tts override", () => {
  const { roster } = cascadeRosterFromArgs("participants=var base_url=http://p tts=azure/speech/azure-tts", { env: {} });
  assert.equal(roster.participants[0].baseUrl, "http://p");
  assert.equal(roster.participants[0].ttsModel, "azure/speech/azure-tts");
});

test("makeCascadeSpeak sanitizes markdown/emoji out of the spoken text before synth", async () => {
  let synthText = null;
  const speak = makeCascadeSpeak({
    synthImpl: async (t) => { synthText = t; return Buffer.from([1]); },
    playImpl: async () => {},
  });
  await speak({ name: "var", voice: "v" }, "Hello **everyone** 👋 see `code`");
  assert.equal(synthText, "Hello everyone see code");
});

test("makeCascadeSynth sanitises + returns pcm; empty text -> empty buffer", async () => {
  const calls = [];
  const synth = makeCascadeSynth({ synthImpl: async (t, opts) => { calls.push({ t, opts }); return Buffer.from(t); } });
  const pcm = await synth({ name: "var", voice: "cedar", ttsModel: "tm" }, "Hello **world** 👋");
  assert.equal(calls[0].t, "Hello world");          // sanitised before synth
  assert.equal(calls[0].opts.voice, "cedar");
  assert.equal(pcm.toString(), "Hello world");
  const empty = await synth({ name: "var" }, "   ");
  assert.equal(empty.length, 0);                     // empty text -> empty buffer, no synth
  assert.equal(calls.length, 1);
});

test("makeCascadePlay requires playImpl and skips empty pcm", async () => {
  assert.throws(() => makeCascadePlay({}), /requires a playImpl/);
  let plays = 0;
  const play = makeCascadePlay({ playImpl: async () => { plays += 1; } });
  await play({ name: "x" }, Buffer.alloc(0));
  await play({ name: "x" }, Buffer.from([1, 2]));
  assert.equal(plays, 1);
});

test("CascadeController drives a pipelined round when given synth+play deps", async () => {
  const roster = buildParticipantRoster({ mode: MODE_CASCADE, participants: "var,cedar", main: { name: "main" }, env: {} }).participants;
  const playOrder = [];
  const c = new CascadeController({
    roster,
    order: ORDER_FIXED,
    runTurn: (p) => `${p.name} hi`,
    synth: (p) => Buffer.from(p.name),
    play: (p) => { playOrder.push(p.name); },
  });
  const res = await c.handleHumanUtterance("go");
  assert.deepEqual(res.turns.map((t) => t.name), ["main", "var", "cedar"]);
  assert.deepEqual(playOrder, ["main", "var", "cedar"]);
  assert.equal(c.round, 1);
});

// --- azure=true: direct Azure Speech REST cascade ---

function fakeSpawn(byte) {
  let spawned = false;
  const spawnImpl = () => {
    spawned = true;
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    setImmediate(() => { p.stdout.emit("data", Buffer.from([byte])); p.emit("close", 0); });
    return p;
  };
  return { spawnImpl, didSpawn: () => spawned };
}

test("cascadeRosterFromArgs: azure=true defaults every agent to the azure-speech provider", () => {
  const { roster, directAzureSpeech } = cascadeRosterFromArgs("azure=true n=2 voice=MAI-Voice-2 speaker=p1");
  assert.equal(directAzureSpeech, true);
  assert.ok(roster.participants.length >= 2);
  for (const p of roster.participants) assert.equal(p.provider, "azure-speech");
});

test("cascadeRosterFromArgs: no azure flag leaves provider unset and directAzureSpeech false", () => {
  const { roster, directAzureSpeech } = cascadeRosterFromArgs("n=2");
  assert.equal(directAzureSpeech, false);
  for (const p of roster.participants) assert.equal(p.provider, undefined);
});

test("makeCascadeTtsSynth: azure-speech participant routes to the direct Azure REST path", async () => {
  let called = null;
  const fetchImpl = async (url, o) => { called = { url, o }; return { ok: true, status: 200, async arrayBuffer() { return Uint8Array.from([9]).buffer; } }; };
  const synth = makeCascadeTtsSynth({ directAzureSpeech: true, env: { AZURE_SPEECH_API_KEY: "k", AZURE_SPEECH_ENDPOINT: "https://e.example" }, fetchImpl });
  const pcm = await synth("hi", { provider: "azure-speech", voice: "MAI-Voice-2", speakerProfileId: "p1", lang: "en-GB" });
  assert.deepEqual(pcm, Buffer.from([9]));
  assert.equal(called.url, "https://e.example/cognitiveservices/v1");
  assert.equal(called.o.headers["Ocp-Apim-Subscription-Key"], "k");
  assert.match(called.o.body, /speakerProfileId='p1'/);
  assert.match(called.o.body, /<voice name='MAI-Voice-2'/);
});

test("makeCascadeTtsSynth: azure direct requires a concrete voice (rejects the embedding sentinel)", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); } }; };
  const synth = makeCascadeTtsSynth({ directAzureSpeech: true, env: { AZURE_SPEECH_API_KEY: "k" }, fetchImpl });
  await assert.rejects(synth("hi", { provider: "azure-speech", voice: "embedding:default" }), /concrete Azure voice/);
  assert.equal(fetched, false);
});

test("makeCascadeTtsSynth: non-azure provider uses the tts subprocess, not fetch", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); } }; };
  const { spawnImpl, didSpawn } = fakeSpawn(7);
  const synth = makeCascadeTtsSynth({ directAzureSpeech: true, env: {}, fetchImpl, spawnImpl });
  const pcm = await synth("hi", { provider: "openai", voice: "alloy" });
  assert.deepEqual(pcm, Buffer.from([7]));
  assert.equal(fetched, false);
  assert.equal(didSpawn(), true);
});

test("makeCascadeTtsSynth: directAzureSpeech=false keeps azure-speech on the subprocess path", async () => {
  let fetched = false;
  const fetchImpl = async () => { fetched = true; return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0); } }; };
  const { spawnImpl, didSpawn } = fakeSpawn(5);
  const synth = makeCascadeTtsSynth({ directAzureSpeech: false, env: {}, fetchImpl, spawnImpl });
  await synth("hi", { provider: "azure-speech", voice: "MAI-Voice-2" });
  assert.equal(fetched, false);
  assert.equal(didSpawn(), true);
});
