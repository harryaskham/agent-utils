import test from "node:test";
import assert from "node:assert/strict";

import { readFile } from "node:fs/promises";

async function loadRealtimeModuleForTest() {
  const source = await readFile(new URL("../extensions/realtime-agent.js", import.meta.url), "utf8");
  const testableSource = source.replace(
    'import WebSocket from "ws";',
    'class WebSocket { static OPEN = 1; constructor() { this.readyState = WebSocket.OPEN; } on() {} once() {} off() {} send() {} close() {} }',
  );
  const encoded = Buffer.from(testableSource, "utf8").toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

async function loadRealtimeExtensionForTest() {
  const module = await loadRealtimeModuleForTest();
  return module.default;
}

function makeHarness() {
  const commands = new Map();
  const handlers = new Map();
  const widgets = new Map();
  const statuses = new Map();
  const notifications = [];

  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    getCommand(name) { return commands.get(name); },
    registerMessageRenderer() {},
    registerProvider() {},
    on(event, handler) { handlers.set(event, handler); },
    setModel: async () => true,
  };

  const ctx = {
    model: { provider: "litellm-anthropic", id: "claude-sonnet-4-5" },
    modelRegistry: { find: () => undefined },
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

  return { pi, commands, handlers, widgets, statuses, notifications, ctx };
}

test("/rt-hide-status keeps the realtime widget hidden across later status updates", async () => {
  const realtimeAgentExtension = await loadRealtimeExtensionForTest();
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
  const realtimeAgentExtension = await loadRealtimeExtensionForTest();
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
  const realtimeAgentExtension = await loadRealtimeExtensionForTest();
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
  const realtimeAgentExtension = await loadRealtimeExtensionForTest();
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
    const module = await loadRealtimeModuleForTest();
    assert.deepEqual(module.buildServerVadTurnDetection(), {
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
