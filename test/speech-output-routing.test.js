import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createPulseSinks, pulsePropertiesArgument, SOLO_OWNER_PROPERTY } from "../extensions/lib/pulse-sinks.js";
import { createSpeechOutputRouting, bindSpeechOutputRouting, soloSinkIdentity, withSpeechOutputRouting } from "../extensions/lib/speech-output-routing.js";
import { createAgentSpeechController } from "../extensions/lib/tts-narration.js";
import { createReadModeController } from "../extensions/read-aloud.js";
import { createChoiceSpeaker } from "../extensions/lib/choice.js";
import { createTtsNarrationExtension } from "../extensions/tts-narration.js";
import { playTtsCommand } from "../extensions/lib/tts-command.js";
import { createInterruptiblePcmPlayer } from "../extensions/lib/tts.js";
import { MachineTtsQueue, TTS_QUEUE_SYMBOL } from "../extensions/lib/tts-queue.js";

const identity = { agent: "android improvements", session: "session-1", host: "fixture" };
const base = { backend: "pulse", server: "regular:4713", device: "vsink_voice" };
const waitFor = async predicate => { const end = Date.now() + 4000; while (!predicate()) { assert.ok(Date.now() < end, "fixture did not settle"); await new Promise(r => setTimeout(r, 2)); } };

function fakePulse() {
  const servers = new Map(), calls = [];
  let failLoad = false, loseLoadReply = false, loseUnloadReply = false, badJson = false, uncertainLoad = false;
  const server = key => {
    key ||= "default";
    if (!servers.has(key)) servers.set(key, { sinks: [], modules: [], inputs: [], next: 1 });
    return servers.get(key);
  };
  const add = (host, name, owner, description = name) => {
    const s = server(host), id = s.next++;
    const sink = { index: id, name, owner_module: id, properties: { "device.description": description, ...(owner ? { [SOLO_OWNER_PROPERTY]: owner } : {}) } };
    s.sinks.push(sink); s.modules.push({ index: id, name: "module-null-sink" });
    return sink;
  };
  const execFileImpl = (command, argv, options, callback) => {
    const args = [...argv];
    const host = args[0] === "--server" ? (args.shift(), args.shift()) : "default";
    calls.push({ command, args, host, env: options.env, options });
    queueMicrotask(() => {
      const s = server(host);
      if (args[0] === "--format=json") {
        const rows = ({ sinks: s.sinks, modules: s.modules, "sink-inputs": s.inputs })[args[2]];
        callback(null, badJson ? "not-json" : JSON.stringify(rows), "");
      } else if (args[0] === "list" && args[1] === "short" && args[2] === "modules") callback(null, s.modules.map(m => `${m.index}\t${m.name}\tfixture`).join("\n"), "");
      else if (args[0] === "get-default-sink") callback(null, s.sinks[0]?.name || "", "");
      else if (args[0] === "load-module") {
        const name = args.find(a => a.startsWith("sink_name=")).slice(10);
        const owner = args.find(a => a.startsWith("sink_properties="))?.match(/agent\.utils\.solo\.owner="([A-Za-z0-9-]+)"/)?.[1];
        if (uncertainLoad) callback(Object.assign(new Error("timed out"), { killed: true }), "", "");
        else if (failLoad || s.sinks.some(v => v.name === name)) callback(Object.assign(new Error("load failed"), { code: 1 }), "", "Failure: Module initialization failed");
        else {
          const sink = add(host, name, owner);
          callback(loseLoadReply ? Object.assign(new Error("lost reply"), { killed: true }) : null, loseLoadReply ? "" : `${sink.owner_module}\n`, "");
        }
      } else if (args[0] === "unload-module") {
        const id = Number(args[1]); s.modules = s.modules.filter(v => v.index !== id); s.sinks = s.sinks.filter(v => v.owner_module !== id);
        callback(loseUnloadReply ? new Error("lost unload reply") : null, "", "");
      } else callback(new Error(`unexpected command ${args[0]}`), "", "");
    });
  };
  const pulse = createPulseSinks({ execFileImpl, env: { PATH: "/fixture", PULSE_SERVER: "ambient:4713", PULSE_COOKIE: "/fixture/cookie", TTS_DAEMON_TOKEN: "not-for-pactl", OPENAI_API_KEY: "not-for-pactl" } });
  return { pulse, calls, server, add,
    loadCalls: () => calls.filter(c => c.args[0] === "load-module"),
    unloadCalls: () => calls.filter(c => c.args[0] === "unload-module"),
    set failure(value) { failLoad = value; }, set lostLoad(value) { loseLoadReply = value; }, set lostUnload(value) { loseUnloadReply = value; }, set invalidJson(value) { badJson = value; }, set uncertain(value) { uncertainLoad = value; },
  };
}
function routing(f) { return createSpeechOutputRouting({ pulse: f.pulse, env: {}, cleanupWait: async () => {} }); }

