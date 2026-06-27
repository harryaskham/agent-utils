import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import realtimeAgentExtension, {
  RealtimeStateController,
  buildServerVadTurnDetection,
  setRealtimeWebSocketConstructor,
  __setLocalVadHooksForTest,
} from "../extensions/realtime-agent.js";
import { EventEmitter } from "node:events";
import { parseEnvStyleArgs } from "../extensions/lib/env-args.js";

class FakeWebSocket {
  static OPEN = 1;
  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.OPEN;
    this.handlers = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.emit("open");
      setTimeout(() => this.emit("message", JSON.stringify({
        type: "session.created",
        session: { type: "realtime", output_modalities: ["text"] },
      })), 0);
    }, 0);
  }

  on(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push({ handler, once: false });
    this.handlers.set(event, list);
  }

  once(event, handler) {
    const list = this.handlers.get(event) || [];
    list.push({ handler, once: true });
    this.handlers.set(event, list);
  }

  off(event, handler) {
    this.handlers.set(event, (this.handlers.get(event) || []).filter((entry) => entry.handler !== handler));
  }

  emit(event, ...args) {
    const list = this.handlers.get(event) || [];
    for (const entry of list) entry.handler(...args);
    this.handlers.set(event, list.filter((entry) => !entry.once));
  }

  send(data) { this.sent.push(JSON.parse(data)); }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

setRealtimeWebSocketConstructor(FakeWebSocket);

// Bounded poll helper shared by the async WebSocket state-machine tests. Many
// assertions below settle after one or more microtasks of async message
// handling; polling a predicate until it is truthy (or a deadline passes) is
// deterministic where a fixed setTimeout sleep is merely a guess that flakes
// under concurrent-reintegration load. Returns the last predicate value so a
// caller can `await waitFor(...)` and then assert on the settled state, keeping
// the original assertion as the authoritative check and failure message.
// (bd-43afce; generalizes the inline poll() landed in bd-b447e1.)
async function waitFor(predicate, { timeoutMs = 1000, intervalMs = 1 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Shared helper for the WSS history-forwarding state-machine tests. Builds a
// RealtimeSession with an already-open fake socket so forwardNewMessages /
// forwardSummaryMessages / forwardMessage can be exercised directly and the
// emitted conversation.item.create payloads inspected. (bd-c360c2)
async function makeForwardingSession() {
  const { __RealtimeSessionForTest } = await import("../extensions/realtime-agent.js");
  const { makeInitialConfig } = await import("../extensions/lib/realtime-config.js");
  const pi = { sendMessage() {}, sendUserMessage() {}, on() {} };
  const session = new __RealtimeSessionForTest(pi, makeInitialConfig());
  const ws = new FakeWebSocket();
  ws.readyState = FakeWebSocket.OPEN;
  session.ws = ws;
  session.connected = true;
  ws.sent.length = 0;
  const items = () => ws.sent.filter((m) => m.type === "conversation.item.create");
  const reset = () => { ws.sent.length = 0; };
  return { session, ws, items, reset };
}

test("RealtimeStateController exposes an explicit realtime lifecycle", () => {
  const state = new RealtimeStateController();
  assert.deepEqual(state.snapshot({ sttOnly: false }), {
    connection: "off",
    connected: false,
    connecting: false,
    phase: "idle",
    micMode: null,
    widgetVisible: false,
    mode: "off",
    sttOnly: false,
  });

  state.setConnection("connected");
  assert.equal(state.mode(), "connected");
  assert.equal(state.snapshot().connected, true);
  assert.equal(state.snapshot().connecting, false);

  state.setMicMode("vad");
  state.setPhase("recording");
  assert.equal(state.mode(), "listen:vad");
  assert.equal(state.mode({ sttOnly: true }), "stt:vad");

  state.setPhase("thinking");
  assert.equal(state.mode(), "responding");
  state.setPhase("speaking");
  assert.equal(state.mode(), "speaking");
  state.setConnection("off");
  assert.equal(state.mode(), "off");
});

function makeHarness({ models = new Map(), initialModel } = {}) {
  const commands = new Map();
  const tools = new Map();
  const handlers = new Map();
  const providers = new Map();
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];
  const setModelCalls = [];
  const forkCalls = [];
  const emittedEvents = [];
  const sentMessages = [];
  const sentUserMessages = [];
  let reloadCount = 0;

  const ctx = {
    model: initialModel || { provider: "litellm-anthropic", id: "claude-sonnet-4-5" },
    sessionManager: { getLeafId: () => "leaf-1", getBranch: () => [{ id: "root" }, { id: "leaf-1" }] },
    modelRegistry: { find: (provider, id) => models.get(`${provider}/${id}`) },
    async reload() { reloadCount += 1; },
    ui: {
      notify(message, level = "info") { notifications.push({ message, level }); },
      setStatus(key, value) {
        if (value === undefined) statuses.delete(key);
        else statuses.set(key, value);
      },
      setWidget(key, value) {
        if (value === undefined) widgets.delete(key);
        else widgets.set(key, value);
      },
      onTerminalInput() { return () => {}; },
    },
  };

  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    getCommand(name) { return commands.get(name); },
    registerMessageRenderer() {},
    sendMessage(message, options) { sentMessages.push({ message, options }); },
    sendUserMessage(content, options) { sentUserMessages.push({ content, options }); },
    registerProvider(provider, definition) {
      providers.set(provider, definition);
      for (const model of definition.models || []) models.set(`${provider}/${model.id}`, { ...model, provider });
    },
    unregisterProvider(provider) { providers.delete(provider); },
    registerTool(definition) { tools.set(definition.name, definition); },
    events: { emit: (name, payload) => emittedEvents.push({ name, payload }) },
    on(event, handler) { handlers.set(event, handler); },
    setModel: async (model) => {
      setModelCalls.push(model);
      ctx.model = model;
      return true;
    },
  };

  ctx.fork = async (entryId, options = {}) => {
    const forkCtx = { ...ctx, sessionManager: { getLeafId: () => `${entryId}-fork`, getBranch: () => [{ id: entryId }, { id: `${entryId}-fork` }] } };
    forkCalls.push({ entryId, options, forkCtx });
    if (options.withSession) await options.withSession(forkCtx);
    return { cancelled: false };
  };

  return { pi, commands, tools, handlers, providers, widgets, statuses, notifications, setModelCalls, forkCalls, emittedEvents, sentMessages, sentUserMessages, ctx, get reloadCount() { return reloadCount; } };
}

test("env-style realtime args parse quoted key/value pairs", () => {
  assert.deepEqual(parseEnvStyleArgs('backend=pulse source="source bluetooth" sink=vsink\\ voice'), {
    tokens: ["backend=pulse", "source=source bluetooth", "sink=vsink voice"],
    positionals: [],
    values: { backend: "pulse", source: "source bluetooth", sink: "vsink voice" },
  });
  assert.deepEqual(parseEnvStyleArgs("start vad backend=pulse").positionals, ["start", "vad"]);
});

test("extension exposes unified realtime controls on pi and the event bus", () => {
  const { pi, commands, tools, emittedEvents } = makeHarness();
  realtimeAgentExtension(pi);

  assert.match(commands.get("rt").description, /mic\|listen\|audio/);
  assert.match(commands.get("rt-dev").description, /reload/);
  assert.ok(tools.has("realtime_agent_control"));
  assert.match(commands.get("rt-listen").description, /ptt\|vad\|continuous/);
  assert.equal(typeof pi.realtime.snapshot, "function");
  assert.equal(typeof pi.realtime.setAudio, "function");
  assert.equal(typeof pi.realtime.setVoice, "function");
  assert.equal(typeof pi.realtime.diagnostics, "function");
  assert.equal(typeof pi.realtime.options, "function");
  assert.equal(typeof pi.realtime.usage, "function");
  assert.equal(pi.realtime.help(), pi.realtime.usage());
  assert.match(pi.realtime.usage(), /\/rt start \[vad\|ptt\|nolisten\]/);
  assert.match(pi.realtime.usage(), /\/rt listen \[vad\|ptt\|continuous\]/);
  assert.match(pi.realtime.usage(), /thresh <0\.\.1>/);
  assert.deepEqual(pi.realtime.supportedOptions(), pi.realtime.options());
  assert.ok(pi.realtime.options().voices.includes("marin"));
  assert.ok(pi.realtime.options().audioBackends.includes("pulse"));
  assert.ok(pi.realtime.options().reasoningEfforts.includes("low"));
  assert.deepEqual(pi.realtime.options().startModes, ["vad", "ptt", "nolisten"]);
  assert.ok(pi.realtime.options().micModes.includes("cancel"));
  assert.ok(pi.realtime.options().sttModes.includes("stop"));
  assert.deepEqual(pi.realtime.options().audioModes, ["on", "off", "toggle"]);
  assert.ok(pi.realtime.options().widgetModes.includes("hide"));
  assert.deepEqual(pi.realtime.options().statusModes, ["compact", "full"]);
  assert.deepEqual(pi.realtime.options().listenModes, ["vad", "ptt", "continuous"]);
  const snapshot = pi.realtime.snapshot();
  assert.equal(snapshot.health.lastResponseError, null);
  assert.equal(snapshot.health.lastPlaybackError, null);
  assert.equal(snapshot.health.lastMicBytes, 0);
  assert.equal(snapshot.health.pendingTranscriptCount, 0);
  assert.equal(typeof snapshot.health.micMuteRemainingMs, "number");
  assert.equal(emittedEvents.at(-1)?.name, "realtime:controls");
  assert.equal(emittedEvents.at(-1)?.payload, pi.realtime);
});

