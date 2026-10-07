// Contract fixtures match Tools c2f4bf3: capability-gated cancellation/pan.
// No real daemon, credentials, synthesis, microphone or playback is used.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requestDaemonTts, transcribeDaemonAudio, daemonTtsRequest } from "../extensions/lib/speech-daemon.js";
import { createAgentSpeechController, resolveAgentTtsSettings } from "../extensions/lib/tts-narration.js";
import { createReadModeController, applyReadConfigValues, defaultReadConfig } from "../extensions/read-aloud.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { createTtsNarrationExtension } from "../extensions/tts-narration.js";
import { createInterruptiblePcmPlayer } from "../extensions/lib/tts.js";
import { createSpeechRequests, speechReplacesPrevious } from "../extensions/lib/speech-requests.js";
import { pcmToWav } from "../extensions/lib/realtime-stt-batch.js";
import { CascadeController, makeCascadeTtsSynth, makeCascadeSynth, makeCascadePlay, makeCascadeRunTurn } from "../extensions/lib/realtime-cascade-session.js";

const PCM = Buffer.from([16, 39, 16, 39]); // two samples of amplitude 10000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const observed = promise => promise.then(value => ({ value }), error => ({ error }));
const waitFor = async predicate => {
  const end = Date.now() + 4000;
  while (!predicate()) { assert.ok(Date.now() < end, "fixture did not settle"); await sleep(2); }
};
const reply = (res, value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
const errorReply = (res, code) => reply(res, { status: "error", error: { code, message: "private daemon detail" } });
function receipt(input, state = "completed", patch = {}) {
  return { status: "ok", job: {
    id: input.request_id, raw: input.raw, format: "pcm", state,
    audio_bytes: input.pan == null ? PCM.length : PCM.length * 2,
    audio_path: input.raw ? `/snapshot/audio/${input.request_id}` : undefined,
    ...(input.pan != null ? { pan: input.pan } : {}),
    ...(state === "completed" ? { channels: input.pan == null ? 1 : 2, sample_rate: 24000 } : {}),
    ...patch,
  } };
}
async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), "speech-daemon-contract-"));
  const requests = [], faults = [];
  const capabilities = { tts: ["tts.cancel", "pan"], stt: ["stt.transcribe.cancel", "stt.transcribe.status"] };
  const server = createServer(async (req, res) => {
    try {
      const [kind, ...rest] = req.url.slice(1).split("/");
      const path = `/${rest.join("/")}`;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
      const row = { kind, path, authorization: req.headers.authorization, ...body };
      requests.push(row);
      if (path === "/health") { reply(res, { capabilities: capabilities[kind] }); return; }
      await handler(row, res);
    } catch (error) { if (!req.aborted) { faults.push(error.message); if (!res.destroyed) res.writeHead(500).end(); } }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    assert.deepEqual(faults, [], "fixture errors");
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const env = { HOME: root, TTS_DAEMON_TOKEN: "fixture-tts", STT_DAEMON_TOKEN: "fixture-stt", PI_TTS_MUTE_PATH: join(root, "mute.json"), PI_TTS_DAEMON_URL: `${base}/tts`, PI_STT_DAEMON_URL: `${base}/stt` };
  return { requests, capabilities, env, options: kind => ({ env, daemonUrl: `${base}/${kind}`, timeoutMs: 3000, cancelTimeoutMs: 200 }), commands: () => requests.filter(r => r.operation) };
}

for (const phase of ["queued", "synthesizing", "ready", "playing"]) {
  test(`explicit abort cancels only the owned ${phase} TTS job with a fresh signal`, async t => {
    let input;
    const f = await fixture(t, (row, res) => {
      if (row.operation === "tts") { input = row.input; reply(res, receipt(input, phase)); }
      else if (row.operation === "tts.cancel") reply(res, receipt(input, "cancelled"));
      else reply(res, receipt(input, phase));
    });
    const abort = new AbortController();
    const pending = observed(requestDaemonTts("fixture", { ...f.options("tts"), signal: abort.signal }));
    await waitFor(() => input); abort.abort();
    const { error } = await pending;
    assert.equal(error.name, "AbortError");
    assert.equal(error.cancellation.outcome, "cancelled");
    assert.equal(error.remotePending, false);
    assert.deepEqual(f.commands().filter(c => c.operation.includes("cancel")).map(c => c.input), [{ id: input.request_id }]);
    assert.equal(f.commands().filter(c => c.operation === "tts").length, 1);
    assert.ok(!f.commands().some(c => c.operation.startsWith("daemon.")));
  });
}

for (const [outcome, pending] of [["completed", false], ["failed", false], ["not_found", false], ["cancel_pending", true], ["lost-reply", true], ["wrong-id", true]]) {
  test(`TTS cancellation reports ${outcome} truthfully without resubmission`, async t => {
    let input;
    const f = await fixture(t, (row, res) => {
      if (row.operation === "tts") { input = row.input; return; } // admission reply is lost
      assert.equal(row.operation, "tts.cancel");
      if (["completed", "failed"].includes(outcome)) reply(res, receipt(input, outcome));
      else if (outcome === "wrong-id") reply(res, receipt({ ...input, request_id: "not-ours" }, "cancelled"));
      else if (outcome !== "lost-reply") errorReply(res, outcome);
    });
    const abort = new AbortController();
    const result = observed(requestDaemonTts("fixture", { ...f.options("tts"), signal: abort.signal, requestId: "owned-job", cancelTimeoutMs: 30 }));
    await waitFor(() => input); abort.abort();
    const { error } = await result;
    assert.equal(error.name, "AbortError");
    assert.equal(error.remotePending, pending);
    assert.equal(error.cancellation.outcome, ({ not_found: "not_admitted", cancel_pending: "pending", "lost-reply": "unconfirmed", "wrong-id": "unconfirmed" })[outcome] || outcome);
    assert.deepEqual(f.commands().map(c => c.operation), ["tts", "tts.cancel"]);
    assert.ok(!error.message.includes("private daemon detail"));
  });
}

test("ordinary queue timeout never cancels admitted TTS", async t => {
  let input;
  const f = await fixture(t, (row, res) => {
    assert.ok(["tts", "tts.status"].includes(row.operation), "timeout must not cancel");
    if (row.operation === "tts") input = row.input;
    reply(res, receipt(input, "queued"));
  });
  const { error } = await observed(requestDaemonTts("wait", { ...f.options("tts"), timeoutMs: 250 }));
  assert.match(error.message, /timed out/); assert.equal(error.remotePending, true);
  assert.equal(error.cancellation, undefined);
  assert.equal(f.commands().filter(c => c.operation === "tts").length, 1);
});

test("pan is gated before admission and capability discovery sees a later deployment", async t => {
  const f = await fixture(t, (row, res) => reply(res, receipt(row.input)));
  f.capabilities.tts = [];
  await assert.rejects(requestDaemonTts("explicit pan", { ...f.options("tts"), pan: .4 }), /pan unsupported/);
  assert.equal(f.commands().length, 0);
  const legacy = await requestDaemonTts("session pan", { ...f.options("tts"), pan: .4, panSource: "session" });
  assert.ok(legacy.warnings.length);
  assert.ok(!Object.hasOwn(f.commands()[0].input, "pan"));
  f.capabilities.tts = ["tts.cancel", "pan"];
  const current = await requestDaemonTts("session pan", { ...f.options("tts"), pan: .4, panSource: "session" });
  assert.equal(current.job.pan, .4); assert.equal(current.job.channels, 2); assert.equal(current.job.sample_rate, 24000);
  assert.equal(f.commands()[1].input.pan, .4);
  assert.equal(f.requests.filter(r => r.path === "/health").length, 3);
  assert.deepEqual(current.warnings, []);
});

test("old daemons receive no gated cancellation operation", async t => {
  let input;
  const f = await fixture(t, (row, res) => { input = row.input; reply(res, receipt(input, "queued")); });
  f.capabilities.tts = [];
  const abort = new AbortController();
  const result = observed(requestDaemonTts("old server", { ...f.options("tts"), signal: abort.signal }));
  await waitFor(() => input); abort.abort();
  const { error } = await result;
  assert.equal(error.cancellation.outcome, "unsupported"); assert.equal(error.remotePending, true);
  assert.deepEqual(f.commands().map(c => c.operation), ["tts"]);
});

test("pan zero remains explicit, malformed pan is rejected, and raw synthesis always omits pan", () => {
  assert.equal(daemonTtsRequest("x", { pan: 0 }).pan, 0);
  for (const pan of [-2, 2, NaN, Infinity, "0.5"]) assert.throws(() => daemonTtsRequest("x", { pan }), /invalid pan/);
  assert.ok(!Object.hasOwn(daemonTtsRequest("x", { pan: .7 }, true), "pan"));
  assert.throws(() => daemonTtsRequest("x", { requestId: 42 }), /invalid request ID/);
});

test("raw daemon PCM is panned exactly once by the local player", async t => {
  let input, localPcm, localArgs;
  const f = await fixture(t, (row, res) => {
    if (row.path.startsWith("/snapshot/audio/")) { res.end(PCM); return; }
    if (row.operation === "tts") input = row.input;
    reply(res, receipt(input));
  });
  const player = createInterruptiblePcmPlayer({ spawnImpl: (_command, args) => {
    localArgs = args;
    const proc = new EventEmitter(); proc.stderr = new EventEmitter(); proc.stdin = new EventEmitter();
    proc.stdin.write = bytes => { localPcm = bytes; }; proc.stdin.end = () => queueMicrotask(() => proc.emit("close", 0)); proc.stdin.destroy = () => {};
    proc.kill = () => {};
    return proc;
  } });
  const controller = createAgentSpeechController({ env: f.env, initialConfig: { provider: "daemon", playback: "local", pan: -1, daemonUrl: f.options("tts").daemonUrl }, player });
  try {
    await controller.speak("local pan");
    assert.equal(input.raw, true); assert.ok(!Object.hasOwn(input, "pan"));
    assert.ok(localArgs.includes("--channels=2")); assert.equal(localPcm.length, PCM.length * 2);
    assert.equal(localPcm.readInt16LE(0), 10000); assert.equal(localPcm.readInt16LE(2), 0);
  } finally { await controller.dispose(); player.dispose(); }
});

for (const patch of [{ pan: -.7 }, { channels: 1 }, { sample_rate: 16000 }, { channels: null }, { sample_rate: null }]) {
  test(`panned playback verifies its receipt metadata ${JSON.stringify(patch)}`, async t => {
    const f = await fixture(t, (row, res) => reply(res, receipt(row.input, "completed", patch)));
    await assert.rejects(requestDaemonTts("metadata", { ...f.options("tts"), pan: .7 }), /pan receipt|PCM channel\/rate metadata/);
    assert.equal(f.commands().length, 1);
  });
}

test("raw stereo or wrong-rate metadata is rejected before downloading/playing", async t => {
  const f = await fixture(t, (row, res) => reply(res, receipt(row.input, "completed", { channels: 2 })));
  await assert.rejects(requestDaemonTts("raw", f.options("tts"), { raw: true }), /PCM channel\/rate metadata/);
  assert.ok(!f.requests.some(r => r.path.startsWith("/snapshot/audio/")));
});

test("daemon narration queues every request by default; scoped off cancels narration but not TTS", async t => {
  const jobs = new Map(); const cancelled = [];
  const f = await fixture(t, (row, res) => {
    if (row.operation === "tts") jobs.set(row.input.request_id, { input: row.input, state: "queued" });
    const job = jobs.get(row.input.request_id || row.input.id);
    if (row.operation === "tts.cancel") { cancelled.push(row.input.id); job.state = "cancelled"; }
    reply(res, receipt(job.input, job.state));
  });
  const controller = createAgentSpeechController({ env: { ...f.env, PI_TTS_PROVIDER: "daemon" } });
  const results = [];
  try {
    results.push(controller.speak("before", { speechKind: "narrate", streamName: "/narrate" }));
    await waitFor(() => jobs.size === 1);
    results.push(controller.speak("after", { speechKind: "narrate", streamName: "/narrate" }));
    results.push(controller.speak("final", { speechKind: "tts", streamName: "/tts" }));
    await waitFor(() => jobs.size === 3);
    assert.deepEqual(cancelled, [], "new messages must not cancel narration waiting in the server queue");
    assert.equal(controller.isPlaying(), true);
    await controller.interrupt({ kind: "narrate" });
    assert.equal(cancelled.length, 2);
    const last = [...jobs.values()].find(j => j.input.text === "final");
    assert.equal(last.state, "queued");
    assert.equal(controller.isPlaying(), true, "unrelated TTS request remains owned");
    last.state = "completed";
    assert.equal((await results[2]).interrupted, false);
    assert.equal(controller.isPlaying(), false);
  } finally { await controller.dispose(); await Promise.allSettled(results); }
});

test("local narration mute cancels only its owned daemon jobs", async t => {
  const jobs = new Map(), cancelled = [];
  const f = await fixture(t, (row, res) => {
    if (row.operation === "tts") jobs.set(row.input.request_id, { input: row.input, state: "queued" });
    const job = jobs.get(row.input.request_id || row.input.id);
    if (row.operation === "tts.cancel") { cancelled.push(row.input.id); job.state = "cancelled"; }
    reply(res, receipt(job.input, job.state));
  });
  const controller = createAgentSpeechController({ env: { ...f.env, PI_TTS_PROVIDER: "daemon" } });
  const narration = controller.speak("narration", { speechKind: "narrate", streamName: "/narrate" });
  const assistant = controller.speak("assistant", { speechKind: "tts" });
  try {
    await waitFor(() => jobs.size === 2);
    const path = f.env.PI_TTS_MUTE_PATH;
    await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, muted: { narrate: true }, epochs: { narrate: 1 } }));
    await rename(`${path}.tmp`, path);
    assert.equal((await narration).muted, true);
    const assistantJob = [...jobs.values()].find(j => j.input.text === "assistant");
    assert.equal(assistantJob.state, "queued"); assert.equal(cancelled.length, 1);
    assistantJob.state = "completed"; await assistant;
  } finally { await controller.dispose(); await Promise.allSettled([narration, assistant]); }
});