test("focus overlays routing without mutating normal settings or cleaning its shared sink", async () => {
  const f = fakePulse(), r = routing(f);
  const original = { ...base };
  const focused = { backend: "pulse", server: "phone:4713", sink: "vsink_focus", pan: 0 };
  const on = await r.setMode("focus", true, { base, focus: focused });
  assert.equal(on.mode, "focus"); assert.equal(f.loadCalls().length, 1);
  await withSpeechOutputRouting(r, { ...base, pan: -.5 }, options => {
    assert.equal(options.server, "phone:4713"); assert.equal(options.device, "vsink_focus"); assert.equal(options.pan, 0);
  });
  await r.setMode("focus", true, { base, focus: focused });
  assert.equal(f.loadCalls().length, 1, "on is idempotent");
  await r.setMode("focus", false);
  await withSpeechOutputRouting(r, base, options => assert.deepEqual(options, original));
  await r.shutdown();
  assert.equal(f.unloadCalls().length, 0); assert.equal(f.server("phone:4713").sinks.length, 1);
  assert.deepEqual(base, original);
});

test("solo wins over focus, returns to focus, and unloads only its tagged module", async () => {
  const f = fakePulse(), r = routing(f);
  await r.setMode("focus", true, { base, focus: { server: "phone:4713", sink: "vsink_focus" } });
  const state = await r.setMode("solo", true, { base, identity });
  assert.equal(state.soloOutput.description, "pi - android improvements");
  assert.match(state.soloOutput.sink, /^pi_android_improvements_[a-f0-9]{10}$/);
  assert.equal(state.soloOutput.server, "phone:4713"); assert.equal(state.soloOutput.owned, true);
  await withSpeechOutputRouting(r, base, opts => assert.equal(opts.device, state.soloOutput.sink));
  await r.setMode("solo", false);
  assert.equal(f.unloadCalls().length, 1);
  assert.equal(Number(f.unloadCalls()[0].args[1]), state.soloOutput.moduleId);
  assert.equal(r.snapshot().mode, "focus"); assert.equal(f.server("phone:4713").sinks[0].name, "vsink_focus");
  await r.setMode("focus", false); await r.shutdown();
  assert.equal(f.unloadCalls().length, 1);
});

test("pre-existing focus and solo sinks are reused, never claimed or unloaded", async () => {
  const f = fakePulse(), r = routing(f);
  f.add(base.server, "vsink_focus", "somebody-else");
  const name = soloSinkIdentity(identity).name;
  f.add(base.server, name, "other-instance");
  await r.setMode("focus", true, { base });
  const on = await r.setMode("solo", true, { base, identity });
  assert.equal(on.soloOutput.owned, false);
  await r.setMode("solo", false); await r.shutdown();
  assert.equal(f.loadCalls().length, 0); assert.equal(f.unloadCalls().length, 0);
});

