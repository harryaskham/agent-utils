import test from "node:test";
import assert from "node:assert/strict";
import { ChoiceAudioCache } from "../extensions/lib/choice-audio-cache.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { speechTestEnv, waitForSpeech } from "./helpers/speech-environment.js";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("choice audio cache deduplicates in-flight synthesis while navigation cancels only its waiter", async () => {
  const cache = new ChoiceAudioCache(); cache.begin("choice-1");
  const work = deferred(); let calls = 0, signal;
  const producer = s => { calls++; signal = s; return work.promise; };
  const abort = new AbortController();
  const old = cache.get("A", producer, abort.signal);
  const current = cache.get("A", producer);
  await Promise.resolve(); abort.abort();
  assert.equal(await old, null); assert.equal(signal.aborted, false);
  work.resolve(Buffer.from("audio"));
  assert.equal(String(await current), "audio");
  assert.equal(String(await cache.get("A", producer)), "audio"); assert.equal(calls, 1);
  cache.end("wrong-id"); assert.equal(cache.snapshot().active, true);
  cache.end("choice-1");
  assert.equal(signal.aborted, true);
  assert.deepEqual(cache.snapshot(), { active: false, entries: 0, bytes: 0, pending: 0 });
});

test("choice audio memory is bounded; failed synthesis is retryable and no cache crosses choices", async () => {
  const cache = new ChoiceAudioCache({ maxBytes: 6, maxEntries: 2 }); cache.begin("one");
  await cache.get("a", async () => Buffer.alloc(4));
  await cache.get("b", async () => Buffer.alloc(4));
  assert.deepEqual(cache.snapshot(), { active: true, entries: 1, bytes: 4, pending: 0 });
  await cache.get("c", async () => Buffer.alloc(2)); assert.equal(cache.snapshot().bytes, 6);
  await assert.rejects(cache.get("bad", async () => { throw new Error("failed"); }), /failed/);
  assert.equal(String(await cache.get("bad", async () => Buffer.from("ok"))), "ok");
  cache.begin("two"); assert.equal(cache.snapshot().bytes, 0); assert.equal(cache.snapshot().entries, 0);
  await cache.get("large", async () => Buffer.alloc(7)); assert.equal(cache.snapshot().entries, 0);
  cache.end();
});

test("speaker replays PCM for introductions/options but clears it when the choice ends", async () => {
  const synthesized = [], played = [];
  const speaker = createChoiceSpeaker({ env: speechTestEnv({}),
    synthesize: async text => { synthesized.push(text); return Buffer.from(text); },
    player: { interrupt() {}, async play(pcm) { played.push(String(pcm)); return { interrupted: false }; } },
  });
  try {
    speaker.beginChoice("one");
    for (const text of ["Introduction", "A", "B", "A", "Introduction", "B"]) await speaker.speak(text);
    assert.deepEqual(synthesized, ["Introduction", "A", "B"]);
    assert.equal(played.length, 6);
    speaker.endChoice("one"); assert.equal(speaker.cacheSnapshot().entries, 0);
    speaker.beginChoice("two"); await speaker.speak("A");
    assert.deepEqual(synthesized, ["Introduction", "A", "B", "A"]);
  } finally { speaker.dispose(); }
});

test("rapidly revisiting a pending option reuses its synthesis and close aborts cache fills", async () => {
  const requests = new Map(), played = [];
  const speaker = createChoiceSpeaker({ env: speechTestEnv({}), synthesize: (text, options) => {
    const work = deferred(); requests.set(text, { ...work, signal: options.signal });
    options.signal.addEventListener("abort", () => work.resolve(null), { once: true });
    return work.promise;
  }, player: { interrupt() {}, async play(pcm) { played.push(String(pcm)); return {}; } } });
  try {
    speaker.beginChoice("one");
    const first = speaker.speak("A"); await waitForSpeech(() => requests.has("A"));
    const second = speaker.speak("B"); await waitForSpeech(() => requests.has("B"));
    const a = requests.get("A");
    const again = speaker.speak("A");
    assert.equal((await first).interrupted, true);
    assert.equal((await second).interrupted, true);
    assert.equal(a.signal.aborted, false);
    a.resolve(Buffer.from("A")); await again;
    assert.deepEqual(played, ["A"]); assert.equal(requests.size, 2);
    speaker.endChoice("one");
    assert.equal(requests.get("B").signal.aborted, true);
    assert.equal(speaker.cacheSnapshot().bytes, 0);
  } finally { speaker.dispose(); }
});