test("cancellation rereads the managed token after rotation rather than reusing discovery credentials", async t => {
  let input;
  const f = await fixture(t, (row, res) => {
    if (row.operation === "tts") { input = row.input; reply(res, receipt(input, "queued")); }
    else { assert.equal(row.authorization, "Bearer rotated-fixture"); reply(res, receipt(input, "cancelled")); }
  });
  const tokenFile = join(f.env.HOME, "daemon-token"); await writeFile(tokenFile, "initial-fixture");
  const env = { ...f.env }; delete env.TTS_DAEMON_TOKEN;
  const abort = new AbortController();
  const pending = observed(requestDaemonTts("fixture", { ...f.options("tts"), env, tokenFile, signal: abort.signal }));
  await waitFor(() => input); await writeFile(tokenFile, "rotated-fixture"); abort.abort();
  assert.equal((await pending).error.cancellation.outcome, "cancelled");
  assert.equal(f.requests[0].authorization, "Bearer initial-fixture");
});

test("automatic TTS and choice session pan reach a capable server, while explicit pan wins", async t => {
  const f = await fixture(t, (row, res) => reply(res, receipt(row.input)));
  const env = { ...f.env, PI_TTS_PROVIDER: "daemon", PI_TTS_FEED_ENABLED: "0" };
  const speech = createAgentSpeechController({ env });
  const handlers = new Map();
  createTtsNarrationExtension({ env, speech, persistedSettings: { tts: {}, narrate: {} } })({
    on: (name, fn) => handlers.set(name, fn), registerCommand() {}, registerMessageRenderer() {},
  });
  const ctx = { sessionManager: { getSessionId: () => "fixture-session", getEntries: () => [] }, ui: { notify() {} } };
  handlers.get("session_start")({}, ctx);
  const choices = createChoiceSpeaker({ env }); const assigned = choices.assignSession(ctx);
  try {
    assert.equal(speech.getConfig().panSource, "session");
    await speech.speak("assistant"); await choices.speak("choices");
    assert.equal(f.commands()[0].input.pan, speech.getConfig().pan);
    assert.equal(f.commands()[1].input.pan, assigned.pan);
    speech.apply({ pan: "-.5" }); await speech.speak("explicit");
    assert.equal(f.commands()[2].input.pan, -.5);
  } finally { await speech.dispose(); await choices.dispose(); }
});

