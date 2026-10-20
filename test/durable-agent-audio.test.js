// Durable adaptor tests for /tts, /narrate and ask_user choice audio (bd-832b7a).
//
// A fake host implements the pi-daemon extension-module contract: commands run
// with { sessionId, conversationId, notify, state }, observe sees frozen agent
// events with { sessionId, conversationId, state }, and state is per-session
// per-module durable JSON. Speech goes to a stub provider, never to audio.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
function fakeHost({ store = durableStore(), env = baseEnv(), speech, choices, withState = true, modelRegistry, ...options } = {}) {
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
    find: (provider, id) => (provider === "github-copilot" && id === "gpt-6-luna" ? { provider, id } : undefined),
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
  assert.equal(requests[0].model, "github-copilot/gpt-6-luna");
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
    assert.equal(record.agent, "session-s1");
    assert.equal(record.host, "fixture-node");
  }
  assert.equal(records.find((r) => r.kind === "tts").text, "Shipped.");
  assert.match(records.find((r) => r.kind === "choices").text, /^Ship it\? Option 1: yes/);

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
  assert.match(second.notifications.at(-1).text, /^narrate:on · phases:after · model:github-copilot\/gpt-6-luna · speed:tts · style:cheerful · styledegree:1.4 · reasoning-summaries:off/);
  await second.emit("s1", assistantEnd([text("Restored.")]));
  assert.deepEqual(second.spoken.map(({ text }) => text), ["Agent: Restored."]);
});

test("command errors reply through notify and change nothing", async () => {
  const host = fakeHost();
  await host.command("s1", "/narrate text=on");
  assert.match(host.notifications.at(-1).text, /^\/narrate: text= is not available in Durable sessions/);
  await host.command("s1", "/narrate phases=sideways");
  assert.match(host.notifications.at(-1).text, /phases must be before, after or both/);
  await host.command("s1", "/tts focus on");
  assert.match(host.notifications.at(-1).text, /^\/tts: focus and solo/);
  assert.equal(await host.store.forSession("s1").get(DURABLE_AUDIO_SETTINGS_KEY), undefined);
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
