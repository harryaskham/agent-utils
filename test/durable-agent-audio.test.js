// Durable adaptor tests for /tts, /narrate and ask_user choice audio (bd-832b7a).
//
// A fake host implements the pi-daemon extension-module contract: commands run
// with { sessionId, conversationId, notify, state }, observe sees frozen agent
// events with { sessionId, conversationId, state }, and state is per-session
// per-module durable JSON. Speech goes to a stub provider, never to audio.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  createDurableAgentAudio,
  describeToolBatch,
  durableSpeechValues,
  speechReadiness,
  DURABLE_AUDIO_SETTINGS_KEY,
} from "../extensions/lib/durable-agent-audio.js";
import { createAgentSpeechController } from "../extensions/lib/tts-narration.js";

const tmp = mkdtempSync(join(tmpdir(), "durable-audio-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const baseEnv = () => ({
  PATH: process.env.PATH,
  PI_TTS_MUTE_PATH: join(tmp, `mute-${Math.random().toString(36).slice(2)}.json`),
  PI_TTS_FEED_PATH: join(tmp, `feed-${Math.random().toString(36).slice(2)}.jsonl`),
  // Hermetic: never import the machine's legacy speech feed into the fixture's.
  PI_TTS_QUEUE_DIR: join(tmp, `queue-${Math.random().toString(36).slice(2)}`),
  PI_TTS_PROVIDER: "azure",
  AZURE_SPEECH_API_KEY: "fixture-key",
  AZURE_SPEECH_ENDPOINT: "https://example.invalid",
});

/** Durable state shared across "worker restarts": the store outlives the module. */
function durableStore() {
  const data = new Map();
  return {
    data,
    forSession(sessionId) {
      return {
        async get(key) { const raw = data.get(`${sessionId}\0${key}`); return raw === undefined ? undefined : JSON.parse(raw); },
        async set(key, value) { data.set(`${sessionId}\0${key}`, JSON.stringify(value)); },
      };
    },
  };
}

function stubSpeech(log, sessionId) {
  let config = { provider: "azure", voice: "stub-voice", speed: 1, backend: "pulse" };
  return {
    async speak(text, overrides = {}) { log.push({ sessionId, kind: overrides.speechKind, text, overrides }); return { interrupted: false }; },
    async interrupt(options) { log.push({ sessionId, interrupt: options?.kind ?? "all" }); },
    dispose() {},
    getConfig: () => ({ ...config }),
    setConfig(next) { config = { ...next }; return { ...config }; },
    apply(values) { config = { ...config, ...values }; return { ...config }; },
  };
}

/** A fake pi-daemon worker: one module instance over a durable store. */
function fakeHost({ store = durableStore(), env = baseEnv(), speech, choices, withState = true, modelRegistry, cwd, ...options } = {}) {
  const spoken = speech || [];
  const choiceLog = choices || [];
  const notifications = [];
  const audio = createDurableAgentAudio({
    env,
    persistedSettings: {},
    createSpeech: ({ sessionId }) => stubSpeech(spoken, sessionId),
    createChoiceSpeech: ({ sessionId }) => ({ async speak(text) { choiceLog.push({ sessionId, text }); return {}; }, interrupt() {}, dispose() {} }),
    which: () => "/bin/true",
    log: () => {},
    ...options,
  });
  const ctx = (sessionId) => ({
    sessionId,
    conversationId: `${sessionId}-c1`,
    ...(withState ? { state: store.forSession(sessionId) } : {}),
    ...(modelRegistry ? { modelRegistry } : {}),
    ...(cwd ? { cwd } : {}),
  });
  return {
    audio,
    store,
    spoken,
    choiceLog,
    notifications,
    async command(sessionId, line) {
      const [, name, args = ""] = /^\/(\S+)\s*(.*)$/s.exec(line);
      const command = audio.commands[name];
      assert.ok(command, `no /${name} command`);
      assert.equal(typeof command.description, "string");
      return command.run(args, { ...ctx(sessionId), notify: (text) => notifications.push({ sessionId, text }) });
    },
    ctx,
    async emit(sessionId, event) {
      await audio.observe(Object.freeze(event), Object.freeze(ctx(sessionId)));
      await audio.idle();
    },
  };
}

let entrySeq = 0;
function assistantEnd(content, { id = `e${++entrySeq}`, timestamp = Date.now(), api } = {}) {
  return { type: "message_end", entry: { id, conversationId: "c1", kind: "message", model: [{ role: "assistant", content, timestamp, ...(api ? { api } : {}) }] } };
}
const text = (value) => ({ type: "text", text: value });
const toolCall = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const toolStart = (toolCallId, toolName, args = {}) => ({ type: "tool_execution_start", toolCallId, toolName, args });
const toolEnd = (toolCallId, toolName, isError = false) => ({ type: "tool_execution_end", toolCallId, toolName, entry: { id: `r-${toolCallId}`, kind: "tool_result", model: [{ role: "toolResult", toolCallId, toolName, isError, content: [text("ok")] }] } });