test("unified realtime controls mutate audio, voice, and widget state", () => {
  const { pi, handlers, widgets, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  let snapshot = pi.realtime.setAudio(false, ctx);
  assert.equal(snapshot.audioEnabled, false);
  snapshot = pi.realtime.setVoice("verse", ctx);
  assert.equal(snapshot.voice, "verse");
  snapshot = pi.realtime.showStatus(ctx);
  assert.equal(snapshot.state.widgetVisible, true);
  assert.ok(widgets.has("realtime-status"));
  snapshot = pi.realtime.hideStatus(ctx);
  assert.equal(snapshot.state.widgetVisible, false);
  assert.equal(widgets.has("realtime-status"), false);
});

test("unified realtime controls reject unsupported direct listen modes", async () => {
  const { pi, handlers, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await assert.rejects(
    () => pi.realtime.listen(ctx, "banana"),
    /Unsupported realtime listen mode: banana/,
  );
  assert.equal(pi.realtime.snapshot().state.micMode, null);
});

test("/rt status widget shows realtime control panel details", async () => {
  const previous = { server: process.env.PULSE_SERVER, source: process.env.PULSE_SOURCE, sink: process.env.PULSE_SINK };
  process.env.PULSE_SERVER = "host:4713";
  process.env.PULSE_SOURCE = "source.usb";
  process.env.PULSE_SINK = "sink.phone";
  const { pi, commands, handlers, widgets, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    pi.realtime.setVadThreshold(0.85, ctx);
    pi.realtime.setSpeed(1.2, ctx);
    pi.realtime.showStatus(ctx);
    const panel = widgets.get("realtime-status").join("\n");
    assert.match(panel, /vad: thresh:0\.85/);
    assert.match(panel, /chime:on/);
    assert.match(panel, /speed:1\.2/);
    assert.match(panel, /pulse: server:host:4713/);
    assert.match(panel, /backend:out:pulse\/in:pulse/);
    assert.match(panel, /mic capture: inactive/);
    assert.match(panel, /next: \/rt start vad begins realtime/);
    assert.match(panel, /controls: \/rt-stop · \/rt-cancel/);

    await commands.get("rt-hide-status").handler("", ctx);
    assert.equal(widgets.has("realtime-status"), false);
  } finally {
    for (const [key, value] of [["PULSE_SERVER", previous.server], ["PULSE_SOURCE", previous.source], ["PULSE_SINK", previous.sink]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("/rt-hide-status keeps the realtime widget hidden across later status updates", async () => {
  const { pi, commands, handlers, widgets, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt-status").handler("", ctx);
  assert.ok(widgets.has("realtime-status"));

  await commands.get("rt-hide-status").handler("", ctx);
  assert.equal(widgets.has("realtime-status"), false);

  await commands.get("rt-audio").handler("toggle", ctx);
  assert.equal(widgets.has("realtime-status"), false);
});

test("/rt-off clears realtime widget and footer statuses", async () => {
  const { pi, commands, handlers, widgets, statuses, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt-status").handler("", ctx);
  statuses.set("rt-audio", "cached clip");
  assert.ok(widgets.has("realtime-status"));

  await commands.get("rt-off").handler("", ctx);

  assert.equal(widgets.has("realtime-status"), false);
  assert.equal(statuses.has("realtime"), false);
  assert.equal(statuses.has("rt-audio"), false);
});

test("/rt-doctor surfaces provider, Pulse, command, and hint diagnostics", async () => {
  const previous = {
    openai: process.env.OPENAI_API_KEY,
    rt: process.env.PI_RT_API_KEY,
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.PI_RT_API_KEY;
  try {
    const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
    realtimeAgentExtension(pi);
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    await commands.get("rt-doctor").handler("", ctx);

    const message = notifications.at(-1)?.message || "";
    assert.match(message, /Realtime doctor/);
    assert.match(message, /provider:/);
    assert.match(message, /apiKey:<missing>/);
    assert.match(message, /audioBackend: pulse/);
    assert.match(message, /pulse: PULSE_SERVER=/);
    assert.match(message, /commands:/);
    assert.match(message, /micError:/);
    assert.match(message, /hint:/);
    assert.match(message, /auth: set OPENAI_API_KEY or PI_RT_API_KEY/);
    assert.match(message, /Pulse is the default backend|Pulse-first setup active/);
    assert.ok(widgets.has("realtime-status"));
  } finally {
    if (previous.openai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.openai;
    if (previous.rt === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previous.rt;
  }
});

test("/rt-status full emits the same diagnostics without requiring a live realtime connection", async () => {
  const { pi, commands, handlers, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt-status").handler("full", ctx);

  const message = notifications.at(-1)?.message || "";
  assert.match(message, /Realtime doctor/);
  assert.match(message, /record:/);
  assert.match(message, /playback:/);
  assert.match(message, /nextStep:/);
  assert.match(message, /mic capture: inactive/);
});

test("realtime backend resolution smoke tests do not require audio devices", async () => {
  const previous = {
    backend: process.env.PI_RT_AUDIO_BACKEND,
    pulse: process.env.PULSE_SERVER,
    record: process.env.PI_RT_RECORD_CMD,
    playback: process.env.PI_RT_PLAYBACK_CMD,
  };
  delete process.env.PULSE_SERVER;
  delete process.env.PI_RT_RECORD_CMD;
  delete process.env.PI_RT_PLAYBACK_CMD;
  try {
    const cases = [
      { backend: "pulse", label: /audioBackend: pulse · out:pulse\/in:pulse/, record: /record: parec /, playback: /playback: pacat / },
      { backend: "coreaudio", label: /audioBackend: coreaudio · out:coreaudio\/in:avfoundation/, record: /record: ffmpeg .*avfoundation/, playback: /playback: ffplay / },
      { backend: "audiotoolbox", label: /audioBackend: audiotoolbox · out:audiotoolbox\/in:avfoundation/, record: /record: ffmpeg .*avfoundation/, playback: /playback: ffmpeg .*audiotoolbox/ },
      { backend: "sox", label: /audioBackend: sox · out:sox\/in:sox/, record: /record: rec /, playback: /playback: play / },
      { backend: "ffplay", label: /audioBackend: ffplay · out:ffplay\/in:sox/, record: /record: rec /, playback: /playback: ffplay / },
    ];
    for (const c of cases) {
      process.env.PI_RT_AUDIO_BACKEND = c.backend;
      const { pi, commands, handlers, notifications, ctx } = makeHarness();
      realtimeAgentExtension(pi);
      handlers.get("session_start")?.({ reason: "startup" }, ctx);

      await commands.get("rt-status").handler("full", ctx);

      const message = notifications.at(-1)?.message || "";
      assert.match(message, c.label, c.backend);
      assert.match(message, c.record, c.backend);
      assert.match(message, c.playback, c.backend);
    }
  } finally {
    if (previous.backend === undefined) delete process.env.PI_RT_AUDIO_BACKEND;
    else process.env.PI_RT_AUDIO_BACKEND = previous.backend;
    if (previous.pulse === undefined) delete process.env.PULSE_SERVER;
    else process.env.PULSE_SERVER = previous.pulse;
    if (previous.record === undefined) delete process.env.PI_RT_RECORD_CMD;
    else process.env.PI_RT_RECORD_CMD = previous.record;
    if (previous.playback === undefined) delete process.env.PI_RT_PLAYBACK_CMD;
    else process.env.PI_RT_PLAYBACK_CMD = previous.playback;
  }
});

test("server VAD turn detection honors threshold, silence, and prefix env controls", async () => {
  const previous = {
    threshold: process.env.PI_RT_VAD_THRESHOLD,
    silence: process.env.PI_RT_VAD_SILENCE_MS,
    prefix: process.env.PI_RT_VAD_PREFIX_PADDING_MS,
  };
  process.env.PI_RT_VAD_THRESHOLD = "0.42";
  process.env.PI_RT_VAD_SILENCE_MS = "900";
  process.env.PI_RT_VAD_PREFIX_PADDING_MS = "250";
  try {
    assert.deepEqual(buildServerVadTurnDetection(), {
      type: "server_vad",
      create_response: false,
      interrupt_response: true,
      threshold: 0.42,
      prefix_padding_ms: 250,
      silence_duration_ms: 900,
    });
  } finally {
    if (previous.threshold === undefined) delete process.env.PI_RT_VAD_THRESHOLD;
    else process.env.PI_RT_VAD_THRESHOLD = previous.threshold;
    if (previous.silence === undefined) delete process.env.PI_RT_VAD_SILENCE_MS;
    else process.env.PI_RT_VAD_SILENCE_MS = previous.silence;
    if (previous.prefix === undefined) delete process.env.PI_RT_VAD_PREFIX_PADDING_MS;
    else process.env.PI_RT_VAD_PREFIX_PADDING_MS = previous.prefix;
  }
});

test("/rt-dev links local realtime source into Pi auto-discovery dir", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "rt-dev-agent-"));
  const checkout = mkdtempSync(join(tmpdir(), "rt-dev-checkout-"));
  mkdirSync(join(checkout, "extensions"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "agent-utils" }));
  writeFileSync(join(checkout, "extensions", "realtime-agent.js"), "export default function noop() {}\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { pi, commands, handlers, notifications, ctx } = makeHarness();
  ctx.cwd = checkout;
  realtimeAgentExtension(pi);

  try {
    await commands.get("rt-dev").handler("status", ctx);
    assert.match(notifications.at(-1).message, /inactive/);

    await commands.get("rt-dev").handler("link", ctx);
    const linkDir = join(agentDir, "extensions", "agent-utils-realtime-dev");
    assert.equal(existsSync(join(linkDir, "package.json")), true);
    assert.equal(readlinkSync(join(linkDir, "extensions")), join(checkout, "extensions"));
    assert.match(notifications.at(-1).message, /Run \/reload-tools or \/reload/);

    await commands.get("rt-dev").handler("unlink", ctx);
    assert.equal(existsSync(linkDir), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("/rt-dev reload optionally links and calls Pi reload", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = mkdtempSync(join(tmpdir(), "rt-dev-reload-agent-"));
  const checkout = mkdtempSync(join(tmpdir(), "rt-dev-reload-checkout-"));
  mkdirSync(join(checkout, "extensions"), { recursive: true });
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "agent-utils" }));
  writeFileSync(join(checkout, "extensions", "realtime-agent.js"), "export default function noop() {}\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const h = makeHarness();
  h.ctx.cwd = checkout;
  realtimeAgentExtension(h.pi);

  try {
    await h.commands.get("rt-dev").handler("reload", h.ctx);
    const linkDir = join(agentDir, "extensions", "agent-utils-realtime-dev");
    assert.equal(h.reloadCount, 1);
    assert.equal(existsSync(linkDir), false);
    assert.match(h.notifications.at(-1).message, /without restarting/);

    await h.commands.get("rt-dev").handler(`reload ${checkout}`, h.ctx);
    assert.equal(h.reloadCount, 2);
    assert.equal(readlinkSync(join(linkDir, "extensions")), join(checkout, "extensions"));
    assert.match(h.notifications.at(-1).message, /reloading Pi extensions from local source/);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("realtime provider registers during extension startup with a dedicated API", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  const { pi, commands, providers, handlers, ctx } = makeHarness();
  realtimeAgentExtension(pi);

  try {
    assert.equal(providers.get("openai-realtime")?.api, "openai-realtime");
    assert.equal(providers.get("openai-realtime")?.apiKey, "$PI_RT_API_KEY");
    assert.ok(providers.get("openai-realtime")?.models?.some((model) => model.id === "gpt-realtime-2"));
    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await commands.get("rt").handler("start nolisten", ctx);
    assert.equal(providers.get("openai-realtime")?.api, "openai-realtime");
  } finally {
    await commands.get("rt-off").handler("", ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("model_select shows realtime UI and non-realtime selection clears it", async () => {
  const realtimeModel = { provider: "openai-realtime", id: "gpt-realtime-2" };
  const textModel = { provider: "litellm-anthropic", id: "claude-sonnet-4-5" };
  const { pi, handlers, widgets, statuses, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  handlers.get("model_select")?.({ model: realtimeModel, source: "set" }, ctx);
  assert.ok(widgets.has("realtime-status"));
  assert.ok(statuses.has("realtime"));

  statuses.set("rt-audio", "cached clip");
  handlers.get("model_select")?.({ model: textModel, previousModel: realtimeModel, source: "set" }, ctx);
  assert.equal(widgets.has("realtime-status"), false);
  assert.equal(statuses.has("realtime"), false);
  assert.equal(statuses.has("rt-audio"), false);
});

test("context hook strips realtime custom messages before provider context", () => {
  const { pi, handlers } = makeHarness();
  realtimeAgentExtension(pi);
  const result = handlers.get("context")?.({
    messages: [
      { role: "custom", customType: "realtime-agent", content: "internal" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
      { role: "custom", customType: "other-extension", content: "keep" },
    ],
  });

  assert.deepEqual(result.messages.map((m) => m.role === "custom" ? m.customType : m.role), ["user", "other-extension"]);
});

test("/rt subcommands provide explicit audio and widget controls", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("widget show", ctx);
  assert.ok(widgets.has("realtime-status"));

  await commands.get("rt").handler("audio off", ctx);
  assert.equal(pi.realtime.snapshot().audioEnabled, false);
  assert.match(notifications.at(-1).message, /Realtime audio OFF/);

  await commands.get("rt").handler("audio on", ctx);
  assert.equal(pi.realtime.snapshot().audioEnabled, true);

  await commands.get("rt").handler("widget hide", ctx);
  assert.equal(widgets.has("realtime-status"), false);
});

test("/rt tuning subcommands validate voice, backend, and reasoning", async () => {
  const previousBackend = process.env.PI_RT_AUDIO_BACKEND;
  const { pi, commands, handlers, notifications, ctx } = makeHarness();
  try {
    realtimeAgentExtension(pi);
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    await commands.get("rt").handler("voice Verse", ctx);
    assert.equal(pi.realtime.snapshot().voice, "verse");
    assert.match(notifications.at(-1).message, /Realtime voice verse/);

    await commands.get("rt").handler("voice bogus", ctx);
    assert.equal(pi.realtime.snapshot().voice, "verse");
    assert.match(notifications.at(-1).message, /Unsupported realtime voice/);

    await commands.get("rt").handler("backend audiotoolbox", ctx);
    assert.equal(pi.realtime.snapshot().audioBackend, "audiotoolbox");

    await commands.get("rt").handler("backend bogus", ctx);
    assert.equal(pi.realtime.snapshot().audioBackend, "audiotoolbox");
    assert.match(notifications.at(-1).message, /Unsupported realtime audio backend/);

    await commands.get("rt").handler("reasoning low", ctx);
    assert.equal(pi.realtime.snapshot().reasoningEffort, "low");

    await commands.get("rt").handler("reasoning maximum", ctx);
    assert.equal(pi.realtime.snapshot().reasoningEffort, "low");
    assert.match(notifications.at(-1).message, /Unsupported realtime reasoning effort/);
  } finally {
    if (previousBackend === undefined) delete process.env.PI_RT_AUDIO_BACKEND;
    else process.env.PI_RT_AUDIO_BACKEND = previousBackend;
  }
});

test("legacy realtime aliases route through the unified /rt command surface", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt-on").handler("", ctx);
  assert.equal(pi.realtime.snapshot().audioEnabled, true);
  assert.match(notifications.at(-1).message, /Realtime audio ON/);

  await commands.get("rt-audio").handler("off", ctx);
  assert.equal(pi.realtime.snapshot().audioEnabled, false);
  assert.match(notifications.at(-1).message, /Realtime audio OFF/);

  await commands.get("rt-reasoning").handler("medium", ctx);
  assert.equal(pi.realtime.snapshot().reasoningEffort, "medium");

  await commands.get("rt-doctor").handler("", ctx);
  assert.match(notifications.at(-1).message, /Realtime doctor/);
  assert.ok(widgets.has("realtime-status"));

  await commands.get("rt-hide-status").handler("", ctx);
  assert.equal(widgets.has("realtime-status"), false);
});

test("/rt listen accepts the same continuous mode as direct controls", async () => {
  const originalRecordCmd = process.env.PI_RT_RECORD_CMD;
  process.env.PI_RT_RECORD_CMD = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 1000)"`;
  try {
    const { pi, commands, handlers, notifications, ctx } = makeHarness();
    realtimeAgentExtension(pi);
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    await commands.get("rt").handler("listen continuous", ctx);
    assert.equal(pi.realtime.snapshot().state.micMode, "vad");
    assert.match(notifications.at(-1).message, /VAD listening/);

    await commands.get("rt").handler("listen banana", ctx);
    assert.match(notifications.at(-1).message, /Unsupported realtime listen mode/);
    assert.equal(pi.realtime.snapshot().state.micMode, "vad");

    await pi.realtime.cancelMic(ctx);
  } finally {
    if (originalRecordCmd === undefined) delete process.env.PI_RT_RECORD_CMD;
    else process.env.PI_RT_RECORD_CMD = originalRecordCmd;
  }
});

test("/rt rejects unsupported start, mic, and stt modes without falling through", async () => {
  const { pi, commands, handlers, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("start banana", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime start mode/);
  assert.equal(pi.realtime.snapshot().state.connected, false);

  await commands.get("rt").handler("mic banana", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime mic mode/);

  await commands.get("rt").handler("stt banana", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime STT mode/);
  assert.equal(pi.realtime.snapshot().sttOnly, false);
});

test("/rt rejects unsupported audio and widget modes without toggling state", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  pi.realtime.setAudio(true, ctx);
  await commands.get("rt").handler("audio banana", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime audio mode/);
  assert.equal(pi.realtime.snapshot().audioEnabled, true);

  pi.realtime.hideStatus(ctx);
  await commands.get("rt").handler("widget banana", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime widget mode/);
  assert.equal(widgets.has("realtime-status"), false);
});

test("/rt rejects unexpected extra subcommand arguments", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("start ptt typo", ctx);
  assert.match(notifications.at(-1).message, /Unexpected extra realtime argument/);
  assert.equal(pi.realtime.snapshot().state.connected, false);

  pi.realtime.setAudio(true, ctx);
  await commands.get("rt").handler("audio off typo", ctx);
  assert.match(notifications.at(-1).message, /Unexpected extra realtime argument/);
  assert.equal(pi.realtime.snapshot().audioEnabled, true);

  await commands.get("rt").handler("doctor now", ctx);
  assert.match(notifications.at(-1).message, /Unexpected realtime argument/);
  assert.equal(widgets.has("realtime-status"), false);
});

test("/rt rejects unsupported status modes without showing the widget", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  pi.realtime.hideStatus(ctx);

  await commands.get("rt").handler("status ful", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime status mode/);
  assert.equal(widgets.has("realtime-status"), false);
});

test("legacy realtime aliases reject unexpected arguments before state changes", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  pi.realtime.setAudio(false, ctx);
  await commands.get("rt-on").handler("now", ctx);
  assert.match(notifications.at(-1).message, /Unexpected argument for \/rt-on/);
  assert.equal(pi.realtime.snapshot().audioEnabled, false);

  await commands.get("rt-doctor").handler("please", ctx);
  assert.match(notifications.at(-1).message, /Unexpected argument for \/rt-doctor/);
  assert.equal(widgets.has("realtime-status"), false);

  await commands.get("rt-listen").handler("vad typo", ctx);
  assert.match(notifications.at(-1).message, /Unexpected extra realtime argument/);
  assert.equal(pi.realtime.snapshot().state.micMode, null);
});

test("STT legacy aliases pass arguments through unified /rt stt handling", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  pi.realtime.setSttOnly(true, ctx);
  pi.realtime.showStatus(ctx);
  await commands.get("rt-stt").handler("stop", ctx);
  assert.equal(pi.realtime.snapshot().sttOnly, false);
  assert.equal(widgets.has("realtime-status"), false);
  assert.match(notifications.at(-1).message, /Realtime STT stopped/);

  pi.realtime.setSttOnly(true, ctx);
  await commands.get("stt").handler("banana", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime STT mode/);
});

test("/rt help reports unified usage and /rt stt stop exits transcription mode", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("help", ctx);
  assert.match(notifications.at(-1).message, /Usage: \/rt start/);
  assert.match(notifications.at(-1).message, /\/rt stt \[vad\|ptt\|local-vad\|stop\]/);

  pi.realtime.setSttOnly(true, ctx);
  pi.realtime.showStatus(ctx);
  assert.equal(pi.realtime.snapshot().sttOnly, true);
  assert.ok(widgets.has("realtime-status"));

  await commands.get("rt").handler("stt stop", ctx);
  assert.equal(pi.realtime.snapshot().sttOnly, false);
  assert.equal(widgets.has("realtime-status"), false);
  assert.match(notifications.at(-1).message, /Realtime STT stopped/);
});

test("realtime connection auto-reconnects after unexpected close but not after /rt-off", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousDelay = process.env.PI_RT_RECONNECT_BASE_DELAY_MS;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_RECONNECT_BASE_DELAY_MS = "1";
  FakeWebSocket.instances = [];
  const { pi, commands, handlers, ctx } = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("start nolisten", ctx);
    assert.equal(FakeWebSocket.instances.length, 1);
    FakeWebSocket.instances[0].close();
    await waitFor(() => FakeWebSocket.instances.length >= 2);
    assert.ok(FakeWebSocket.instances.length >= 2);

    await commands.get("rt-off").handler("", ctx);
    const countAfterOff = FakeWebSocket.instances.length;
    FakeWebSocket.instances.at(-1)?.close();
    // Negative check: /rt-off must NOT auto-reconnect. The reconnect base delay
    // is 1ms here, so a wrongful reconnect would appear almost immediately;
    // briefly poll for the unwanted instance, then assert it never arrived.
    await waitFor(() => FakeWebSocket.instances.length !== countAfterOff, { timeoutMs: 50 });
    assert.equal(FakeWebSocket.instances.length, countAfterOff);
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousDelay === undefined) delete process.env.PI_RT_RECONNECT_BASE_DELAY_MS;
    else process.env.PI_RT_RECONNECT_BASE_DELAY_MS = previousDelay;
    try { await commands.get("rt-off").handler("", ctx); } catch {}
  }
});

test("/rt status full and doctor subcommands expose diagnostics", async () => {
  const { pi, commands, handlers, notifications, ctx } = makeHarness({ initialModel: { provider: "openai-realtime", id: "gpt-realtime-2", contextWindow: 128000 } });
  ctx.settingsManager = { getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 40000 }) };
  ctx.agent = { state: { messages: [{ role: "user", content: [{ type: "text", text: "hello realtime" }] }] } };
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("status full", ctx);
  assert.match(notifications.at(-1).message, /Realtime doctor/);
  assert.match(notifications.at(-1).message, /context: window:128,000 · compactAt:111,616 \(87\.2%\)/);
  assert.match(notifications.at(-1).message, /full:\d+ \(0\.0%\) · summary:\d+ \(0\.\d%\)/);

  await commands.get("rt").handler("doctor", ctx);
  assert.match(notifications.at(-1).message, /Realtime doctor/);
  assert.match(notifications.at(-1).message, /reserve:16,384 · keep:40,000/);
});

test("session_before_compact uses local simple summary without leaving realtime", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const previousModel = { provider: "litellm-openai", id: "gpt-5.5" };
  const realtimeModel = { provider: "openai-realtime", id: "gpt-realtime-2", api: "openai-realtime" };
  const models = new Map([["openai-realtime/gpt-realtime-2", realtimeModel], ["litellm-openai/gpt-5.5", previousModel]]);
  const { pi, commands, handlers, providers, setModelCalls, ctx, notifications, sentMessages } = makeHarness({ models, initialModel: previousModel });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("start nolisten", ctx);
    assert.equal(ctx.model.provider, "openai-realtime");
    const result = await handlers.get("session_before_compact")?.({
      preparation: {
        firstKeptEntryId: "keep-1",
        tokensBefore: 12345,
        previousSummary: "old compact facts",
        messagesToSummarize: [
          { role: "user", content: [{ type: "text", text: "please wire realtime compaction" }] },
          { role: "assistant", content: [{ type: "text", text: "I will keep realtime active." }] },
        ],
        turnPrefixMessages: [],
        fileOps: { read: new Set(["extensions/realtime-agent.js"]), edited: new Set(["docs/realtime-agent.md"]) },
      },
      branchEntries: [],
    }, ctx);
    assert.equal(ctx.model.provider, "openai-realtime");
    assert.equal(setModelCalls.length, 1);
    assert.equal(setModelCalls.at(-1).provider, "openai-realtime");
    assert.equal(setModelCalls.at(-1).id, "gpt-realtime-2");
    assert.equal(providers.has("openai-realtime"), true);
    assert.equal(result.cancel, undefined);
    assert.equal(result.compaction.firstKeptEntryId, "keep-1");
    assert.equal(result.compaction.tokensBefore, 12345);
    assert.match(result.compaction.summary, /local\/simple checkpoint/);
    assert.match(result.compaction.summary, /old compact facts/);
    assert.match(result.compaction.summary, /please wire realtime compaction/);
    assert.deepEqual(result.compaction.details, { readFiles: ["extensions/realtime-agent.js"], modifiedFiles: ["docs/realtime-agent.md"] });
    assert.match(notifications.at(-1)?.message || "", /realtime stays active/);

    FakeWebSocket.instances.at(-1).emit("message", JSON.stringify({ type: "input_audio_buffer.committed" }));
    assert.equal(sentMessages.length, 0, "audio turn should wait until compaction has been appended");
    await handlers.get("session_compact")?.({ compactionEntry: { id: "cmp-1" }, fromExtension: true }, ctx);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].message.customType, "realtime-agent");
    assert.equal(sentMessages[0].options.triggerTurn, true);
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("/rt temporary realtime switch preserves default model settings", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_RT_API_KEY = "test-key";
  const dir = mkdtempSync(join(tmpdir(), "rt-settings-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "litellm-openai", defaultModel: "gpt-5.5" }, null, 2));
  FakeWebSocket.instances = [];
  const { pi, commands, handlers, ctx } = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  pi.setModel = async (model) => {
    ctx.model = model;
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    settings.defaultProvider = model.provider;
    settings.defaultModel = model.id;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  };
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("start nolisten", ctx);
    // Negative check over a settle window: a temporary realtime switch must not
    // rewrite the persisted defaults. Poll for an unwanted mutation (short-
    // circuiting if one appears) up to the original guard window, then assert
    // the settings file is still the untouched defaults.
    await waitFor(
      () => JSON.parse(readFileSync(settingsPath, "utf8")).defaultModel !== "gpt-5.5",
      { timeoutMs: 320 },
    );
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { defaultProvider: "litellm-openai", defaultModel: "gpt-5.5" });
  } finally {
    await commands.get("rt-off").handler("", ctx).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("/rt stt keeps the text model selected while startup-registered realtime provider remains available", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  const previousAlways = process.env.PI_RT_ALWAYS_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  delete process.env.PI_RT_REGISTER;
  delete process.env.PI_RT_ALWAYS_REGISTER;
  FakeWebSocket.instances = [];
  const { pi, commands, providers, handlers, ctx } = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("stt vad", ctx);
    assert.equal(ctx.model.provider, "litellm-openai");
    assert.equal(providers.has("openai-realtime"), true);
    assert.equal(FakeWebSocket.instances.length, 1);
  } finally {
    await commands.get("rt-off").handler("", ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
    if (previousAlways === undefined) delete process.env.PI_RT_ALWAYS_REGISTER;
    else process.env.PI_RT_ALWAYS_REGISTER = previousAlways;
  }
});

test("/rt stt shows partial transcripts and queues completed transcripts as follow-ups", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  const previousAlways = process.env.PI_RT_ALWAYS_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  delete process.env.PI_RT_REGISTER;
  delete process.env.PI_RT_ALWAYS_REGISTER;
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("stt vad", harness.ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "queue this" }));
    await waitFor(() => harness.statuses.get("rt-transcript") === "◇ … queue this");
    assert.equal(harness.statuses.get("rt-transcript"), "◇ … queue this");

    ws.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "queue this while busy" }));
    await waitFor(() => harness.statuses.get("rt-transcript") === "◇ queue this while busy");

    assert.equal(harness.statuses.get("rt-transcript"), "◇ queue this while busy");
    assert.deepEqual(harness.sentUserMessages, [
      { content: "queue this while busy", options: { deliverAs: "followUp", streamingBehavior: "followUp" } },
    ]);
    assert.equal(harness.pi.realtime.snapshot().state.lastInputMode, "transcript");
  } finally {
    await harness.commands.get("rt-off").handler("", harness.ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
    if (previousAlways === undefined) delete process.env.PI_RT_ALWAYS_REGISTER;
    else process.env.PI_RT_ALWAYS_REGISTER = previousAlways;
  }
});