test("interrupt=true opts daemon speech into replacement while dispose cancels the surviving request", async t => {
  const jobs = new Map(); const cancelled = [];
  const f = await fixture(t, (row, res) => {
    if (row.operation === "tts") jobs.set(row.input.request_id, row.input);
    const input = jobs.get(row.input.request_id || row.input.id);
    if (row.operation === "tts.cancel") cancelled.push(row.input.id);
    reply(res, receipt(input, row.operation === "tts.cancel" ? "cancelled" : "queued"));
  });
  const controller = createAgentSpeechController({ env: { ...f.env, PI_TTS_PROVIDER: "daemon", PI_TTS_INTERRUPT: "true" } });
  const first = controller.speak("first");
  await waitFor(() => jobs.size === 1);
  const second = controller.speak("second");
  await waitFor(() => jobs.size === 2 && cancelled.length === 1);
  assert.equal((await first).interrupted, true);
  await controller.dispose();
  assert.equal((await second).interrupted, true); assert.equal(cancelled.length, 2); assert.equal(controller.isPlaying(), false);
});

for (const surface of ["read", "choices"]) {
  test(`${surface} daemon speech tracks queued requests and cancels them all on explicit stop`, async t => {
    const jobs = new Map(); const cancelled = [];
    const f = await fixture(t, (row, res) => {
      if (row.operation === "tts") jobs.set(row.input.request_id, row.input);
      const input = jobs.get(row.input.request_id || row.input.id);
      if (row.operation === "tts.cancel") cancelled.push(row.input.id);
      reply(res, receipt(input, row.operation === "tts.cancel" ? "cancelled" : "queued"));
    });
    const env = { ...f.env, PI_TTS_PROVIDER: "daemon", PI_TTS_PAN: ".3" };
    const controller = surface === "read" ? createReadModeController({ env }) : createChoiceSpeaker({ env });
    const one = controller.speak("one"); await waitFor(() => jobs.size === 1);
    const two = controller.speak("two"); await waitFor(() => jobs.size === 2);
    assert.equal(cancelled.length, 0);
    for (const input of jobs.values()) assert.equal(input.pan, .3);
    await controller.dispose(); await Promise.all([one, two]); assert.equal(cancelled.length, 2);
  });
}