test("/tts on then a message_end speaks the final answer exactly once", async () => {
  const host = fakeHost();
  await host.command("s1", "/tts on");
  assert.match(host.notifications.at(-1).text, /^tts:on · provider:azure/);
  const event = assistantEnd([text("The build is green.")]);
  await host.emit("s1", event);
  await host.emit("s1", event); // the same event delivered twice
  assert.deepEqual(host.spoken.map(({ kind, text }) => ({ kind, text })), [{ kind: "tts", text: "The build is green." }]);
  assert.equal(host.spoken[0].overrides.streamName, "/tts");
});

test("/tts is off by default and /tts off silences and interrupts", async () => {
  const host = fakeHost();
  await host.emit("s1", assistantEnd([text("Nobody asked for audio.")]));
  assert.equal(host.spoken.length, 0);
  await host.command("s1", "/tts on");
  await host.command("s1", "/tts off");
  assert.match(host.notifications.at(-1).text, /^tts:off/);
  assert.deepEqual(host.spoken.at(-1), { sessionId: "s1", interrupt: "tts" });
  await host.emit("s1", assistantEnd([text("Still quiet.")]));
  assert.equal(host.spoken.filter((item) => item.kind).length, 0);
});

test("toggles are per session", async () => {
  const host = fakeHost();
  await host.command("a", "/tts on");
  await host.emit("a", assistantEnd([text("For a.")]));
  await host.emit("b", assistantEnd([text("For b.")]));
  assert.deepEqual(host.spoken.map((item) => [item.sessionId, item.text]), [["a", "For a."]]);
});

test("/narrate speaks tool batches per phase mode", async () => {
  const host = fakeHost();
  await host.command("s1", "/narrate on");
  assert.match(host.notifications.at(-1).text, /^narrate:on · phases:before/);
  await host.emit("s1", assistantEnd([toolCall("t1", "bash", { command: "ls" }), toolCall("t2", "read", { path: "x" })]));
  await host.emit("s1", toolStart("t1", "bash", { command: "ls" }));
  await host.emit("s1", toolStart("t2", "read", { path: "x" }));
  await host.emit("s1", toolEnd("t1", "bash"));
  await host.emit("s1", toolEnd("t2", "read"));
  assert.deepEqual(host.spoken.map(({ kind, text }) => [kind, text]), [["narrate", "Running bash and read."]]);

  await host.command("s1", "/narrate phases=both speed=1.5");
  host.spoken.length = 0;
  await host.emit("s1", assistantEnd([text("Let me check the tests first."), toolCall("t3", "bash")]));
  await host.emit("s1", toolStart("t3", "bash"));
  await host.emit("s1", toolEnd("t3", "bash", true));
  assert.deepEqual(host.spoken.map(({ kind, text }) => [kind, text]), [
    ["narrate", "Let me check the tests first."],
    ["narrate", "bash failed."],
  ]);
  assert.equal(host.spoken[0].overrides.speed, 1.5);
  assert.equal(host.spoken[0].overrides.streamName, "/narrate");

  await host.command("s1", "/narrate after");
  host.spoken.length = 0;
  await host.emit("s1", assistantEnd([toolCall("t4", "edit")]));
  await host.emit("s1", toolStart("t4", "edit"));
  await host.emit("s1", toolEnd("t4", "edit"));
  assert.deepEqual(host.spoken.map(({ text }) => text), ["Finished edit."]);
});

