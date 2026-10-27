// Voice input run by pi-daemon (extensions/durable/voice.mjs, bd-6ffaf9): /call, /stt and /ptt
// record each session's microphone with its own device= and server=, find speech with TUI /stt's
// VAD, transcribe it and submit each turn as the user's message. A call hangs up on silence or
// end_call; the call's state and settings are one session document every client follows.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  DEFAULT_HANGUP_AFTER_MS,
  VOICE_DOC,
  VOICE_TASK,
  createVoiceCommands,
  createVoiceTask,
  createVoiceTools,
  defaultCapture,
  parseDurationMs,
  voiceSettings,
} from "../extensions/lib/durable-voice.js";
import { sttEnvUpdates } from "../extensions/lib/stt-session-values.js";

const clone = (value) => JSON.parse(JSON.stringify(value ?? null));

/** A Durable session as far as voice input uses it: its document, tasks, watches and conversation. */
function durable(sessionId) {
  const docs = new Map();
  const tasks = [];
  const watchers = new Set();
  const submitted = [];
  let next = 0;
  const tx = {
    async doc(token) {
      if (!docs.has(token.definition.kind)) docs.set(token.definition.kind, token.definition.initial());
      return docs.get(token.definition.kind);
    },
    async createTask(task, input, options) {
      const id = `${sessionId}-t${++next}`;
      tasks.push({ record: { id, kind: task.definition.name, conversationId: options.conversationId, input, background: options.background, state: { status: "running", checkpoint: task.definition.initial(input) } } });
      return id;
    },
  };
  const doc = () => clone(docs.get(VOICE_DOC.definition.kind));
  const notify = () => { const value = doc(); for (const watcher of [...watchers]) watcher(value); };
  const commit = async (change) => {
    const result = await change(tx);
    notify();
    return clone(result);
  };
  /** A task invocation's runtime over this session. */
  const runtime = (record) => ({
    taskId: record.id,
    conversationId: record.conversationId,
    signal: new AbortController().signal,
    async commit(change) {
      const state = await change(tx, record);
      if (state) record.state = state;
      notify();
    },
    async watchDoc() {
      let listener;
      const entry = (value) => listener?.(value);
      return { value: doc(), start(fn) { listener = fn; watchers.add(entry); }, async stop() { watchers.delete(entry); } };
    },
    async conversation() {
      return { async submit(input) { submitted.push(input); } };
    },
  });
  return { tasks, commit, doc, runtime, submitted };
}

function commandContext(store, sessionId) {
  const notices = [];
  return {
    notices,
    ctx: {
      sessionId,
      conversationId: `${sessionId}-c1`,
      context: {},
      notify: (text) => notices.push(text),
      harness: { commit: (change) => store.commit(change), inspect: async () => ({ tasks: store.tasks }) },
    },
  };
}

/** Fake microphones: each capture is a process whose stdout the test feeds PCM. */
function microphones() {
  const opened = [];
  const capture = ({ env, streamName, sessionId }) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    Object.assign(proc, { env, streamName, sessionId, killed: false, kill() { proc.killed = true; } });
    opened.push(proc);
    return proc;
  };
  return { opened, capture };
}

/** 100 ms of PCM16 at 24 kHz: loud (speech) or silent. */
const frame = (amplitude) => {
  const buffer = Buffer.alloc(4800);
  for (let i = 0; i < 2400; i++) buffer.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  return buffer;
};
const say = (proc, { speech = 5, silence = 0 } = {}) => {
  for (let i = 0; i < speech; i++) proc.stdout.emit("data", frame(8000));
  for (let i = 0; i < silence; i++) proc.stdout.emit("data", frame(0));
};

async function until(check, label) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

function setup({ env = {}, persisted = {}, speaking = () => false } = {}) {
  let clock = 1_000_000;
  const mics = microphones();
  const heard = [];
  const timers = new Set();
  const task = createVoiceTask({
    env: { PATH: "/bin", ...env },
    persisted,
    capture: mics.capture,
    transcribe: async (pcm, options) => {
      heard.push({ bytes: pcm.length, source: options.env.PULSE_SOURCE, server: options.env.PULSE_SERVER, model: options.model, provider: options.provider });
      return "hello agent";
    },
    speaking,
    now: () => clock,
    setInterval: (fn) => { const timer = { fn }; timers.add(timer); return timer; },
    clearInterval: (timer) => timers.delete(timer),
    log: () => {},
  });
  const commands = createVoiceCommands({ task, now: () => clock });
  const tools = createVoiceTools({ task, now: () => clock });
  return {
    task, commands, tools, mics, heard, timers,
    advance(ms) { clock += ms; for (const timer of [...timers]) timer.fn(); },
    /** Run a session's voice task, as the worker does: until the call ends. */
    run(store) {
      const { record } = store.tasks.at(-1);
      assert.equal(record.kind, VOICE_TASK);
      return task.definition.phases.live(record, store.runtime(record), {});
    },
  };
}