test("a solo sink reused as focus becomes shared and is never cleaned up", async () => {
  const f = fakePulse(), r = routing(f);
  const on = await r.setMode("solo", true, { base, identity });
  await r.setMode("focus", true, { base, focus: { server: base.server, sink: on.soloOutput.sink } });
  await r.setMode("solo", false);
  await r.shutdown();
  assert.equal(f.unloadCalls().length, 0);
  assert.equal(f.server(base.server).sinks[0].name, on.soloOutput.sink);
});

test("concurrent on commands do not allocate duplicate modules, and a reload starts with modes off", async () => {
  const f = fakePulse(), bus = new EventEmitter();
  const binding = bindSpeechOutputRouting({ events: bus }, { pulse: f.pulse, env: {} });
  await Promise.all(Array.from({ length: 8 }, () => binding.routing.setMode("solo", true, { base, identity })));
  assert.equal(f.loadCalls().length, 1);
  await binding.release(); assert.equal(f.unloadCalls().length, 1);
  const reloaded = bindSpeechOutputRouting({ events: bus }, { pulse: f.pulse, env: {} });
  assert.equal(reloaded.routing.snapshot().mode, "normal");
  await reloaded.release(); assert.equal(f.loadCalls().length, 1);
});

test("active and queued playback leases defer solo cleanup until settled", async () => {
  const f = fakePulse(), r = routing(f);
  await r.setMode("solo", true, { base, identity });
  const first = await r.acquire(base), second = await r.acquire(base);
  const off = await r.setMode("solo", false);
  assert.equal(off.cleanupPending, true); assert.equal(f.unloadCalls().length, 0);
  assert.equal((await r.acquire(base)).options.device, base.device, "new requests immediately use normal routing");
  await first.release(); assert.equal(f.unloadCalls().length, 0);
  await second.release(); await second.release();
  assert.equal(f.unloadCalls().length, 1); assert.equal(r.snapshot().cleanupPending, false);
});

test("foreign playback streams and changed ownership prevent destructive cleanup", async () => {
  const f = fakePulse(), r = routing(f);
  const on = await r.setMode("solo", true, { base, identity });
  const s = f.server(base.server), sink = s.sinks[0];
  s.inputs.push({ index: 1, sink: sink.index });
  const off = await r.setMode("solo", false);
  assert.equal(off.cleanupPending, true); assert.match(off.error, /still has playback/);
  assert.equal(f.unloadCalls().length, 0);
  s.inputs = []; sink.properties[SOLO_OWNER_PROPERTY] = "new-owner";
  await r.setMode("solo", false);
  assert.equal(f.unloadCalls().length, 0);
  assert.equal(s.sinks[0].owner_module, on.soloOutput.moduleId);
  await r.shutdown();
});

test("module-index reuse or a non-null-sink module is never unloaded", async () => {
  for (const mutation of [s => { s.sinks[0].owner_module = 999; }, s => { s.modules[0].name = "module-something-else"; }]) {
    const f = fakePulse(), r = routing(f);
    await r.setMode("solo", true, { base, identity }); mutation(f.server(base.server));
    await r.setMode("solo", false); assert.equal(f.unloadCalls().length, 0);
    await r.shutdown();
  }
});

test("lost create/unload replies are reconciled by ownership without repeating mutations", async () => {
  const f = fakePulse(), r = routing(f); f.lostLoad = true;
  const on = await r.setMode("solo", true, { base, identity });
  assert.equal(on.soloOutput.owned, true); assert.equal(f.loadCalls().length, 1);
  f.lostUnload = true;
  await r.setMode("solo", false);
  assert.equal(f.unloadCalls().length, 1); assert.equal(r.snapshot().cleanupPending, false);
});