test("/narrate infers its sentences with the host's models, as TUI narration does (bd-06d998)", async () => {
  // pi-daemon passes observers info.modelRegistry (Pi's ctx.modelRegistry): find and complete.
  const requests = [];
  const reply = (value) => ({ role: "assistant", content: [{ type: "text", text: value }], stopReason: "stop" });
  const modelRegistry = {
    find: (provider, id) => (provider === "github-copilot" && id === "gpt-6.1-terra" ? { provider, id } : undefined),
    async complete(model, context, options) {
      const payload = JSON.parse(context.messages[0].content[0].text);
      requests.push({ model: `${model.provider}/${model.id}`, payload, maxTokens: options.maxTokens });
      return reply(payload.phase === "before" ? "I'm listing the tools folder to find the build script." : "The build script lives in tools/build.sh.");
    },
  };
  const host = fakeHost({ modelRegistry });
  await host.command("s1", "/narrate on");
  await host.command("s1", "/narrate phases=both");
  await host.emit("s1", assistantEnd([toolCall("t1", "bash", { command: "ls tools" })]));
  await host.emit("s1", toolStart("t1", "bash", { command: "ls tools" }));
  await host.emit("s1", { ...toolEnd("t1", "bash"), result: { content: [{ type: "text", text: "build.sh\nrelease.sh" }] } });
  assert.deepEqual(host.spoken.map(({ text }) => text), ["I'm listing the tools folder to find the build script.", "The build script lives in tools/build.sh."]);
  assert.equal(requests[0].model, "github-copilot/gpt-6.1-terra");
  assert.deepEqual(requests[0].payload, { phase: "before", tools: [{ name: "bash", arguments: { command: "ls tools" } }] });
  assert.equal(requests[1].payload.phase, "after");
  assert.match(requests[1].payload.results[0].text, /build\.sh/);

  // The main model's own preamble is spoken as is: no side completion for the before line.
  host.spoken.length = 0;
  requests.length = 0;
  await host.emit("s1", assistantEnd([text("Let me check the tests first."), toolCall("t2", "bash")]));
  await host.emit("s1", toolEnd("t2", "bash"));
  assert.deepEqual(host.spoken.map(({ text }) => text), ["Let me check the tests first.", "The build script lives in tools/build.sh."]);
  assert.deepEqual(requests.map((request) => request.payload.phase), ["after"]);

  // A newer batch supersedes the side completion of an older one still running.
  host.spoken.length = 0;
  modelRegistry.complete = async (model, context, options) => {
    const payload = JSON.parse(context.messages[0].content[0].text);
    if (payload.tools?.[0]?.arguments?.command === "slow") {
      await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return reply(payload.phase === "before" ? "I'm reading the fast file." : "Done.");
  };
  await host.command("s1", "/narrate phases=before");
  await host.audio.observe(assistantEnd([toolCall("t3", "bash", { command: "slow" })]), host.ctx("s1"));
  await host.emit("s1", assistantEnd([toolCall("t4", "read", { path: "fast" })]));
  assert.deepEqual(host.spoken.map(({ text }) => text), ["I'm reading the fast file."]);

  // A failing completion falls back to the deterministic line, and status reports it.
  host.spoken.length = 0;
  modelRegistry.complete = async () => { throw new Error("rate limited"); };
  await host.emit("s1", assistantEnd([toolCall("t5", "bash")]));
  assert.deepEqual(host.spoken.map(({ text }) => text), ["Running bash."]);
  await host.command("s1", "/narrate status");
  assert.match(host.notifications.at(-1).text, /narrate inference: rate limited/);

  // /narrate model= picks the narration model.
  await host.command("s1", "/narrate model=github-copilot/gpt-6-mini");
  assert.match(host.notifications.at(-1).text, /model:github-copilot\/gpt-6-mini/);
  await host.command("s1", "/narrate model=nonsense");
  assert.match(host.notifications.at(-1).text, /model must be provider\/id/);
});

test("/narrate covers a tool whose assistant message was coalesced away", async () => {
  const host = fakeHost();
  await host.command("s1", "/narrate on");
  await host.emit("s1", toolStart("lonely", "web_search", { query: "secret" }));
  assert.deepEqual(host.spoken.map(({ text }) => text), ["Running web search."]);
});

test("/narrate off silences tool narration and keeps /tts for final answers", async () => {
  const host = fakeHost();
  await host.command("s1", "/tts on");
  await host.command("s1", "/narrate on");
  // With narration on, a preamble beside tool calls is narration, not /tts.
  await host.emit("s1", assistantEnd([text("Checking."), toolCall("t1", "bash")]));
  assert.deepEqual(host.spoken.map(({ kind }) => kind), ["narrate"]);
  await host.command("s1", "/narrate off");
  assert.deepEqual(host.spoken.at(-1), { sessionId: "s1", interrupt: "narrate" });
  host.spoken.length = 0;
  await host.emit("s1", toolStart("t9", "bash"));
  await host.emit("s1", assistantEnd([text("Done.")]));
  assert.deepEqual(host.spoken.map(({ kind, text }) => [kind, text]), [["tts", "Done."]]);
});

test("ask_user start speaks the question and its choices once", async () => {
  const host = fakeHost();
  const args = { question: "Which branch should I merge?", choices: ["main", "release"] };
  await host.emit("s1", assistantEnd([toolCall("q1", "ask_user", args)]));
  await host.emit("s1", toolStart("q1", "ask_user", args));
  await host.emit("s1", toolStart("q1", "ask_user", args));
  assert.deepEqual(host.choiceLog, [{ sessionId: "s1", text: "Which branch should I merge? Option 1: main Option 2: release Selected: main." }]);
  // ask_user is choice audio, never narrated as a tool.
  await host.command("s1", "/narrate on");
  await host.emit("s1", assistantEnd([toolCall("q2", "ask_user", { question: "Free text?" })]));
  await host.emit("s1", toolStart("q2", "ask_user", { question: "Free text?" }));
  assert.equal(host.spoken.length, 0);
  assert.equal(host.choiceLog.at(-1).text, "Free text?");

  await host.command("s1", "/tts choices=off");
  await host.emit("s1", toolStart("q3", "ask_user", { question: "Quiet?" }));
  assert.equal(host.choiceLog.length, 2);
});

test("spoken lines reach the node's TTS feed that ag tts and ag dash read", async () => {
  const env = { ...baseEnv(), CACO_NODE: "fixture-node" };
  const host = fakeHost({ env });
  await host.command("s1", "/tts on");
  await host.command("s1", "/narrate on");
  await host.emit("s1", assistantEnd([toolCall("t1", "bash", { command: "ls" })]));
  await host.emit("s1", toolStart("t1", "bash"));
  await host.emit("s1", toolStart("q1", "ask_user", { question: "Ship it?", choices: ["yes", "no"] }));
  await host.emit("s1", assistantEnd([text("Shipped.")]));
  const records = readFileSync(env.PI_TTS_FEED_PATH, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ kind }) => kind).sort(), ["choices", "narrate", "tts"]);
  for (const record of records) {
    assert.equal(record.version, 1);
    assert.equal(record.session, "s1");
    assert.equal(record.agent, "session-s1", "no directory known: named by session");
    assert.equal(record.host, "fixture-node");
  }
  assert.equal(records.find((r) => r.kind === "tts").text, "Shipped.");
  assert.match(records.find((r) => r.kind === "choices").text, /^Ship it\? Option 1: yes/);

  // With the session's directory (pi-daemon passes it), the agent is named as
  // the session's media shares are, so ag shows one agent per session.
  const named = { ...baseEnv(), CACO_NODE: "fixture-node" };
  const inDir = fakeHost({ env: named, cwd: "/work/agent-utils" });
  await inDir.command("s3", "/tts on");
  await inDir.emit("s3", assistantEnd([text("Named.")]));
  const [namedRecord] = readFileSync(named.PI_TTS_FEED_PATH, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(namedRecord.agent, "pi-daemon-agent-utils");
  assert.equal(namedRecord.session, "s3");
  assert.equal(namedRecord.cwd, "/work/agent-utils");

  // Incognito sessions never write the feed.
  const quiet = { ...baseEnv(), PI_INCOGNITO: "1" };
  const incognito = fakeHost({ env: quiet });
  await incognito.command("s2", "/tts on");
  await incognito.emit("s2", assistantEnd([text("Secret.")]));
  assert.throws(() => readFileSync(quiet.PI_TTS_FEED_PATH), { code: "ENOENT" });
});