test("realtime_agent_control start with status still starts realtime", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const previousModel = { provider: "litellm-openai", id: "gpt-5.5" };
  const { pi, commands, tools, handlers, setModelCalls, ctx } = makeHarness({ initialModel: previousModel });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    const result = await tools.get("realtime_agent_control").execute("tool-1", { start: "nolisten", status: "full" }, null, null, ctx);
    assert.equal(setModelCalls.at(-1)?.provider, "openai-realtime");
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.match(result.content[0].text, /Realtime doctor/);
  } finally {
    await commands.get("rt-off").handler("", ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("/rt start force-registers realtime provider and switches away from current text model", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const previousModel = { provider: "litellm-openai", id: "gpt-5.5" };
  const { pi, commands, handlers, setModelCalls, ctx } = makeHarness({ initialModel: previousModel });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("start nolisten", ctx);
    assert.equal(setModelCalls.at(-1)?.provider, "openai-realtime");
    assert.equal(setModelCalls.at(-1)?.id, "gpt-realtime-2");
    assert.equal(pi.realtime.snapshot().previousModel.id, "gpt-5.5");
  } finally {
    await commands.get("rt-off").handler("", ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("/rt clamps invalid realtime model env to supported fallback", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRtModel = process.env.PI_RT_MODEL;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_MODEL = "gpt-4o-mini";
  FakeWebSocket.instances = [];
  const previousModel = { provider: "litellm-openai", id: "gpt-5.5" };
  const { pi, commands, handlers, setModelCalls, ctx } = makeHarness({ initialModel: previousModel });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("start nolisten", ctx);
    assert.equal(setModelCalls.at(-1)?.provider, "openai-realtime");
    assert.equal(setModelCalls.at(-1)?.id, "gpt-realtime-2");
    assert.equal(pi.realtime.snapshot().model, "gpt-realtime-2");
  } finally {
    await commands.get("rt-off").handler("", ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRtModel === undefined) delete process.env.PI_RT_MODEL;
    else process.env.PI_RT_MODEL = previousRtModel;
  }
});

test("/rt fork=true forks current tree position and preserves other params", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const previousModel = { provider: "litellm-openai", id: "gpt-5.5" };
  const { pi, commands, handlers, setModelCalls, forkCalls, ctx, notifications } = makeHarness({ initialModel: previousModel });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("fork=true summary=true start=nolisten", ctx);
    assert.equal(forkCalls.length, 1);
    assert.equal(forkCalls[0].entryId, "leaf-1");
    assert.equal(forkCalls[0].options.position, "at");
    assert.equal(pi.realtime.snapshot().summaryContext, true);
    assert.equal(setModelCalls.at(-1)?.provider, "openai-realtime");
    assert.equal(FakeWebSocket.instances.length, 1);
    assert.match(notifications.at(-2)?.message || "", /Realtime started in a fork/);
  } finally {
    await commands.get("rt-off").handler("", ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("/rt env-style args configure Pulse routing, summary mode, and tool exposes same control", async () => {
  const previous = { server: process.env.PULSE_SERVER, source: process.env.PULSE_SOURCE, sink: process.env.PULSE_SINK };
  const { pi, commands, tools, handlers, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler('backend=pulse base_url=http://helsinki.miku-owl.ts.net:4000 source="source bluetooth" sink=vsink summary=true trans=gpt-whisper-realtime speed=1.25 thresh=0.85 chime=false', ctx);
    assert.equal(process.env.PI_RT_AUDIO_BACKEND, "pulse");
    assert.equal(process.env.PULSE_SOURCE, "source bluetooth");
    assert.equal(process.env.PULSE_SINK, "vsink");
    assert.equal(pi.realtime.snapshot().baseUrl, "http://helsinki.miku-owl.ts.net:4000");
    assert.match(pi.realtime.snapshot().realtimeUrl, /^ws:\/\/helsinki\.miku-owl\.ts\.net:4000\/v1\/realtime/);
    assert.equal(pi.realtime.snapshot().summaryContext, true);
    assert.equal(pi.realtime.snapshot().transcriptionModel, "gpt-whisper-realtime");
    assert.equal(pi.realtime.snapshot().speed, 1.25);
    assert.equal(pi.realtime.snapshot().vadThreshold, 0.85);
    assert.equal(process.env.PI_RT_VAD_THRESHOLD, "0.85");
    assert.equal(pi.realtime.snapshot().chimeEnabled, false);

    await tools.get("realtime_agent_control").execute("tool-1", { baseUrl: "https://api.openai.com/v1", pulseServer: "sgu24:4713", pulseSource: "source.bluetooth", summary: false, trans: "gpt-realtime-whisper", speed: 0.75, thresh: 0.6, chime: true, status: "full" }, null, null, ctx);
    assert.equal(pi.realtime.snapshot().baseUrl, "https://api.openai.com");
    assert.match(pi.realtime.snapshot().realtimeUrl, /^wss:\/\/api\.openai\.com\/v1\/realtime/);
    assert.equal(process.env.PULSE_SERVER, "sgu24:4713");
    assert.equal(process.env.PULSE_SOURCE, "source.bluetooth");
    assert.equal(pi.realtime.snapshot().summaryContext, false);
    assert.equal(pi.realtime.snapshot().transcriptionModel, "gpt-realtime-whisper");
    assert.equal(pi.realtime.snapshot().speed, 0.75);
    assert.equal(pi.realtime.snapshot().vadThreshold, 0.6);
    assert.equal(pi.realtime.snapshot().chimeEnabled, true);
  } finally {
    for (const [key, value] of [["PULSE_SERVER", previous.server], ["PULSE_SOURCE", previous.source], ["PULSE_SINK", previous.sink]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.PI_RT_VAD_THRESHOLD;
  }
});

test("/rt speed applies realtime response speed and retries if rejected", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_REGISTER = "1";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "openai-realtime", id: "gpt-realtime-2", api: "openai-realtime" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("speed 1.2", harness.ctx);
    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, { systemPrompt: "", tools: [], messages: [] }, {});
    const create = await waitFor(() => FakeWebSocket.instances[0]?.sent.find((m) => m.type === "response.create"));
    assert.equal(create.response.speed, 1.2);

    FakeWebSocket.instances[0].emit("message", JSON.stringify({ type: "error", error: { message: "Unknown parameter: 'response.speed'" } }));
    const retry = await waitFor(() => {
      const all = FakeWebSocket.instances[0].sent.filter((m) => m.type === "response.create");
      return all.length >= 2 ? all.at(-1) : null;
    });
    assert.equal(retry.response.speed, undefined);
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
  }
});

test("/rt summary=true keeps compact summary in instructions, not spoken user messages", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_REGISTER = "1";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "openai-realtime", id: "gpt-realtime-2", contextWindow: 128000 } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("summary true", harness.ctx);
    const context = {
      systemPrompt: "system",
      tools: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "The conversation history before this point was compacted into the following summary:\n\n<summary>important compact facts</summary>" }] },
        { role: "user", content: [{ type: "text", text: `old full history ${"x".repeat(20_000)}` }] },
        { role: "assistant", content: [{ type: "text", text: "old assistant reply" }] },
        { role: "user", content: [{ type: "text", text: "current realtime question" }] },
      ],
    };
    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, context, {});
    await waitFor(() =>
      FakeWebSocket.instances[0]?.sent.some((m) => m.type === "session.update") &&
      FakeWebSocket.instances[0]?.sent.some((m) => m.type === "conversation.item.create"),
    );

    const sessionUpdate = FakeWebSocket.instances[0].sent.find((m) => m.type === "session.update");
    assert.match(sessionUpdate.session.instructions, /important compact facts/);
    assert.doesNotMatch(sessionUpdate.session.instructions, /old full history/);
    const items = FakeWebSocket.instances[0].sent.filter((m) => m.type === "conversation.item.create");
    assert.equal(items.length, 1);
    assert.equal(items[0].item.content[0].text, "current realtime question");
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
  }
});