test("/call holds a call per session, each recording its own device= and server=, and submits what is said", async () => {
  const voice = setup({ persisted: { provider: "openai", model: "whisper-settings" } });
  const one = durable("s1");
  const two = durable("s2");
  const a = commandContext(one, "s1");
  const b = commandContext(two, "s2");

  await voice.commands.call.run("device=mic-a server=tcp:mac:4713 commit=500 insert=200", a.ctx);
  await voice.commands.call.run("vad device=mic-b model=whisper-session commit=500 insert=200", b.ctx);
  assert.match(a.notices.at(-1), /^started · call:on · vad · listening · device:mic-a · server:tcp:mac:4713 · provider:openai · model:whisper-settings/);
  assert.match(b.notices.at(-1), /^started · call:on · vad · listening · device:mic-b · server:default · provider:openai · model:whisper-session/);
  assert.deepEqual(one.doc().settings, { device: "mic-a", server: "tcp:mac:4713", commit: "500", insert: "200" });
  assert.equal(one.tasks[0].record.background, true);
  assert.deepEqual(one.tasks[0].record.input, { sessionId: "s1", startedAt: 1_000_000 });

  // Both calls run at once in one worker; each microphone opens with its session's settings.
  const ended = [voice.run(one), voice.run(two)];
  await until(() => voice.mics.opened.length === 2, "both microphones");
  const [micA, micB] = voice.mics.opened;
  assert.deepEqual([micA.env.PULSE_SOURCE, micA.env.PULSE_SERVER, micB.env.PULSE_SOURCE, micB.env.PULSE_SERVER], ["mic-a", "tcp:mac:4713", "mic-b", undefined]);
  assert.equal(micA.env.PATH, "/bin", "the worker's environment under the session's");
  assert.equal(process.env.PULSE_SOURCE === "mic-a", false, "process.env is never changed");

  say(micA, { speech: 5, silence: 8 });
  await until(() => one.submitted.length === 1, "s1's turn");
  assert.deepEqual(one.submitted[0], { type: "input", content: "hello agent", whenBusy: "followUp", requestId: "voice:s1-t1:1" });
  assert.equal(two.submitted.length, 0, "s2 heard nothing");
  assert.ok(voice.heard.every((entry) => entry.source === "mic-a" && entry.model === "whisper-settings"));
  await until(() => one.doc().call.sent === 1 && one.doc().call.phase === "listening", "s1's call back to listening");
  assert.equal(one.doc().call.partial, null);
  assert.deepEqual(one.tasks[0].record.state.checkpoint, { phase: "live", sent: 1 });

  say(micB, { speech: 5, silence: 8 });
  await until(() => two.submitted.length === 1, "s2's turn");
  assert.equal(voice.heard.at(-1).source, "mic-b");
  assert.equal(voice.heard.at(-1).model, "whisper-session", "a session's model= over settings.json's");

  // New settings on a live call reopen its microphone with them.
  await voice.commands.call.run("device=mic-c", a.ctx);
  assert.match(a.notices.at(-1), /^\/call: settings applied · call:on · vad · .*device:mic-c/);
  await until(() => voice.mics.opened.length === 3, "s1's microphone reopened");
  assert.equal(micA.killed, true);
  assert.equal(voice.mics.opened[2].env.PULSE_SOURCE, "mic-c");

  await voice.commands.call.run("hangup", a.ctx);
  assert.equal(a.notices.at(-1), "call ended");
  assert.equal(await ended[0], undefined);
  assert.equal(one.doc().call, null);
  assert.deepEqual(one.doc().last, { kind: "call", mode: "vad", startedAt: 1_000_000, endedAt: 1_000_000, reason: "hung up", sent: 1 });
  assert.equal(voice.mics.opened[2].killed, true);
  assert.notEqual(two.doc().call, null, "s2's call goes on");
  await voice.commands.call.run("status", a.ctx);
  assert.match(a.notices.at(-1), /^voice:off · device:mic-c · .* · last call ended \(hung up\) 0s ago, 1 sent$/);

  await voice.commands.call.run("end", b.ctx);
  await ended[1];
  assert.equal(two.doc().call, null);
});