test("a definite provisioning rejection leaves the route unchanged and permits an explicit retry", async () => {
  const f = fakePulse(), r = routing(f); f.failure = true;
  await assert.rejects(r.setMode("solo", true, { base, identity }), /failed/);
  assert.equal(r.snapshot().mode, "normal"); assert.equal(r.snapshot().cleanupPending, false);
  f.failure = false;
  await r.setMode("solo", true, { base, identity });
  assert.equal(r.snapshot().solo, true); assert.equal(f.loadCalls().length, 2);
  await r.shutdown(); assert.equal(f.unloadCalls().length, 1);
});

test("failed provisioning is atomic and uncertain creation is not blindly retried", async () => {
  const f = fakePulse(), r = routing(f); f.uncertain = true;
  await assert.rejects(r.setMode("solo", true, { base, identity }), /failed/);
  assert.equal(r.snapshot().mode, "normal"); assert.equal(r.snapshot().cleanupPending, true);
  await assert.rejects(r.setMode("solo", true, { base, identity }), /unconfirmed/);
  assert.equal(f.loadCalls().length, 1);
  await r.setMode("solo", false);
  assert.equal(r.snapshot().cleanupPending, true);
  assert.equal(f.unloadCalls().length, 0);
});

test("invalid focus settings and unsupported backends/providers fail before pactl or speech", async () => {
  const f = fakePulse(), r = routing(f);
  for (const focus of [{ voice: "not-routing" }, { sink: "a", device: "b" }, { pan: 2 }, { backend: "coreaudio" }]) {
    await assert.rejects(r.setMode("focus", true, { base, focus }));
  }
  await assert.rejects(r.setMode("solo", true, { base: { ...base, backend: "sox" }, identity }), /backend=pulse/);
  await assert.rejects(r.setMode("focus", true, { base: { ...base, provider: "daemon" } }), /daemon-owned/);
  assert.equal(f.calls.length, 0);
  await r.setMode("focus", true, { base: { ...base, provider: "daemon", playback: "local" } });
  assert.throws(() => r.assertPlayable({ ...base, provider: "daemon" }), /daemon-owned/);
  await r.shutdown();
});

test("focus can select Pulse over a different normal backend and clear inherited PULSE_SERVER", async () => {
  const f = fakePulse(), r = routing(f);
  await r.setMode("focus", true, { base: { backend: "coreaudio", server: "ambient:4713" }, focus: { backend: "pulse", server: null } });
  assert.equal(f.loadCalls()[0].host, "default");
  assert.equal(f.loadCalls()[0].env.PULSE_SERVER, undefined);
  assert.equal(f.loadCalls()[0].env.PULSE_COOKIE, "/fixture/cookie");
  assert.ok(!Object.values(f.loadCalls()[0].env).includes("not-for-pactl"));
  await r.shutdown();
});

test("session binding shares one mode across extensions but not across Pi buses", async () => {
  const f = fakePulse();
  const bus = new EventEmitter(), otherBus = new EventEmitter();
  const a = bindSpeechOutputRouting({ events: bus }, { pulse: f.pulse, env: {} });
  const b = bindSpeechOutputRouting({ events: bus });
  const other = bindSpeechOutputRouting({ events: otherBus }, { pulse: f.pulse, env: {} });
  assert.equal(a.routing, b.routing);
  await a.routing.setMode("solo", true, { base, identity });
  assert.equal(b.routing.snapshot().solo, true); assert.equal(other.routing.snapshot().mode, "normal");
  await a.release(); assert.equal(f.unloadCalls().length, 0);
  await b.release(); assert.equal(f.unloadCalls().length, 1);
  await other.release();
});