test("full realtime speech lifecycle does not expose a blocking transcribing phase", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("start nolisten", harness.ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
    await waitFor(() => harness.pi.realtime.snapshot().state.phase === "thinking");
    assert.equal(harness.pi.realtime.snapshot().state.phase, "thinking");
    assert.equal(harness.pi.realtime.snapshot().state.mode, "responding");

    ws.emit("message", JSON.stringify({ type: "input_audio_buffer.committed" }));
    await waitFor(() => harness.sentMessages.length === 1);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.pi.realtime.snapshot().state.phase, "thinking");

    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, { systemPrompt: "", tools: [], messages: [] }, {});
    // Let the outgoing stream attach (emit its response.create) before the
    // server response.done arrives, so the completion is not dropped.
    await waitFor(() => ws.sent.some((m) => m.type === "response.create"));
    ws.emit("message", JSON.stringify({ type: "response.done", response: { id: "resp_1" } }));
    await waitFor(() => harness.pi.realtime.snapshot().state.phase === "idle");
    assert.equal(harness.pi.realtime.snapshot().state.phase, "idle");

    ws.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "late transcript" }));
    await waitFor(() => harness.statuses.get("rt-transcript") === "◇ late transcript");
    assert.equal(harness.pi.realtime.snapshot().state.phase, "idle");
    assert.equal(harness.pi.realtime.snapshot().state.mode, "connected");
    assert.equal(harness.statuses.get("rt-transcript"), "◇ late transcript");
  } finally {
    await harness.commands.get("rt-off").handler("", harness.ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("full realtime committed audio triggers a custom turn, not transcript user text", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("start nolisten", harness.ctx);
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", JSON.stringify({ type: "input_audio_buffer.committed" }));
    await waitFor(() => harness.sentMessages.length === 1);
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.sentMessages[0].message.customType, "realtime-agent");
    assert.equal(harness.sentMessages[0].message.display, false);
    assert.equal(harness.sentMessages[0].options.triggerTurn, true);
    assert.equal(harness.sentUserMessages.length, 0);

    ws.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.delta", delta: "da da" }));
    await waitFor(() => harness.statuses.get("rt-transcript") === "◇ … da da");
    assert.equal(harness.statuses.get("rt-transcript"), "◇ … da da");

    ws.emit("message", JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "da da da da" }));
    await waitFor(() => harness.statuses.get("rt-transcript") === "◇ da da da da");
    assert.equal(harness.sentMessages.length, 1);
    assert.equal(harness.statuses.get("rt-transcript"), "◇ da da da da");
    assert.equal(harness.notifications.at(-1)?.message, "◇ da da da da");
    assert.equal(harness.sentUserMessages.length, 0);

    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, { systemPrompt: "", tools: [], messages: [] }, {});
    await waitFor(() => ws.sent.some((m) => m.type === "response.create"));
    assert.equal(ws.sent.some((m) => m.type === "conversation.item.create" && JSON.stringify(m).includes("da da da da")), false);
    assert.equal(ws.sent.some((m) => m.type === "response.create"), true);
  } finally {
    await harness.commands.get("rt-off").handler("", harness.ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("realtime flushes spoken preamble before tool calls", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousPlayback = process.env.PI_RT_PLAYBACK_CMD;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_PLAYBACK_CMD = "cat >/dev/null";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("start nolisten", harness.ctx);
    const stream = harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, { systemPrompt: "", tools: [{ name: "read", description: "read", parameters: { type: "object", properties: {}, required: [] } }], messages: [] }, {});
    const ws = FakeWebSocket.instances[0];
    ws.emit("message", JSON.stringify({ type: "response.audio.delta", delta: Buffer.alloc(64).toString("base64") }));
    assert.equal(harness.pi.realtime.snapshot().health.lastPlaybackStartedAt, null);
    ws.emit("message", JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: "call-1", name: "read" } }));
    await waitFor(() => harness.pi.realtime.snapshot().health.lastPlaybackStartedAt);
    assert.ok(harness.pi.realtime.snapshot().health.lastPlaybackStartedAt);
    stream[Symbol.asyncIterator]?.();
  } finally {
    await harness.commands.get("rt-off").handler("", harness.ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousPlayback === undefined) delete process.env.PI_RT_PLAYBACK_CMD;
    else process.env.PI_RT_PLAYBACK_CMD = previousPlayback;
  }
});