test("/call talk is push-to-talk from any client: the microphone opens, then what was said is sent; cancel drops it", async () => {
  const voice = setup();
  const store = durable("s");
  const { ctx, notices } = commandContext(store, "s");

  await voice.commands.call.run("talk", ctx);
  assert.equal(notices.at(-1), "🎙 talking: /call talk again to send");
  assert.equal(store.doc().call.mode, "ptt");
  const ended = voice.run(store);
  await until(() => voice.mics.opened.length === 1, "the microphone");
  await until(() => store.doc().call.phase === "on-air", "on air");
  say(voice.mics.opened[0], { speech: 6 });
  // A second client presses talk: what was said is sent, and the microphone closes.
  const second = commandContext(store, "s");
  await voice.commands.call.run("talk", second.ctx);
  assert.equal(second.notices.at(-1), "sent");
  await until(() => store.submitted.length === 1, "the turn");
  assert.equal(store.submitted[0].content, "hello agent");
  assert.equal(voice.mics.opened[0].killed, true);
  await until(() => store.doc().call.phase === "armed", "armed for the next press");

  await voice.commands.call.run("talk", ctx);
  await until(() => voice.mics.opened.length === 2, "the microphone again");
  say(voice.mics.opened[1], { speech: 6 });
  await voice.commands.call.run("cancel", ctx);
  assert.equal(notices.at(-1), "cancelled: nothing sent");
  await until(() => voice.mics.opened[1].killed, "the microphone closed");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(store.submitted.length, 1, "nothing sent");

  await voice.commands.call.run("off", ctx);
  await ended;
  assert.equal(store.doc().last.reason, "hung up");
});

test("a call hangs up after hangup_after without speech, or when the agent calls end_call; dictation does not time out", async () => {
  const voice = setup();
  const store = durable("s");
  const { ctx, notices } = commandContext(store, "s");
  await voice.commands.call.run("", ctx);
  let ended = voice.run(store);
  await until(() => voice.mics.opened.length === 1, "the microphone");
  voice.advance(DEFAULT_HANGUP_AFTER_MS - 1000);
  assert.ok(store.doc().call, "not yet");
  voice.advance(1000);
  await ended;
  assert.equal(store.doc().last.reason, "silence");

  await voice.commands.call.run("hangup_after=30s", ctx);
  ended = voice.run(store);
  voice.advance(29_000);
  assert.ok(store.doc().call);
  const [endCall] = voice.tools;
  assert.equal(endCall.name, "end_call");
  const api = { commit: (change) => store.commit(change) };
  assert.deepEqual((await endCall.execute({ reason: "not for me" }, api, {})).output, [{ type: "text", text: "Call ended." }]);
  await ended;
  assert.equal(store.doc().last.reason, "agent hung up");
  assert.deepEqual((await endCall.execute({}, api, {})).output, [{ type: "text", text: "No call is live." }]);

  await voice.commands.stt.run("", ctx);
  assert.match(notices.at(-1), /^started · stt:on · vad · listening/);
  ended = voice.run(store);
  voice.advance(60 * 60_000);
  assert.ok(store.doc().call, "dictation stays on");
  await voice.commands.stt.run("off", ctx);
  assert.equal(notices.at(-1), "stt ended");
  await ended;
});