test("distinct Pi-style event facades discover the same controller and release the shared listener", async () => {
  const emitter = new EventEmitter(), f = fakePulse();
  // Pi's loader wraps eventBus in a new object for EACH extension. Its safe
  // handlers are async, but invoke a synchronous discovery callback immediately.
  const facade = () => ({
    emit: (channel, data) => { emitter.emit(channel, data); },
    on: (channel, handler) => {
      const safe = async data => { await handler(data); };
      emitter.on(channel, safe); return () => emitter.off(channel, safe);
    },
  });
  const a = bindSpeechOutputRouting({ events: facade() }, { pulse: f.pulse, env: {} });
  const b = bindSpeechOutputRouting({ events: facade() });
  assert.equal(a.routing, b.routing, "facade identity must not split session routing");
  await a.routing.setMode("focus", true, { base });
  assert.equal(b.routing.snapshot().focus, true);
  assert.equal(emitter.listenerCount("agent-utils:speech-output-routing.v1"), 1);
  await a.release(); await b.release();
  assert.equal(emitter.listenerCount("agent-utils:speech-output-routing.v1"), 0);
});

test("solo identity is bounded, Pulse-safe and collision resistant across sessions/names", () => {
  const one = soloSinkIdentity({ agent: 'Ägent / $(nope) "quoted"\n', session: "one" });
  assert.match(one.name, /^pi_[A-Za-z0-9_.-]+$/); assert.ok(one.name.length < 128);
  assert.ok(!one.description.includes("\n"));
  assert.deepEqual(one, soloSinkIdentity({ agent: 'Ägent / $(nope) "quoted"\n', session: "one" }));
  assert.notEqual(one.name, soloSinkIdentity({ agent: 'Ägent / $(nope) "quoted"\n', session: "two" }).name);
  assert.notEqual(soloSinkIdentity({ agent: "a b", session: "one" }).name, soloSinkIdentity({ agent: "a/b", session: "one" }).name);
  assert.match(pulsePropertiesArgument({ "device.description": 'pi - O\'Brien "quoted"' }), /^sink_properties='/);
});

test("all four speech surfaces use focus overrides, keep their identities, and restore base routing", async t => {
  const root = await mkdtemp(join(tmpdir(), "speech-output-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakePulse(), r = routing(f), plays = [];
  const env = { HOME: root, PI_TTS_BACKEND: "pulse", PULSE_SERVER: base.server, PULSE_SINK: base.device, PI_TTS_FEED_ENABLED: "0" };
  const synthesize = async () => Buffer.alloc(4);
  const player = { interrupt() {}, play: async (_pcm, opts) => { plays.push(opts); return { interrupted: false }; }, dispose() {} };
  const agent = createAgentSpeechController({ env, routing: r, synthesize, player });
  const read = createReadModeController({ env, routing: r, synthesize, player });
  const choices = createChoiceSpeaker({ env, routing: r, synthesize, player });
  try {
    await r.setMode("focus", true, { base, focus: { server: "phone:4713", sink: "vsink_focus" } });
    await agent.speak("tts"); await agent.speak("narrate", { speechKind: "narrate", streamName: "/narrate" });
    await read.speak("read"); await choices.speak("choices");
    assert.deepEqual(plays.map(p => p.streamName), ["/tts", "/narrate", "/read", "/choices"]);
    assert.ok(plays.every(p => p.server === "phone:4713" && p.device === "vsink_focus"));
    await r.setMode("focus", false); await agent.speak("normal");
    assert.equal(plays.at(-1).device, base.device); assert.equal(plays.at(-1).server, base.server);
  } finally { await agent.dispose(); await read.dispose(); await choices.dispose(); await r.shutdown(); }
});

test("/tts focus and solo commands do not enable TTS or persist temporary mode flags", async () => {
  const f = fakePulse(), commands = new Map(), handlers = new Map(), notices = [], entries = [];
  const pi = { events: new EventEmitter(), on: (name, fn) => handlers.set(name, fn), registerCommand: (name, def) => commands.set(name, def), registerMessageRenderer() {}, appendEntry: (...args) => entries.push(args) };
  const binding = bindSpeechOutputRouting(pi, { pulse: f.pulse, env: {} });
  createTtsNarrationExtension({ env: {}, persistedSettings: { tts: { ...base, focus: { server: "phone:4713", sink: "vsink_focus" } }, narrate: {} }, appendFeed() {} })(pi);
  const ctx = { sessionManager: { getSessionId: () => "test-session", getEntries: () => [] }, ui: { notify: (message, level) => notices.push({ message, level }) } };
  const run = args => commands.get("tts").handler(args, ctx);
  await run("focus"); assert.equal(binding.routing.snapshot().focus, true);
  await run("focus on"); assert.equal(f.loadCalls().length, 1);
  await run("focus status"); assert.match(notices.at(-1).message, /audio:focus/);
  await run("solo on"); assert.equal(binding.routing.snapshot().solo, true);
  await run("solo off"); assert.equal(binding.routing.snapshot().mode, "focus");
  await run("focus off"); assert.equal(binding.routing.snapshot().mode, "normal");
  await run("focus banana"); assert.match(notices.at(-1).message, /Usage/);
  assert.equal(pi.ttsNarration.isEnabled(), false); assert.deepEqual(entries, []);
  await handlers.get("session_shutdown")(); await binding.release();
});

test("Pulse-aware command playback receives focus routing without shell rewriting", async t => {
  const root = await mkdtemp(join(tmpdir(), "speech-output-command-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakePulse(), r = routing(f); let childOptions;
  await r.setMode("focus", true, { base, focus: { server: "phone:4713", sink: "vsink_focus" } });
  await withSpeechOutputRouting(r, { ...base, env: { HOME: root, PI_INCOGNITO: "1" }, speechKind: "tts", command: "fixture", spawnImpl: (_cmd, _args, options) => {
    childOptions = options; const p = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
    queueMicrotask(() => p.emit("close", 0)); return p;
  } }, options => playTtsCommand("literal text", options));
  assert.equal(childOptions.env.PULSE_SERVER, "phone:4713"); assert.equal(childOptions.env.PULSE_SINK, "vsink_focus");
  await r.shutdown();
});

test("machine-queued PCM stores only the pinned route, not a routing controller, and holds solo until settlement", async t => {
  const root = await mkdtemp(join(tmpdir(), "speech-output-queue-")); t.after(() => rm(root, { recursive: true, force: true }));
  const f = fakePulse(), r = routing(f); const played = [];
  const queue = new MachineTtsQueue({ root: join(root, "queue"), pollMs: 5, player: { interrupt() {}, play: async (_pcm, opts) => { played.push(opts); return { interrupted: false }; } } });
  const prior = globalThis[TTS_QUEUE_SYMBOL]; globalThis[TTS_QUEUE_SYMBOL] = queue;
  const player = createInterruptiblePcmPlayer({ queue: true });
  let unblock;
  try {
    queue.configure({ maxParallel: 1, overlapMs: 0 });
    const blocker = queue.enqueueTask(() => new Promise(resolve => { unblock = resolve; }));
    await waitFor(() => unblock);
    const on = await r.setMode("solo", true, { base, identity });
    const speech = withSpeechOutputRouting(r, { ...base, env: { HOME: root }, speechKind: "tts" }, opts => player.play(Buffer.alloc(4), opts));
    await waitFor(() => queue.waiters.size === 2 && queue.admitting.size === 0);
    await r.setMode("solo", false);
    assert.equal(r.snapshot().cleanupPending, true); assert.equal(f.unloadCalls().length, 0);
    unblock({ interrupted: false }); await blocker; await speech;
    assert.equal(played[0].device, on.soloOutput.sink); assert.equal(played[0].server, base.server);
    assert.ok(!Object.values(played[0]).some(v => typeof v === "function"));
    assert.equal(f.unloadCalls().length, 1);
  } finally {
    unblock?.({ interrupted: true }); player.dispose(); queue.stop(); globalThis[TTS_QUEUE_SYMBOL] = prior;
    await waitFor(() => !queue.current && !queue.maintenance); await r.shutdown();
  }
});
