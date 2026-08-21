import test from "node:test";
import assert from "node:assert/strict";

import {
  CACO_VISITOR_ENTRY_TYPE,
  createCacophonyRuntimeExtension,
  resolveCacophonyRuntimeConfig,
} from "../extensions/cacophony-runtime.js";
import {
  clearCacophonyRuntimeIdentity,
  getCacophonyRuntimeIdentity,
  isPiCacoDisabled,
} from "../extensions/lib/cacophony-runtime.js";
import { createCacophonyChoiceBridge } from "../extensions/lib/cacophony-choice.js";

function harness({ entries = [] } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const messages = [];
  const appended = [];
  const notifications = [];
  const events = [];
  const pi = {
    registerCommand(name, def) { commands.set(name, def); },
    registerMessageRenderer() {},
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    appendEntry(type, data) { appended.push({ type: "custom", customType: type, data }); },
    sendMessage(message, options) { messages.push({ message, options }); },
    events: { emit(name, payload) { events.push({ name, payload }); } },
  };
  const ctx = {
    sessionManager: { getBranch: () => [...entries, ...appended] },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  const emit = async (name) => { for (const fn of handlers.get(name) || []) await fn({}, ctx); };
  return { pi, ctx, commands, handlers, messages, appended, notifications, events, emit };
}

const settle = async () => { await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); };

test("global Cacophony disable and explicit identity resolution are fail closed", () => {
  assert.equal(isPiCacoDisabled({ DISABLE_PI_CACO: "1" }), true);
  const disabled = resolveCacophonyRuntimeConfig({ DISABLE_PI_CACO: "1", CACO_PROJECT: "p", TMUX: "x" }, { agentUtils: { cacophony: { autoRegister: true } } });
  assert.equal(disabled.disabled, true);
  const explicit = resolveCacophonyRuntimeConfig({ CACOPHONY_AGENT_ID: "a", CACOPHONY_PROJECT: "p" }, {});
  assert.equal(explicit.explicitAgentId, "a");
  assert.equal(explicit.project, "p");
});

test("visiting registration requires project and tmux and warns once when tmux is absent", async () => {
  clearCacophonyRuntimeIdentity();
  let calls = 0;
  const h = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl() { calls += 1; },
  })(h.pi);
  await h.emit("session_start");
  await h.emit("session_start");
  assert.equal(calls, 0);
  assert.equal(h.notifications.length, 1);
  assert.match(h.notifications[0].message, /require a tmux pane/);
});

test("successful registration publishes one durable runtime identity and context message", async () => {
  clearCacophonyRuntimeIdentity();
  let calls = 0;
  const h = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils", TMUX: "/tmp/tmux,1,0", CACO_BIN: "caco-test" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl(command, args, _options, callback) {
      calls += 1;
      assert.equal(command, "caco-test");
      assert.deepEqual(args, ["agent", "register", "--project", "agent-utils", "--json"]);
      callback(null, JSON.stringify({ ok: true, data: { id: "visiting-1", project: "agent-utils" } }), "");
    },
  })(h.pi);
  await h.emit("session_start");
  await settle();
  assert.equal(calls, 1);
  assert.equal(h.appended[0].customType, CACO_VISITOR_ENTRY_TYPE);
  assert.deepEqual(getCacophonyRuntimeIdentity({}), {
    agentId: "visiting-1", project: "agent-utils", source: "registration", visiting: true, disabled: false,
  });
  assert.match(h.messages[0].message.content, /visiting agent visiting-1/);
  assert.deepEqual(h.messages[0].options, { deliverAs: "nextTurn" });
  await h.emit("session_shutdown");
  assert.equal(getCacophonyRuntimeIdentity({}).agentId, "", "visiting identity is session-scoped");
});

test("session receipt restores registration without rerunning CLI or duplicating its message", async () => {
  clearCacophonyRuntimeIdentity();
  let calls = 0;
  const entry = {
    type: "custom", customType: CACO_VISITOR_ENTRY_TYPE,
    data: { version: 1, status: "registered", agentId: "visiting-restored", project: "agent-utils" },
  };
  const h = harness({ entries: [entry] });
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils", TMUX: "yes" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl() { calls += 1; },
  })(h.pi);
  await h.emit("session_start");
  assert.equal(calls, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(getCacophonyRuntimeIdentity({}).agentId, "visiting-restored");
});

test("malformed registration never invents an identity and warns once", async () => {
  clearCacophonyRuntimeIdentity();
  const h = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils", TMUX: "yes" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl(_command, _args, _options, callback) { callback(null, JSON.stringify({ ok: true, data: {} }), ""); },
  })(h.pi);
  await h.emit("session_start");
  await settle();
  assert.equal(getCacophonyRuntimeIdentity({}).agentId, "");
  assert.match(h.notifications[0].message, /returned no durable/);
});

test("choice bridge consumes a visiting runtime identity and global disable overrides it", () => {
  clearCacophonyRuntimeIdentity();
  const registered = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils", CACO_AGENT_ID: "managed" }, settings: {},
  })(registered.pi);
  return registered.emit("session_start").then(() => {
    const bridge = createCacophonyChoiceBridge({ env: {}, persisted: {} });
    assert.equal(bridge.config.enabled, true, "choice mirroring reads the shared runtime identity without process-env mutation");
    const managedBridge = createCacophonyChoiceBridge({ env: { CACO_AGENT_ID: "a", CACO_PROJECT: "p" } });
    assert.equal(managedBridge.config.enabled, true);
    const disabledBridge = createCacophonyChoiceBridge({ env: { DISABLE_PI_CACO: "1", CACO_AGENT_ID: "a", CACO_PROJECT: "p" } });
    assert.equal(disabledBridge.config.enabled, false);
  });
});