test("a replayed event is not re-spoken after a worker restart", async () => {
  const store = durableStore();
  const first = fakeHost({ store });
  await first.command("s1", "/tts on");
  await first.command("s1", "/narrate on");
  const answer = assistantEnd([text("Spoken before the restart.")]);
  const batch = assistantEnd([toolCall("t1", "bash")]);
  await first.emit("s1", answer);
  await first.emit("s1", batch);
  await first.emit("s1", toolStart("q1", "ask_user", { question: "Ready?", choices: ["yes", "no"] }));
  assert.equal(first.spoken.length + first.choiceLog.length, 3);
  await first.audio.dispose();

  // A new module instance (worker restart) over the same durable store.
  const second = fakeHost({ store });
  await second.emit("s1", answer);
  await second.emit("s1", batch);
  await second.emit("s1", toolStart("t1", "bash"));
  await second.emit("s1", toolStart("q1", "ask_user", { question: "Ready?", choices: ["yes", "no"] }));
  assert.equal(second.spoken.length + second.choiceLog.length, 0);
  await second.emit("s1", assistantEnd([text("New after restart.")]));
  assert.deepEqual(second.spoken.map(({ text }) => text), ["New after restart."]);
});

test("events older than module load are skipped when the host has no durable state", async () => {
  const loadedAt = Date.now();
  const host = fakeHost({ withState: false, loadedAt, replayGraceMs: 1000 });
  await host.command("s1", "/tts on");
  assert.match(host.notifications.at(-1).text, /in-memory: host has no durable state/);
  await host.emit("s1", assistantEnd([text("Old news.")], { timestamp: loadedAt - 60_000 }));
  await host.emit("s1", assistantEnd([text("Fresh.")], { timestamp: loadedAt + 10 }));
  assert.deepEqual(host.spoken.map(({ text }) => text), ["Fresh."]);
});