test("realtime restarts VAD mic when recorder exits unexpectedly", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRecord = process.env.PI_RT_RECORD_CMD;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_RECORD_CMD = "sh -c 'exit 7'";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "litellm-openai", id: "gpt-5.5" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    await harness.commands.get("rt").handler("start vad", harness.ctx);
    const snapshot = await waitFor(
      () => {
        const snap = harness.pi.realtime.snapshot();
        return snap.health.micRestartPending || snap.health.micRestartAttempts >= 1 ? snap : null;
      },
      // This case spawns a real recorder subprocess (PI_RT_RECORD_CMD=sh -c 'exit 7')
      // and waits for its exit event to drive scheduleMicRestart. That spawn -> exit
      // -> event -> restart-scheduling chain has real OS latency, so under full-suite
      // CPU contention it can exceed a tight 1s budget and flake (671/672). waitFor
      // returns the instant the predicate is met, so a larger headroom timeout costs
      // nothing on the fast path and only absorbs load (bd-43afce intent).
      { timeoutMs: 5000, intervalMs: 50 },
    ) ?? harness.pi.realtime.snapshot();
    assert.ok(snapshot.health.micRestartPending || snapshot.health.micRestartAttempts >= 1);
    assert.ok(harness.notifications.some((n) => /restarting vad capture/.test(n.message)));
  } finally {
    await harness.commands.get("rt-off").handler("", harness.ctx);
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRecord === undefined) delete process.env.PI_RT_RECORD_CMD;
    else process.env.PI_RT_RECORD_CMD = previousRecord;
  }
});