test("cascade cancellation propagates to the owned daemon job and joins cleanup", async t => {
  let input; const cancelled = [];
  const f = await fixture(t, (row, res) => {
    if (row.operation === "tts") input = row.input;
    if (row.operation === "tts.cancel") cancelled.push(row.input.id);
    reply(res, receipt(input, row.operation === "tts.cancel" ? "cancelled" : "queued"));
  });
  const synth = makeCascadeTtsSynth({ env: { ...f.env, PI_TTS_PROVIDER: "daemon" } });
  const controller = new CascadeController({ roster: [{ name: "agent", provider: "daemon", pan: -.2 }], runTurn: async () => "reply", synth: makeCascadeSynth({ synthImpl: synth }), play: makeCascadePlay({ playImpl: () => assert.fail("no local audio") }) });
  const result = observed(controller.handleHumanUtterance("question"));
  await waitFor(() => input); await controller.cancel();
  assert.equal(input.pan, -.2); assert.deepEqual(cancelled, [input.request_id]);
  assert.equal((await result).error.name, "AbortError"); assert.equal(controller.active, false);
});

test("cascade stop also aborts text generation, so it cannot admit delayed speech after stop", async t => {
  let entered = false;
  const f = await fixture(t, () => { entered = true; });
  const controller = new CascadeController({
    roster: [{ name: "agent", model: "fixture-model" }],
    runTurn: makeCascadeRunTurn({ defaultBaseUrl: f.options("tts").daemonUrl, envRead: () => undefined }),
    speak: () => assert.fail("cancelled generation must not submit speech"),
  });
  const result = observed(controller.handleHumanUtterance("question"));
  await waitFor(() => entered); await controller.cancel();
  assert.equal((await result).error.name, "AbortError"); assert.equal(controller.active, false);
  assert.equal(f.requests.length, 1);
});

