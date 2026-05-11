import test from "node:test";
import assert from "node:assert/strict";

import realtimeAgentExtension, {
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

function makeHarness({ models = new Map(), initialModel } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];
  const setModelCalls = [];

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
    on(event, handler) { handlers.set(event, handler); },
    setModel: async (model) => {
      setModelCalls.push(model);
      ctx.model = model;
      return true;
    },
  };

  return { pi, commands, handlers, widgets, statuses, notifications, setModelCalls, ctx };
}

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