test("realtime preserves live model-emitted tool call ids for tool outputs, including sanitized-looking ids", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_REGISTER = "1";
  FakeWebSocket.instances = [];
  const harness = makeHarness({ initialModel: { provider: "openai-realtime", id: "gpt-realtime-2", api: "openai-realtime" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    const liveCallIds = ["call_live_123", "call_1fk4b5p_1", "call_1lg16bt_2"];
    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, { systemPrompt: "", tools: [], messages: [] }, {});
    await waitFor(() => FakeWebSocket.instances[0]);
    const ws = FakeWebSocket.instances[0];

    for (const liveCallId of liveCallIds) {
      ws.emit("message", JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", call_id: liveCallId, name: "read" } }));
      ws.emit("message", JSON.stringify({ type: "response.function_call_arguments.done", call_id: liveCallId, arguments: "{}", name: "read" }));
    }
    ws.emit("message", JSON.stringify({ type: "response.done", response: { id: "resp_reported_tool_ids" } }));

    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, {
      systemPrompt: "",
      tools: [],
      messages: liveCallIds.map((liveCallId) => ({ role: "toolResult", toolCallId: liveCallId, content: [{ type: "text", text: "tool ok" }] })),
    }, {});
    await waitFor(
      () => ws.sent.filter((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output").length >= liveCallIds.length,
    );

    const outputs = ws.sent.filter((m) => m.type === "conversation.item.create" && m.item?.type === "function_call_output");
    assert.deepEqual(outputs.map((m) => m.item.call_id), liveCallIds);
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
  }
});

test("realtime sanitizes long history tool call ids and recovers from server errors", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_REGISTER = "1";
  FakeWebSocket.instances = [];
  const longId = `tool-${"x".repeat(430)}`;
  const harness = makeHarness({ initialModel: { provider: "openai-realtime", id: "gpt-realtime-2", api: "openai-realtime" } });
  realtimeAgentExtension(harness.pi);
  harness.handlers.get("session_start")?.({ reason: "startup" }, harness.ctx);

  try {
    harness.providers.get("openai-realtime").streamSimple(harness.ctx.model, {
      systemPrompt: "",
      tools: [],
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: longId, name: "read", arguments: { path: "x" } }] },
        { role: "toolResult", toolCallId: longId, content: [{ type: "text", text: "ok" }] },
      ],
    }, {});
    await waitFor(
      () => FakeWebSocket.instances[0]?.sent.filter((m) => m.type === "conversation.item.create" && /function_call/.test(m.item?.type)).length >= 2,
    );
    const callItems = FakeWebSocket.instances[0].sent.filter((m) => m.type === "conversation.item.create" && /function_call/.test(m.item?.type));
    assert.equal(callItems.length, 2);
    assert.ok(callItems.every((m) => m.item.call_id.length <= 32));
    assert.equal(callItems[0].item.call_id, callItems[1].item.call_id);

    FakeWebSocket.instances[0].emit("message", JSON.stringify({ type: "error", error: { message: "boom" } }));
    await waitFor(() => harness.pi.realtime.snapshot().state.phase === "idle");
    assert.equal(harness.pi.realtime.snapshot().state.phase, "idle");
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
  }
});

