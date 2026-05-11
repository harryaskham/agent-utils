import test from "node:test";
import assert from "node:assert/strict";

import realtimeAgentExtension, {
  RealtimeStateController,
  buildServerVadTurnDetection,
  setRealtimeWebSocketConstructor,
} from "../extensions/realtime-agent.js";

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
  const handlers = new Map();
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];
  const setModelCalls = [];
  const emittedEvents = [];

  const ctx = {
    model: initialModel || { provider: "litellm-anthropic", id: "claude-sonnet-4-5" },
    modelRegistry: { find: (provider, id) => models.get(`${provider}/${id}`) },
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
    registerProvider() {},
    events: { emit: (name, payload) => emittedEvents.push({ name, payload }) },
    on(event, handler) { handlers.set(event, handler); },
    setModel: async (model) => {
      setModelCalls.push(model);
      ctx.model = model;
      return true;
    },
  };

  return { pi, commands, handlers, widgets, statuses, notifications, setModelCalls, emittedEvents, ctx };
}

test("extension exposes unified realtime controls on pi and the event bus", () => {
  const { pi, emittedEvents } = makeHarness();
  realtimeAgentExtension(pi);

  assert.equal(typeof pi.realtime.snapshot, "function");
  assert.equal(typeof pi.realtime.setAudio, "function");
  assert.equal(typeof pi.realtime.setVoice, "function");
  assert.equal(typeof pi.realtime.diagnostics, "function");
  assert.equal(typeof pi.realtime.options, "function");
  assert.equal(typeof pi.realtime.usage, "function");
  assert.equal(pi.realtime.help(), pi.realtime.usage());
  assert.match(pi.realtime.usage(), /\/rt start \[vad\|ptt\|nolisten\]/);
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
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt-doctor").handler("", ctx);

  const message = notifications.at(-1)?.message || "";
  assert.match(message, /Realtime doctor/);
  assert.match(message, /provider:/);
  assert.match(message, /audioBackend: pulse/);
  assert.match(message, /pulse: PULSE_SERVER=/);
  assert.match(message, /commands:/);
  assert.match(message, /hint:/);
  assert.match(message, /Pulse is the default backend|Pulse-first setup active/);
  assert.ok(widgets.has("realtime-status"));
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

test("/rt rejects unsupported status modes without showing the widget", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);
  pi.realtime.hideStatus(ctx);

  await commands.get("rt").handler("status ful", ctx);
  assert.match(notifications.at(-1).message, /Unsupported realtime status mode/);
  assert.equal(widgets.has("realtime-status"), false);
});

test("/rt help reports unified usage and /rt stt stop exits transcription mode", async () => {
  const { pi, commands, handlers, widgets, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("help", ctx);
  assert.match(notifications.at(-1).message, /Usage: \/rt start/);
  assert.match(notifications.at(-1).message, /\/rt stt \[vad\|ptt\|stop\]/);

  pi.realtime.setSttOnly(true, ctx);
  pi.realtime.showStatus(ctx);
  assert.equal(pi.realtime.snapshot().sttOnly, true);
  assert.ok(widgets.has("realtime-status"));

  await commands.get("rt").handler("stt stop", ctx);
  assert.equal(pi.realtime.snapshot().sttOnly, false);
  assert.equal(widgets.has("realtime-status"), false);
  assert.match(notifications.at(-1).message, /Realtime STT stopped/);
});

test("/rt status full and doctor subcommands expose diagnostics", async () => {
  const { pi, commands, handlers, notifications, ctx } = makeHarness();
  realtimeAgentExtension(pi);
  handlers.get("session_start")?.({ reason: "startup" }, ctx);

  await commands.get("rt").handler("status full", ctx);
  assert.match(notifications.at(-1).message, /Realtime doctor/);

  await commands.get("rt").handler("doctor", ctx);
  assert.match(notifications.at(-1).message, /Realtime doctor/);
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
    assert.equal(setModelCalls.at(-1), realtimeModel);
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