for (const capable of [false, true]) {
  test(`STT batch abort negotiates request identity (capable=${capable})`, async t => {
    let input;
    const f = await fixture(t, (row, res) => {
      if (row.operation === "stt.transcribe") { input = row.input; return; }
      assert.equal(row.operation, "stt.transcribe.cancel");
      reply(res, { status: "batch", batch: { id: row.input.id, state: "cancelled" } });
    });
    if (!capable) f.capabilities.stt = [];
    const abort = new AbortController();
    const result = observed(transcribeDaemonAudio(pcmToWav(PCM), { ...f.options("stt"), signal: abort.signal }));
    await waitFor(() => input); abort.abort();
    const { error } = await result;
    assert.equal(Object.hasOwn(input, "request_id"), capable);
    assert.equal(error.name, "AbortError"); assert.equal(error.remotePending, !capable);
    assert.equal(error.cancellation.outcome, capable ? "cancelled" : "unsupported");
    assert.deepEqual(f.commands().map(c => c.operation), capable ? ["stt.transcribe", "stt.transcribe.cancel"] : ["stt.transcribe"]);
    if (capable) assert.equal(f.commands()[1].input.id, input.request_id);
  });
}

test("STT cancellation before admission uses its known ID and recognizes the tombstone", async t => {
  let input;
  const f = await fixture(t, (row, res) => { if (row.operation === "stt.transcribe") input = row.input; else errorReply(res, "not_found"); });
  const abort = new AbortController();
  const result = observed(transcribeDaemonAudio(pcmToWav(PCM), { ...f.options("stt"), requestId: "stt-owned", signal: abort.signal }));
  await waitFor(() => input); abort.abort();
  const { error } = await result;
  assert.equal(error.cancellation.outcome, "not_admitted"); assert.equal(error.remotePending, false);
  assert.deepEqual(f.commands()[1].input, { id: "stt-owned" });
});