test("input is muted while the session's own speech plays, or when muted", async () => {
  let talking = true;
  const voice = setup({ speaking: (sessionId) => talking && sessionId === "s" });
  const store = durable("s");
  const { ctx } = commandContext(store, "s");
  await voice.commands.call.run("commit=500 insert=200", ctx);
  const ended = voice.run(store);
  await until(() => voice.mics.opened.length === 1, "the microphone");
  say(voice.mics.opened[0], { speech: 5, silence: 8 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(voice.heard.length, 0, "its own speech is not transcribed");
  talking = false;
  await voice.commands.call.run("mute", ctx);
  await until(() => store.doc().call.phase === "muted", "muted");
  say(voice.mics.opened[0], { speech: 5, silence: 8 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(voice.heard.length, 0);
  await voice.commands.call.run("unmute", ctx);
  say(voice.mics.opened[0], { speech: 5, silence: 8 });
  await until(() => store.submitted.length === 1, "heard once unmuted");
  await voice.commands.call.run("hangup", ctx);
  await ended;
});

test("settings are checked before they are kept, and settings.json and the environment are the defaults", async () => {
  const voice = setup({ env: { PULSE_SERVER: "tcp:env:4713" }, persisted: { provider: "openai", model: "from-settings" } });
  const store = durable("s");
  const { ctx, notices } = commandContext(store, "s");
  await voice.commands.call.run("mode=sideways", ctx);
  assert.equal(notices.at(-1), "/call: mode must be vad or ptt");
  await voice.commands.call.run("bogus=1", ctx);
  assert.equal(notices.at(-1), "/call: unknown setting 'bogus'");
  await voice.commands.call.run("energy=7", ctx);
  assert.equal(notices.at(-1), "/call: energy must be between 0 and 1");
  await voice.commands.call.run("device=bad\u0007name", ctx);
  assert.match(notices.at(-1), /^\/call: device must be a Pulse name/);
  assert.deepEqual(store.doc()?.settings ?? {}, {}, "nothing kept");
  assert.equal(store.tasks.length, 0, "nothing started");
  await voice.commands.call.run("status", ctx);
  assert.match(notices.at(-1), /^voice:off · device:default · server:tcp:env:4713 · provider:openai · model:from-settings$/);
  await voice.commands.ptt.run("server=tcp:session:4713 mode=ptt", ctx);
  assert.match(notices.at(-1), /^started · stt:on · ptt · armed · device:default · server:tcp:session:4713/);
  await voice.commands.call.run("server=", ctx);
  assert.match(notices.at(-1), /server:tcp:env:4713/, "an empty value removes the session's own");
  await voice.commands.call.run("sideways", ctx);
  assert.match(notices.at(-1), /^\/call: unknown 'sideways'/);
});

test("the session overlay is TUI /stt's mapping; device= and server= reach the capture command", () => {
  const env = { PI_STT_PROVIDER: "azure", PI_STT_MODEL: "old" };
  assert.deepEqual(sttEnvUpdates({ provider: "openai", energy: "0.02", language: "en" }, { env }), {
    updates: { PI_STT_PROVIDER: "openai", PI_STT_LANGUAGE: "en", PI_RT_LOCAL_VAD_ENERGY_THRESHOLD: "0.02" },
    clear: ["PI_RT_LOCAL_VAD_MODEL", "PI_STT_MODEL", "PI_STT_ENDPOINT", "PI_STT_PROMPT", "PI_STT_STREAMING_MODEL"],
  });
  assert.throws(() => sttEnvUpdates({ device: "x" }), /\/stt: unknown setting 'device'/, "TUI /stt keeps its keys");
  const resolved = voiceSettings({ provider: "openai", device: "mic", hangup_after: "90s", deliver: "steer" }, { env });
  assert.equal(resolved.env.PI_STT_MODEL, undefined, "a provider change forgets the old provider's model");
  assert.deepEqual([resolved.device, resolved.hangupAfterMs, resolved.deliver, resolved.mode], ["mic", 90_000, "steer", "vad"]);
  assert.deepEqual([parseDurationMs("5m"), parseDurationMs("off"), parseDurationMs("2"), parseDurationMs("soon")], [300_000, 0, 2000, null]);

  const spawned = [];
  const spawnImpl = (command, args, options) => { spawned.push({ command, args, env: options.env }); return new EventEmitter(); };
  defaultCapture({ env: { PULSE_SOURCE: "mic", PULSE_SERVER: "tcp:mac:4713" }, executables: { pacat: "/nix/pacat" }, streamName: "pi-call-s", spawnImpl });
  assert.deepEqual(spawned[0].args, ["--record", "--raw", "--format=s16le", "--rate=24000", "--channels=1", "--stream-name=pi-call-s", "--device=mic", "--server=tcp:mac:4713"]);
  assert.equal(spawned[0].command, "/nix/pacat");
  defaultCapture({ env: { PI_RT_RECORD_CMD: "my-recorder", PULSE_SOURCE: "mic" }, executables: { pacat: "/nix/pacat" }, streamName: "x", spawnImpl });
  assert.deepEqual([spawned[1].command, spawned[1].args, spawned[1].env.PULSE_SOURCE], ["/bin/sh", ["-c", "my-recorder"], "mic"]);
});

test("pi-client shows the focused session's call as the speech chip and a status line, the same in every client", async () => {
  const { default: voiceClient, voiceIndicator, voiceStatusLine } = await import("../extensions/durable/voice-client.js");
  const { SPEECH_INDICATOR_EVENT } = await import("../extensions/lib/speech-indicator.js");
  const call = { kind: "call", mode: "vad", phase: "on-air", muted: false, sent: 2, partial: "turn the lights\non please", error: null, end: null };
  const doc = { settings: { device: "mic-a", server: "tcp:mac:4713" }, call };
  assert.equal(voiceStatusLine(doc), "☎ call · vad · on-air · mic-a @ tcp:mac:4713 · 2 sent · “turn the lights on please”");
  assert.deepEqual(voiceIndicator(doc), { phase: "on-air", surface: "CALL", hint: "", transcribing: false });
  assert.deepEqual(voiceIndicator({ call: { ...call, mode: "ptt", phase: "armed" } }), { phase: "armed", surface: "CALL", hint: "/call talk", transcribing: false });
  assert.deepEqual(voiceIndicator({ call: { ...call, kind: "stt", mode: "ptt", phase: "on-air" } }), { phase: "on-air", surface: "PTT", hint: "talk again: send", transcribing: false });
  assert.equal(voiceIndicator({ call: { ...call, muted: true } }).phase, "muted");
  assert.equal(voiceStatusLine({ settings: {}, call: null }), undefined);

  // Two clients of one session draw the same.
  const clients = [0, 1].map(() => {
    const handlers = new Map();
    const bus = new Map();
    const chips = [];
    const statuses = [];
    const watches = [];
    const pi = {
      on: (name, handler) => handlers.set(name, handler),
      events: { on: (name, listener) => { bus.set(name, [...(bus.get(name) ?? []), listener]); return () => {}; }, emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) },
    };
    pi.events.on(SPEECH_INDICATOR_EVENT, (state) => chips.push({ phase: state.phase, surface: state.surface, hint: state.hint }));
    voiceClient(pi);
    const ctx = {
      sessionManager: { getSessionId: () => "s" },
      ui: { setStatus: (key, text) => statuses.push([key, text]) },
      chord: { async watchDocument(address, onValue) { watches.push({ address, onValue }); return () => {}; } },
    };
    handlers.get("session_start")({}, ctx);
    return { chips, statuses, watches };
  });
  await new Promise((resolve) => setImmediate(resolve));
  for (const client of clients) {
    assert.deepEqual(client.watches.map((watch) => watch.address), [{ kind: "agent-utils.voice", version: 1, scope: "session" }]);
    assert.deepEqual(client.chips, [], "no chip without a call: the local /stt keeps it");
    client.watches[0].onValue(doc);
    client.watches[0].onValue({ ...doc, call: null });
  }
  assert.deepEqual(clients[0].chips, [{ phase: "on-air", surface: "CALL", hint: "" }, { phase: "disabled", surface: "", hint: "" }]);
  assert.deepEqual(clients[1].chips, clients[0].chips);
  assert.deepEqual(clients[0].statuses.slice(-2), [["agent-utils-voice", "☎ call · vad · on-air · mic-a @ tcp:mac:4713 · 2 sent · “turn the lights on please”"], ["agent-utils-voice", undefined]]);
  assert.deepEqual(clients[1].statuses, clients[0].statuses);
});

test("Ctrl-Space sends /ptt talk to the focused session's daemon when it runs voice input", async () => {
  const { default: voiceClient } = await import("../extensions/durable/voice-client.js");
  const { offerDaemonPtt } = await import("../extensions/lib/voice-ptt.js");
  const handlers = new Map();
  const bus = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    events: { on: (name, listener) => { bus.set(name, [...(bus.get(name) ?? []), listener]); return () => {}; }, emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) },
  };
  voiceClient(pi);
  const calls = [];
  const sessionCommands = { voice: [{ name: "tts" }, { name: "call" }, { name: "ptt" }], plain: [{ name: "tts" }] };
  let current = "voice";
  const ctx = {
    sessionManager: { getSessionId: () => current },
    ui: { setStatus() {}, notify() {} },
    chord: {
      async call(method, params) {
        if (method === "session.commands") return { items: sessionCommands[current] };
        calls.push({ session: current, method, content: params.content, requestId: params.requestId });
        return { command: "ptt", status: "done" };
      },
      async watchDocument() { return () => {}; },
    },
  };
  assert.equal(offerDaemonPtt(pi), false, "no session yet");
  handlers.get("session_start")({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(offerDaemonPtt(pi), true);
  assert.equal(offerDaemonPtt(pi), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map(({ session, method, content }) => [session, method, content]), [["voice", "conversation.submit", "/ptt talk"], ["voice", "conversation.submit", "/ptt talk"]]);
  assert.notEqual(calls[0].requestId, calls[1].requestId, "each press is its own request");

  current = "plain";
  handlers.get("session_start")({}, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(offerDaemonPtt(pi), false, "a daemon without voice input: the press stays local");
  assert.equal(calls.length, 2);
});