test("settings round-trip through durable state and survive a restart", async () => {
  const store = durableStore();
  const first = fakeHost({ store });
  await first.command("s1", "/tts voice=en-GB-Test speed=1.25 prefix='Agent: ' api_key=literal-secret");
  await first.command("s1", "/narrate phases=after style=cheerful styledegree=1.4 reasoning_summaries=off");
  const saved = await store.forSession("s1").get(DURABLE_AUDIO_SETTINGS_KEY);
  assert.equal(saved.tts.enabled, true);
  assert.equal(saved.tts.prefix, "Agent: ");
  assert.equal(saved.tts.speech.voice, "en-GB-Test");
  assert.equal(saved.tts.speech.speed, "1.25");
  assert.ok(!JSON.stringify([...store.data.values()]).includes("literal-secret"), "literal keys never reach durable state");
  assert.deepEqual({ enabled: saved.narrate.enabled, phases: saved.narrate.phases, style: saved.narrate.style, styleDegree: saved.narrate.styleDegree, reasoningSummaries: saved.narrate.reasoningSummaries },
    { enabled: true, phases: "after", style: "cheerful", styleDegree: 1.4, reasoningSummaries: false });

  const second = fakeHost({ store });
  await second.command("s1", "/narrate status");
  assert.match(second.notifications.at(-1).text, /^narrate:on · phases:after · model:github-copilot\/gpt-6.1-terra · speed:tts · style:cheerful · styledegree:1.4 · reasoning-summaries:off/);
  await second.emit("s1", assistantEnd([text("Restored.")]));
  assert.deepEqual(second.spoken.map(({ text }) => text), ["Agent: Restored."]);
});

test("command errors reply through notify and change nothing", async () => {
  const host = fakeHost();
  await host.command("s1", "/narrate text=on");
  assert.match(host.notifications.at(-1).text, /^\/narrate: text= is not available in Durable sessions/);
  await host.command("s1", "/narrate phases=sideways");
  assert.match(host.notifications.at(-1).text, /phases must be before, after or both/);
  await host.command("s1", "/tts focus sideways");
  assert.match(host.notifications.at(-1).text, /^\/tts: Usage: \/tts focus \[on\|off\|toggle\|status\]/);
  assert.equal(await host.store.forSession("s1").get(DURABLE_AUDIO_SETTINGS_KEY), undefined);
});

/** A speech output routing that records its calls: focus and solo, no Pulse. */
function fakeRouting(sessionId, calls) {
  let focus = false, solo = false;
  const snapshot = () => ({ focus, solo, mode: solo ? "solo" : focus ? "focus" : "normal",
    focusOutput: focus ? { device: "vsink_focus" } : null, soloOutput: solo ? { sink: `pi_${sessionId}` } : null, cleanupPending: false, error: null });
  return {
    snapshot,
    assertPlayable() {},
    async setMode(mode, enabled, options) {
      calls.push({ sessionId, mode, enabled, identity: options.identity, base: options.base.voice });
      const on = enabled === undefined ? !(mode === "focus" ? focus : solo) : enabled;
      if (mode === "focus") focus = on; else solo = on;
      return snapshot();
    },
    async acquire(options) { return { options, mode: snapshot().mode, release() {} }; },
    async shutdown() { calls.push({ sessionId, shutdown: true }); focus = false; solo = false; return snapshot(); },
  };
}