test("realtime aborts oversized full-history context before opening WebSocket", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  const previousRegister = process.env.PI_RT_REGISTER;
  process.env.PI_RT_API_KEY = "test-key";
  process.env.PI_RT_REGISTER = "1";
  FakeWebSocket.instances = [];
  const { pi, providers, handlers, ctx } = makeHarness({ initialModel: { provider: "openai-realtime", id: "gpt-realtime-2", contextWindow: 128000 } });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    const stream = providers.get("openai-realtime").streamSimple(ctx.model, {
      systemPrompt: "system",
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(600_000) }] }],
    }, {});
    const result = await stream.result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /too large/);
    assert.equal(FakeWebSocket.instances.length, 0);
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
    if (previousRegister === undefined) delete process.env.PI_RT_REGISTER;
    else process.env.PI_RT_REGISTER = previousRegister;
  }
});

test("/rt nolisten switches to realtime, connects through injected WebSocket, and restores previous model on /rt-off", async () => {
  const previousApiKey = process.env.PI_RT_API_KEY;
  process.env.PI_RT_API_KEY = "test-key";
  FakeWebSocket.instances = [];
  const realtimeModel = { provider: "openai-realtime", id: "gpt-realtime-2" };
  const previousModel = { provider: "litellm-anthropic", id: "claude-sonnet-4-5" };
  const models = new Map([
    ["openai-realtime/gpt-realtime-2", realtimeModel],
    ["litellm-anthropic/claude-sonnet-4-5", previousModel],
  ]);
  const { pi, commands, handlers, widgets, setModelCalls, ctx } = makeHarness({ models, initialModel: previousModel });
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  try {
    await commands.get("rt").handler("nolisten", ctx);
    assert.equal(setModelCalls.at(-1)?.provider, realtimeModel.provider);
    assert.equal(setModelCalls.at(-1)?.id, realtimeModel.id);
    assert.ok(widgets.has("realtime-status"));
    assert.equal(FakeWebSocket.instances.length, 1);

    await commands.get("rt-off").handler("", ctx);
    assert.equal(setModelCalls.at(-1), previousModel);
    assert.equal(widgets.has("realtime-status"), false);
  } finally {
    if (previousApiKey === undefined) delete process.env.PI_RT_API_KEY;
    else process.env.PI_RT_API_KEY = previousApiKey;
  }
});

test("realtime module applies the operator PULSE_SERVER default (sgu24:4713)", () => {
  // setEnvDefault runs once at module import: PULSE_SERVER should be populated
  // (either from the host env that pre-existed, or the operator default), and
  // when unset by the host the default must be sgu24:4713. We assert the
  // default is a non-empty server and that the documented operator default
  // value is the wired fallback by re-running the same guarded assignment.
  const orig = process.env.PULSE_SERVER;
  try {
    // Pre-existing value must be preserved (setEnvDefault is non-clobbering).
    process.env.PULSE_SERVER = "explicit-host:9999";
    const setEnvDefault = (key, value) => {
      if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
    };
    setEnvDefault("PULSE_SERVER", "sgu24:4713");
    assert.equal(process.env.PULSE_SERVER, "explicit-host:9999", "explicit PULSE_SERVER must win over the default");
    // When unset, the operator default applies.
    delete process.env.PULSE_SERVER;
    setEnvDefault("PULSE_SERVER", "sgu24:4713");
    assert.equal(process.env.PULSE_SERVER, "sgu24:4713");
  } finally {
    if (orig === undefined) delete process.env.PULSE_SERVER;
    else process.env.PULSE_SERVER = orig;
  }
});

test("realtime forwarding does not re-inject self-authored assistant replies across turns", async () => {
  const { session, ws, items: itemsOf } = await makeForwardingSession();

  // Turn 1: a single typed user message is forwarded as one user item.
  const turn1 = [
    { role: "user", content: [{ type: "text", text: "hello there" }] },
  ];
  session.forwardNewMessages(turn1);
  let items = itemsOf();
  assert.equal(items.length, 1);
  assert.equal(items[0].item.role, "user");
  assert.equal(items[0].item.content[0].text, "hello there");

  // The realtime model produces a reply server-side; Pi appends it to canonical
  // history tagged with this provider + the response id we recorded.
  const responseId = "resp_123";
  session.responseIdsEmittedByModel.add(responseId);

  ws.sent.length = 0;

  // Turn 2: canonical history now includes the prior user turn, the model's own
  // assistant reply, and a fresh user turn. The self-authored assistant message
  // must NOT be re-injected as a conversation.item.create.
  const turn2 = [
    { role: "user", content: [{ type: "text", text: "hello there" }] },
    {
      role: "assistant",
      provider: "openai-realtime",
      responseId,
      content: [{ type: "text", text: "hi, how can I help?" }],
    },
    { role: "user", content: [{ type: "text", text: "what time is it?" }] },
  ];
  session.forwardNewMessages(turn2);
  items = itemsOf();

  // Only the new user message should have been forwarded.
  assert.equal(items.length, 1, "self-authored assistant reply must not be re-forwarded");
  assert.equal(items[0].item.role, "user");
  assert.equal(items[0].item.content[0].text, "what time is it?");

  // A genuinely external assistant message (no realtime provenance) is still
  // forwarded, preserving normal cross-model history replay.
  ws.sent.length = 0;
  session.forwardedMessageCount = 0;
  session.responseIdsEmittedByModel.clear();
  session.forwardNewMessages([
    { role: "assistant", provider: "anthropic", content: [{ type: "text", text: "external reply" }] },
  ]);
  items = itemsOf();
  assert.equal(items.length, 1);
  assert.equal(items[0].item.role, "assistant");
  assert.equal(items[0].item.content[0].text, "external reply");
});

// bd-c360c2: broader multi-turn coverage of the WSS history-forwarding state
// machine — the site of the post-first-turn echo-injection bug.