test("capable STT correlates successful transcripts and never silently accepts another job's result", async t => {
  let mismatch = false;
  const f = await fixture(t, (row, res) => reply(res, { status: "transcript", id: mismatch ? "wrong" : row.input.request_id, transcript: { text: "fixture" } }));
  assert.equal(await transcribeDaemonAudio(pcmToWav(PCM), f.options("stt")), "fixture");
  mismatch = true;
  await assert.rejects(transcribeDaemonAudio(pcmToWav(PCM), f.options("stt")), /invalid transcript receipt/);
  assert.deepEqual(f.commands().map(c => c.operation), ["stt.transcribe", "stt.transcribe"]);
});

test("already aborted speech sends neither discovery nor admission; STT timeout never resubmits or cancels", async t => {
  const f = await fixture(t, () => {});
  const abort = new AbortController(); abort.abort();
  await assert.rejects(requestDaemonTts("unused", { ...f.options("tts"), signal: abort.signal }), { name: "AbortError" });
  await assert.rejects(transcribeDaemonAudio(pcmToWav(PCM), { ...f.options("stt"), signal: abort.signal }), { name: "AbortError" });
  assert.equal(f.requests.length, 0);
  await assert.rejects(transcribeDaemonAudio(pcmToWav(PCM), { ...f.options("stt"), timeoutMs: 250 }), /timed out/);
  assert.deepEqual(f.commands().map(c => c.operation), ["stt.transcribe"]);
});

test("queue policy and pan are runtime/startup settings; pending ownership is bounded", async () => {
  const config = applyReadConfigValues(defaultReadConfig({}), { provider: "daemon", interrupt: "false", pan: "0" }, {});
  assert.equal(config.pan, 0); assert.equal(config.panSource, "explicit"); assert.equal(speechReplacesPrevious(config), false);
  assert.equal(speechReplacesPrevious({ provider: "daemon", interrupt: true }), true);
  assert.equal(speechReplacesPrevious({ provider: "daemon", playback: "local" }), true);
  assert.equal(speechReplacesPrevious({ provider: "azure" }), true);
  const env = resolveAgentTtsSettings({ env: { PI_TTS_PROVIDER: "daemon", PI_TTS_PAN: "-.8", PI_TTS_INTERRUPT: "true" } }).config;
  assert.equal(env.pan, -.8); assert.equal(env.interrupt, true);
  assert.equal(applyReadConfigValues(config, { pan: "none" }, {}).pan, null);
  const requests = createSpeechRequests({ maxPending: 2 });
  const one = requests.start({ provider: "daemon" }); const two = requests.start({ provider: "daemon" });
  assert.throws(() => requests.start({ provider: "daemon" }), /too many pending/);
  const stopped = requests.cancel();
  assert.equal(one.signal.aborted, true); assert.equal(two.signal.aborted, true);
  one.finish(); two.finish(); await stopped; assert.equal(requests.size, 0);
});