test("/tts focus and solo route each session's speech on its own, and are kept across a restart", async () => {
  const calls = [];
  const routings = new Map();
  const createRouting = ({ sessionId }) => { const routing = fakeRouting(sessionId, calls); routings.set(sessionId, routing); return routing; };
  const given = [];
  const host = fakeHost({
    createRouting,
    createSpeech: ({ sessionId, routing }) => { given.push({ sessionId, routing }); return stubSpeech(host.spoken, sessionId); },
  });
  await host.command("s1", "/tts focus on");
  assert.equal(host.notifications.at(-1).text, "audio:focus · focus:on · solo:off · sink:vsink_focus · server:inherit");
  await host.command("s2", "/tts solo");
  assert.match(host.notifications.at(-1).text, /^audio:solo · focus:off · solo:on · sink:pi_s2/);
  await host.command("s1", "/tts focus status");
  assert.match(host.notifications.at(-1).text, /^audio:focus · focus:on · solo:off/, "s2's solo left s1 alone");
  assert.deepEqual(given.map(({ sessionId, routing }) => [sessionId, routing === routings.get(sessionId)]), [["s1", true], ["s2", true]], "each session's speech has its own routing");
  assert.deepEqual(calls.map(({ sessionId, mode, enabled, identity, base }) => [sessionId, mode, enabled, identity.session, base]),
    [["s1", "focus", true, "s1", "stub-voice"], ["s2", "solo", undefined, "s2", "stub-voice"]]);
  assert.deepEqual((await host.store.forSession("s1").get(DURABLE_AUDIO_SETTINGS_KEY)).tts.routing, { focus: true, solo: false });
  assert.deepEqual((await host.store.forSession("s2").get(DURABLE_AUDIO_SETTINGS_KEY)).tts.routing, { focus: false, solo: true });

  // A restarted worker: each session's routing comes back as it was.
  await host.audio.dispose();
  assert.deepEqual(calls.filter((call) => call.shutdown).map((call) => call.sessionId).sort(), ["s1", "s2"], "dispose ends every session's routing");
  calls.length = 0;
  const restarted = fakeHost({ store: host.store, createRouting });
  await restarted.command("s2", "/tts status");
  await restarted.command("s1", "/tts focus off");
  assert.deepEqual(calls.map(({ sessionId, mode, enabled }) => [sessionId, mode, enabled]), [["s2", "solo", true], ["s1", "focus", true], ["s1", "focus", false]]);
  assert.match(restarted.notifications.at(-1).text, /^audio:normal · focus:off · solo:off/);
  assert.deepEqual((await restarted.store.forSession("s1").get(DURABLE_AUDIO_SETTINGS_KEY)).tts.routing, { focus: false, solo: false });
});

test("missing credentials or playback degrade quietly with one notify", async () => {
  const env = { PATH: "", PI_TTS_MUTE_PATH: join(tmp, "mute-missing.json"), PI_TTS_PROVIDER: "openai" };
  const logs = [];
  const speech = [];
  const host = fakeHost({
    env,
    which: () => null,
    log: (line) => logs.push(line),
    createSpeech: ({ sessionId }) => ({ ...stubSpeech(speech, sessionId), async speak() { throw new Error("openai: OPENAI_API_KEY is not set"); } }),
  });
  const reply = await host.command("s1", "/tts on");
  assert.match(reply, /warning: speech unavailable on this host \(credentials api-key:missing; playback needs pacat on PATH\)/);
  assert.equal(host.notifications.length, 1);
  await host.emit("s1", assistantEnd([text("One.")]));
  await host.emit("s1", assistantEnd([text("Two.")]));
  assert.equal(logs.length, 1, "a failing provider is logged once, not per event");
  await host.command("s1", "/tts status");
  assert.match(host.notifications.at(-1).text, /last-error:tts: openai: OPENAI_API_KEY is not set/);
});

test("the real speech controller reaches a stub provider and stub player", async () => {
  const env = baseEnv();
  const synthesized = [];
  const played = [];
  const host = fakeHost({
    env,
    createSpeech: ({ config }) => createAgentSpeechController({
      env,
      initialConfig: config,
      synthesize: async (body, options) => { synthesized.push({ body, voice: options.voice, streamName: options.streamName }); return Buffer.alloc(4); },
      player: { async play(pcm, output) { played.push({ bytes: pcm.length, streamName: output.streamName }); return { interrupted: false }; }, interrupt() {}, isPlaying: () => false },
    }),
  });
  await host.command("s1", "/tts voice=en-GB-SoniaNeural");
  await host.emit("s1", assistantEnd([text("Hello from the daemon host.")]));
  assert.deepEqual(synthesized, [{ body: "Hello from the daemon host.", voice: "en-GB-SoniaNeural", streamName: "/tts" }]);
  assert.deepEqual(played, [{ bytes: 4, streamName: "/tts" }]);
});

test("helpers: deterministic tool lines, secret filtering, readiness", () => {
  assert.equal(describeToolBatch(["bash"]), "Running bash.");
  assert.equal(describeToolBatch(["a", "b", "c", "d", "e"]), "Running a, b and 3 more tools.");
  assert.equal(describeToolBatch(["x", "y"], "after", { failed: ["x", "y"] }), "2 tools failed.");
  assert.deepEqual(durableSpeechValues({ voice: "v", api_key: "literal", apikey: "$OPENAI_API_KEY" }), { voice: "v", apikey: "$OPENAI_API_KEY" });
  assert.deepEqual(speechReadiness({ provider: "azure", backend: "pulse" }, { env: { AZURE_SPEECH_API_KEY: "k" }, which: () => "/x" }), []);
  assert.deepEqual(speechReadiness({ provider: "command", command: "" }, { env: {} }), ["provider=command has no command"]);
});