test("realtime forwarding cursor only emits the new tail each turn", async () => {
  const { session, reset, items: itemsOf } = await makeForwardingSession();

  // Turn 1.
  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "one" }] },
  ]);
  assert.equal(itemsOf().length, 1);
  assert.equal(session.forwardedMessageCount, 1);

  // Turn 2: history grows; only the appended user message is forwarded, never
  // the already-sent prefix.
  reset();
  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "user", content: [{ type: "text", text: "two" }] },
  ]);
  let items = itemsOf();
  assert.equal(items.length, 1, "prefix must not be re-forwarded");
  assert.equal(items[0].item.content[0].text, "two");
  assert.equal(session.forwardedMessageCount, 2);

  // Turn 3: a no-op call (history unchanged) forwards nothing.
  reset();
  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "one" }] },
    { role: "user", content: [{ type: "text", text: "two" }] },
  ]);
  assert.equal(itemsOf().length, 0, "unchanged history forwards nothing");
  assert.equal(session.forwardedMessageCount, 2);
});

test("realtime forwarding dedups model-emitted tool calls but forwards tool results", async () => {
  const { session, reset, items: itemsOf } = await makeForwardingSession();

  // A tool call the live model already emitted server-side: its call_id is in
  // callIdsEmittedByModel, so realtimeCallId returns it unchanged and the
  // assistant tool_call must NOT be re-forwarded as a function_call item.
  const modelCallId = "call_model_emitted";
  session.callIdsEmittedByModel.add(modelCallId);

  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "use a tool" }] },
    {
      role: "assistant",
      provider: "anthropic", // external provenance: text would forward, but...
      content: [
        { type: "text", text: "calling tool" },
        { type: "toolCall", id: modelCallId, name: "do_thing", arguments: { a: 1 } },
      ],
    },
    {
      role: "toolResult",
      toolCallId: modelCallId,
      content: [{ type: "text", text: "tool output" }],
    },
  ]);

  const items = itemsOf();
  const fnCalls = items.filter((m) => m.item.type === "function_call");
  const fnOutputs = items.filter((m) => m.item.type === "function_call_output");
  assert.equal(fnCalls.length, 0, "model-emitted tool call must not be re-forwarded");
  assert.equal(fnOutputs.length, 1, "tool result must be forwarded under the same call_id");
  assert.equal(fnOutputs[0].item.call_id, modelCallId);
  assert.equal(fnOutputs[0].item.output, "tool output");

  // A tool call NOT previously emitted by the model is forwarded (with a
  // remapped/echoed call_id) so cross-model tool history replays correctly.
  reset();
  session.forwardedMessageCount = 0;
  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "again" }] },
    {
      role: "assistant",
      provider: "anthropic",
      content: [{ type: "toolCall", id: "call_external", name: "do_thing", arguments: {} }],
    },
  ]);
  const fnCalls2 = itemsOf().filter((m) => m.item.type === "function_call");
  assert.equal(fnCalls2.length, 1, "external tool call must be forwarded");
  assert.equal(fnCalls2[0].item.name, "do_thing");
});

test("realtime summary forwarding sends only the current turn on first call", async () => {
  const { session, items: itemsOf } = await makeForwardingSession();
  session.config.summaryContext = true;

  // splitCurrentTurn keeps everything from the last user message onward as the
  // current turn; earlier history is summarized into the system prompt instead
  // of forwarded as conversation items.
  const messages = [
    { role: "user", content: [{ type: "text", text: "old question" }] },
    { role: "assistant", provider: "anthropic", content: [{ type: "text", text: "old answer" }] },
    { role: "user", content: [{ type: "text", text: "current question" }] },
  ];
  session.forwardSummaryMessages(messages);

  const items = itemsOf();
  assert.equal(items.length, 1, "only the current-turn user message is forwarded");
  assert.equal(items[0].item.role, "user");
  assert.equal(items[0].item.content[0].text, "current question");
  assert.equal(session.forwardedMessageCount, messages.length);

  // Subsequent summary forwarding falls through to the normal tail cursor.
  const next = [...messages, { role: "user", content: [{ type: "text", text: "follow up" }] }];
  session.forwardSummaryMessages(next);
  const items2 = itemsOf();
  assert.equal(items2.length, 2, "second summary call forwards the new tail");
  assert.equal(items2[1].item.content[0].text, "follow up");
});

test("realtime forwarding replays full history after a cursor reset", async () => {
  const { session, reset, items: itemsOf } = await makeForwardingSession();

  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "first" }] },
  ]);
  assert.equal(session.forwardedMessageCount, 1);

  // Simulate a model_select / compaction reset: cursor and dedup state cleared
  // so the next turn replays the whole (post-reset) history into a fresh WSS.
  reset();
  session.forwardedMessageCount = 0;
  session.callIdsEmittedByModel.clear();
  session.responseIdsEmittedByModel.clear();

  session.forwardNewMessages([
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]);
  const items = itemsOf();
  assert.equal(items.length, 2, "full history replays after a cursor reset");
  assert.deepEqual(items.map((m) => m.item.content[0].text), ["first", "second"]);
});

test("/rt stt local-vad captures, segments, batch-transcribes, and sends a committed turn (bd-9399e7)", async () => {
  // Inject a fake capture (an EventEmitter we drive with PCM chunks) and a fake
  // batch transcribe, mirroring the FakeWebSocket seam for the WSS path, so the
  // whole /rt stt local-vad wiring runs without a mic or the stt binary.
  const captures = [];
  const captureFn = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { proc.killed = true; };
    captures.push(proc);
    return proc;
  };
  const transcribeCalls = [];
  const transcribeFn = async (buf, opts) => {
    transcribeCalls.push({ len: buf.length, model: opts?.model });
    return "hello there";
  };
  __setLocalVadHooksForTest({ capture: captureFn, transcribe: transcribeFn });

  try {
    const { pi, commands, handlers, ctx, sentUserMessages } = makeHarness();
    realtimeAgentExtension(pi);
    handlers.get("session_start")?.({ reason: "startup" }, ctx);

    await commands.get("rt").handler("stt local-vad", ctx);
    const cap = captures.at(-1);
    assert.ok(cap, "local-vad capture was started");

    const pcm = (ms, speech) => {
      const n = Math.round((ms / 1000) * 24000);
      const b = Buffer.alloc(n * 2);
      if (speech) for (let i = 0; i < n; i++) b.writeInt16LE(8000, i * 2);
      return b;
    };
    // 500 ms speech then 3000 ms silence -> one committed turn -> sendUserMessage.
    cap.stdout.emit("data", pcm(500, true));
    for (let i = 0; i < 30; i++) cap.stdout.emit("data", pcm(100, false));

    await waitFor(() => sentUserMessages.length > 0, { timeoutMs: 2000 });
    assert.equal(sentUserMessages.length, 1, "the committed turn was sent as a user message");
    assert.equal(sentUserMessages[0].content, "hello there");
    assert.equal(sentUserMessages[0].options?.deliverAs, "followUp");
    assert.ok(transcribeCalls.length >= 1, "batch transcribe ran over the segment audio");
    assert.equal(transcribeCalls.at(-1).model, "mai-transcribe-1.5", "uses the decoupled batch model, not the realtime model");

    // /rt stt stop ends the capture.
    await commands.get("rt").handler("stt stop", ctx);
    assert.ok(cap.killed, "stop killed the local-vad capture");
  } finally {
    __setLocalVadHooksForTest({});
  }
});

test("/rt stt local-vad surfaces the first transcribe failure to the operator (bd-43512a)", async () => {
  let captured;
  const captureFn = () => {
    captured = new EventEmitter();
    captured.stdout = new EventEmitter();
    captured.stderr = new EventEmitter();
    captured.kill = () => { captured.killed = true; };
    return captured;
  };
  const failingTranscribe = async () => { throw new Error("stt: command not found"); };
  __setLocalVadHooksForTest({ capture: captureFn, transcribe: failingTranscribe });

  try {
    const { pi, commands, handlers, ctx, notifications } = makeHarness();
    realtimeAgentExtension(pi);
    handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await commands.get("rt").handler("stt local-vad", ctx);

    const pcm = (ms, speech) => {
      const n = Math.round((ms / 1000) * 24000);
      const b = Buffer.alloc(n * 2);
      if (speech) for (let i = 0; i < n; i++) b.writeInt16LE(8000, i * 2);
      return b;
    };
    captured.stdout.emit("data", pcm(500, true));
    for (let i = 0; i < 30; i++) captured.stdout.emit("data", pcm(100, false));

    // A failing batch transcribe must surface to the operator exactly once
    // (not stay silent, and not spam on every subsequent failure).
    await waitFor(
      () => notifications.some((n) => /local-vad transcription failed/.test(n.message)),
      { timeoutMs: 2000 },
    );
    const warns = notifications.filter((n) => /local-vad transcription failed/.test(n.message));
    assert.equal(warns.length, 1, "first transcribe failure surfaced once");
    assert.match(warns[0].message, /stt: command not found/);
    assert.equal(warns[0].level, "warning");
  } finally {
    __setLocalVadHooksForTest({});
  }
});