test("the adaptor module imports no Pi TUI API and exports the module contract", async () => {
  const source = readFileSync(new URL("../extensions/durable/tts.mjs", import.meta.url), "utf8")
    + readFileSync(new URL("../extensions/durable/tts-module.js", import.meta.url), "utf8")
    + readFileSync(new URL("../extensions/lib/durable-agent-audio.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /pi-tui|pi-coding-agent|ExtensionAPI|ctx\.ui/);
  // Load in a child so the module's process-wide instance does not leak into this run.
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const m = await import(${JSON.stringify(new URL("../extensions/durable/tts.mjs", import.meta.url).href)});
    const notes = [];
    await m.commands.tts.run("status", { sessionId: "probe", notify: (t) => notes.push(t) });
    console.log(JSON.stringify({ commands: Object.keys(m.commands), observe: typeof m.observe, note: notes[0] }));
  `], { encoding: "utf8", env: { ...baseEnv(), HOME: tmp, PI_CODING_AGENT_DIR: join(tmp, "agent") }, timeout: 20_000 });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout.trim().split("\n").at(-1));
  assert.deepEqual(result.commands, ["tts", "narrate"]);
  assert.equal(result.observe, "function");
  assert.match(result.note, /^tts:off/);
});

test("each session gets its own pool voice and stereo pan, over a configured default voice (as TUI /tts)", async () => {
  const { resolveSessionSpeechAssignment, resolveSessionSpeechPolicy } = await import("../extensions/lib/tts-identity.js");
  const configs = new Map();
  const controllers = new Map();
  const persisted = { provider: "azure", voice: "configured-voice", embedding: "configured-embedding" };
  const host = fakeHost({
    persistedSettings: { tts: persisted },
    createSpeech: ({ sessionId, config }) => {
      configs.set(sessionId, config);
      const controller = stubSpeech([], sessionId);
      controller.setConfig(config);
      controllers.set(sessionId, controller);
      return controller;
    },
  });
  const policy = resolveSessionSpeechPolicy(persisted, baseEnv());
  for (const sessionId of ["session-a", "session-b"]) {
    await host.command(sessionId, "/tts on");
    const config = configs.get(sessionId);
    const assignment = resolveSessionSpeechAssignment(sessionId, policy);
    assert.equal(config.voice, assignment.voice, `${sessionId} speaks with its pool voice`);
    assert.equal(config.embedding, null, "the configured embedding belongs to the configured voice");
    assert.equal(config.pan, assignment.pan);
    assert.equal(config.panSource, "session");
  }
  assert.notEqual(configs.get("session-a").pan, configs.get("session-b").pan);
  // A voice chosen for the session itself still wins.
  await host.command("session-c", "/tts voice=en-GB-SoniaNeural");
  assert.equal(controllers.get("session-c").getConfig().voice, "en-GB-SoniaNeural");
});

test("the spoken ledger stores long keys short, and finds them however they are asked", async () => {
  const { SpokenLedger, ledgerKey, DURABLE_AUDIO_LEDGER_LIMIT } = await import("../extensions/lib/durable-agent-audio.js");
  // A Copilot tool call id: an id and an opaque suffix of hundreds of characters.
  const id = (n) => `call_${n}|${"lAk67UjIlAeoxtu9Ms7Rg2x4xMcF+".repeat(16)}${n}`;
  const ledger = new SpokenLedger();
  for (let n = 0; n < DURABLE_AUDIO_LEDGER_LIMIT; n += 1) ledger.add(`start:${id(n)}`);
  assert.equal(ledger.has(`start:${id(7)}`), true);
  assert.equal(ledger.has(`start:${id(DURABLE_AUDIO_LEDGER_LIMIT)}`), false);
  assert.ok([...ledger].every((key) => key.length <= 64), "stored short");
  assert.ok(JSON.stringify([...ledger]).length < 20_000, `a full ledger is small: ${JSON.stringify([...ledger]).length}`);
  assert.equal(ledgerKey("short:key"), "short:key");
  assert.equal(ledgerKey(ledgerKey(`start:${id(1)}`)), ledgerKey(`start:${id(1)}`), "stored keys stay as they are");
  // A ledger saved before, with long keys, still matches.
  const loaded = new SpokenLedger([`start:${id(3)}`]);
  assert.equal(loaded.has(`start:${id(3)}`), true);
  loaded.delete(`start:${id(3)}`);
  assert.equal(loaded.size, 0);
});

test("a host session environment selects each session's startup speech defaults", async () => {
  const spoken = [];
  const environments = new Map([
    ["managed", { CACO_AGENT_ID: "managed-agent", PULSE_SERVER: "managed:4713" }],
    ["pebble", { CACO_AGENT_ID: "pebble", PI_TTS_ENABLED: "1", PI_NARRATE_ENABLED: "1", PULSE_SERVER: "phone:4713" }],
  ]);
  const reads = [];
  const created = [];
  const host = fakeHost({
    speech: spoken,
    sessionEnv: ({ sessionId }) => environments.get(sessionId) ?? {},
    readPersistedSettings: (env) => {
      reads.push(env.CACO_AGENT_ID ?? "personal");
      return { tts: { enabled: !env.CACO_AGENT_ID }, narrate: { enabled: !env.CACO_AGENT_ID } };
    },
    createSpeech: ({ sessionId, env }) => {
      created.push({ sessionId, agent: env.CACO_AGENT_ID, pulse: env.PULSE_SERVER, enabled: env.PI_TTS_ENABLED });
      return stubSpeech(spoken, sessionId);
    },
  });

  await host.emit("managed", assistantEnd([text("Managed agents stay quiet.")]));
  await host.emit("pebble", assistantEnd([text("Pebble asked to speak.")]));
  await host.emit("personal", assistantEnd([text("Personal sessions keep settings defaults.")]));
  assert.deepEqual(spoken.map(({ sessionId, text }) => [sessionId, text]), [
    ["pebble", "Pebble asked to speak."],
    ["personal", "Personal sessions keep settings defaults."],
  ]);
  assert.deepEqual(reads, ["managed-agent", "pebble", "personal"]);
  assert.deepEqual(created, [
    { sessionId: "managed", agent: "managed-agent", pulse: "managed:4713", enabled: undefined },
    { sessionId: "pebble", agent: "pebble", pulse: "phone:4713", enabled: "1" },
    { sessionId: "personal", agent: undefined, pulse: undefined, enabled: undefined },
  ]);

  await host.command("managed", "/tts status");
  assert.match(host.notifications.at(-1).text, /^tts:off/);
  await host.command("managed", "/tts on");
  await host.emit("managed", assistantEnd([text("Explicitly enabled.")]));
  assert.equal(spoken.at(-1).text, "Explicitly enabled.");
});

test("a rewritten session environment reloads that session's defaults", async () => {
  const spoken = [];
  const environment = { CACO_AGENT_ID: "agent" };
  let reads = 0;
  const host = fakeHost({
    speech: spoken,
    sessionEnv: () => environment,
    readPersistedSettings: () => { reads += 1; return {}; },
  });
  await host.emit("s1", assistantEnd([text("Before opt-in.")]));
  await host.emit("s1", assistantEnd([text("Still before opt-in.")]));
  assert.equal(reads, 1, "settings special forms run once for an unchanged session environment");
  environment.PI_TTS_ENABLED = "1";
  await host.emit("s1", assistantEnd([text("After opt-in.")]));
  assert.equal(reads, 2);
  assert.deepEqual(spoken.map(({ text }) => text), ["After opt-in."]);
});

test("the module factory evaluates settings special forms with a session environment", () => {
  const agentDir = join(tmp, `agent-${Math.random().toString(36).slice(2)}`);
  const settingsPath = join(agentDir, "settings.json");
  const sessionEnvPath = join(tmp, `session-${Math.random().toString(36).slice(2)}.env`);
  spawnSync("mkdir", ["-p", agentDir]);
  writeFileSync(settingsPath, JSON.stringify({
    agentUtils: {
      globalShellExpansion: { enabled: true },
      tts: { enabled: { $boolCommand: "[[ -z \"${CACO_AGENT_ID:-}\" ]]" } },
      narrate: { enabled: { $boolCommand: "[[ -z \"${CACO_AGENT_ID:-}\" ]]" } },
    },
  }));
  writeFileSync(sessionEnvPath, "CACO_AGENT_ID=managed\n");
  const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { readFileSync } from "node:fs";
    const { createDurableTtsModule, readDurableAudioSettings } = await import(${JSON.stringify(new URL("../extensions/durable/tts-module.js", import.meta.url).href)});
    const personal = readDurableAudioSettings(process.env);
    const managed = readDurableAudioSettings({ ...process.env, CACO_AGENT_ID: "managed" });
    const audio = createDurableTtsModule({
      instanceKey: Symbol("probe"),
      sessionEnv: () => Object.fromEntries(readFileSync(${JSON.stringify(sessionEnvPath)}, "utf8").trim().split("\\n").map((line) => line.split("="))),
    });
    const notes = [];
    await audio.commands.tts.run("status", { sessionId: "managed", notify: (value) => notes.push(value) });
    console.log(JSON.stringify({ personal: personal.tts.enabled, managed: managed.tts.enabled, status: notes[0] }));
  `], { encoding: "utf8", env: { ...baseEnv(), HOME: tmp, PI_CODING_AGENT_DIR: agentDir }, timeout: 20_000 });
  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout.trim().split("\n").at(-1));
  assert.equal(result.personal, true);
  assert.equal(result.managed, false);
  assert.match(result.status, /^tts:off/);
});
