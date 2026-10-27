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

function harness({ entries = [], sessionId = "pi-session", sessionName } = {}) {
  const commands = new Map();
  const handlers = new Map();
  const messages = [];
  const appended = [];
  const notifications = [];
  const events = [];
  const bus = new Map();
  const pi = {
    getSessionName() { return sessionName; },
    registerCommand(name, def) { commands.set(name, def); },
    registerMessageRenderer() {},
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    appendEntry(type, data) { appended.push({ type: "custom", customType: type, data }); },
    sendMessage(message, options) { messages.push({ message, options }); },
    events: {
      emit(name, payload) { events.push({ name, payload }); for (const fn of bus.get(name) || []) fn(payload); },
      on(name, fn) { const list = bus.get(name) || []; list.push(fn); bus.set(name, list); return () => {}; },
    },
  };
  const ctx = {
    cwd: "/projects/actual-project",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => [...entries, ...appended] },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  const emit = async (name) => { for (const fn of handlers.get(name) || []) await fn({}, ctx); };
  return { pi, ctx, commands, handlers, messages, appended, notifications, events, emit,
    setSessionName(name) { sessionName = name; },
  };
}

const settle = async () => { await Promise.resolve(); await new Promise((resolve) => setImmediate(resolve)); };

test("/migrate into pi-daemon carries the registered visitor's identity (bd-737651)", async () => {
  clearCacophonyRuntimeIdentity();
  const env = { CACO_PROJECT: "p", TMUX: "yes", PI_CACO_AUTO_REGISTER: "0" };
  const h = harness({ sessionId: "pi-migrating" });
  const options = {
    env, settings: {},
    execFileImpl(_command, _args, _options, callback) { setImmediate(() => callback(null, JSON.stringify({ id: "visiting-tui", project: "p" }), "")); },
  };
  createCacophonyRuntimeExtension(options)(h.pi);
  await h.emit("session_start");
  const carried = {};
  const migrate = () => h.pi.events.emit("pi-durable:migrate", { carry: (vars) => Object.assign(carried, vars) });
  migrate();
  assert.deepEqual(carried, {}, "nothing to carry before registration");
  await h.commands.get("caco-agent-register").handler("", h.ctx);
  migrate();
  assert.deepEqual(carried, { CACO_AGENT_ID: "visiting-tui", CACO_PROJECT: "p" });
});

test("manual registration works with auto-registration off and deduplicates concurrent requests and reload", async () => {
  clearCacophonyRuntimeIdentity();
  const env = { CACO_PROJECT: "p", TMUX: "yes", PI_CACO_AUTO_REGISTER: "0" };
  const h = harness({ sessionName: "Before /name" });
  let calls = 0;
  let complete;
  const options = {
    env, settings: {},
    execFileImpl(_command, args, _options, callback) {
      calls++;
      assert.equal(args[args.indexOf("--session-name") + 1], "Live /name");
      complete = callback;
    },
  };
  createCacophonyRuntimeExtension(options)(h.pi);
  await h.emit("session_start");
  assert.equal(calls, 0);
  await h.commands.get("caco-runtime").handler("", h.ctx);
  assert.match(h.notifications.at(-1).message, /auto-registration off; use \/caco-agent-register/);
  const register = () => h.commands.get("caco-agent-register").handler("", h.ctx);
  h.setSessionName("Live /name");
  const first = register();
  const second = register();
  assert.equal(calls, 1);
  complete(null, JSON.stringify({ id: "visitor", project: "p" }), "");
  await Promise.all([first, second]);
  h.setSessionName("Renamed after registration");
  await register();
  assert.equal(calls, 1);
  assert.equal(h.appended.length, 1);
  assert.equal(h.events.length, 1);
  await h.emit("session_shutdown");
  const restored = harness({ entries: h.appended, sessionName: "Renamed on reload" });
  createCacophonyRuntimeExtension(options)(restored.pi);
  await restored.emit("session_start");
  assert.equal(getCacophonyRuntimeIdentity(env, restored.ctx).agentId, "visitor");
  assert.equal(calls, 1);
  assert.equal(restored.messages.length, 0);
  await restored.emit("session_shutdown");
});

test("manual command preserves the global disable; without a project it infers one or refuses", async () => {
  clearCacophonyRuntimeIdentity();
  const off = harness();
  let calls = 0;
  createCacophonyRuntimeExtension({ env: { DISABLE_PI_CACO: "1", CACO_PROJECT: "p", TMUX: "yes" }, settings: {}, execFileImpl() { calls++; } })(off.pi);
  await off.commands.get("caco-agent-register").handler("", off.ctx);
  assert.equal(calls, 0);
  assert.match(off.notifications.at(-1).message, /disabled by DISABLE_PI_CACO/);

  // A directory whose remotes match no configured project is never registered under its path.
  clearCacophonyRuntimeIdentity();
  const bare = harness();
  const previews = [];
  createCacophonyRuntimeExtension({
    env: { TMUX: "yes" }, settings: {},
    execFileImpl(_command, args, _options, callback) {
      previews.push(args);
      setImmediate(() => callback(null, JSON.stringify({ ok: true, preview: true, project: "--projects-actual-project", project_source: "derived path name" }), ""));
    },
  })(bare.pi);
  await bare.commands.get("caco-agent-register").handler("", bare.ctx);
  await settle();
  assert.deepEqual(previews, [["agent", "register", "--preview", "--checkout-root", "/projects/actual-project", "--session-id", "pi-session", "--json"]]);
  assert.match(bare.notifications.at(-1).message, /registration failed: no configured Cacophony project matches the git remotes/);
  assert.equal(getCacophonyRuntimeIdentity({}, bare.ctx).agentId, "");

  // Auto-registration never infers: it needs a configured project.
  clearCacophonyRuntimeIdentity();
  const auto = harness();
  let autoCalls = 0;
  createCacophonyRuntimeExtension({ env: { TMUX: "yes" }, settings: { agentUtils: { cacophony: { autoRegister: true } } }, execFileImpl() { autoCalls++; } })(auto.pi);
  await auto.emit("session_start");
  await settle();
  assert.equal(autoCalls, 0);
});

test("/caco-agent-register infers the checkout's project and replaces a refused one with the sole match", async () => {
  clearCacophonyRuntimeIdentity();
  const h = harness();
  const calls = [];
  createCacophonyRuntimeExtension({
    env: { TMUX: "yes" }, settings: {},
    execFileImpl(_command, args, _options, callback) {
      calls.push(args);
      const project = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
      setImmediate(() => {
        if (args.includes("--preview")) return callback(null, JSON.stringify({ ok: true, project: "android-utils", project_source: "cwd git remote" }), "");
        if (project === "tools") return callback(new Error("exit 1"), "", "error: visiting project 'tools' conflicts with caller checkout git remotes; matching configured projects: android-utils. Pass --project with one of these candidates");
        callback(null, JSON.stringify({ id: `visiting-${project}`, project }), "");
      });
    },
  })(h.pi);
  await h.commands.get("caco-agent-register").handler("", h.ctx);
  await settle();
  assert.deepEqual(calls.map((args) => args.includes("--preview") ? "preview" : args[args.indexOf("--project") + 1]), ["preview", "android-utils"]);
  assert.equal(getCacophonyRuntimeIdentity({}, h.ctx).project, "android-utils");
  assert.ok(h.notifications.some((n) => n.message === "Cacophony project android-utils: inferred from this checkout's git remotes."), JSON.stringify(h.notifications));

  clearCacophonyRuntimeIdentity();
  const named = harness({ sessionId: "pi-named" });
  calls.length = 0;
  createCacophonyRuntimeExtension({
    env: { TMUX: "yes" }, settings: {},
    execFileImpl(_command, args, _options, callback) {
      calls.push(args);
      const project = args[args.indexOf("--project") + 1];
      setImmediate(() => project === "tools"
        ? callback(new Error("exit 1"), "", "error: visiting project 'tools' conflicts with caller checkout git remotes; matching configured projects: android-utils. Pass --project with one of these candidates")
        : callback(null, JSON.stringify({ id: `visiting-${project}`, project }), ""));
    },
  })(named.pi);
  await named.commands.get("caco-agent-register").handler("project=tools", named.ctx);
  await settle();
  assert.deepEqual(calls.map((args) => args[args.indexOf("--project") + 1]), ["tools", "android-utils"]);
  assert.equal(getCacophonyRuntimeIdentity({}, named.ctx).project, "android-utils");
  assert.ok(named.notifications.some((n) => /tools does not match this checkout's git remotes; android-utils is the only configured project they match/.test(n.message)), JSON.stringify(named.notifications));
});

test("global Cacophony disable and explicit identity resolution are fail closed", () => {
  assert.equal(isPiCacoDisabled({ DISABLE_PI_CACO: "1" }), true);
  const disabled = resolveCacophonyRuntimeConfig({ DISABLE_PI_CACO: "1", CACO_PROJECT: "p", TMUX: "x" }, { agentUtils: { cacophony: { autoRegister: true } } });
  assert.equal(disabled.disabled, true);
  const explicit = resolveCacophonyRuntimeConfig({ CACOPHONY_AGENT_ID: "a", CACOPHONY_PROJECT: "p" }, {});
  assert.equal(explicit.explicitAgentId, "a");
  assert.equal(explicit.project, "p");
});

test("visiting registration supports non-tmux hosts and uses the session cwd", async () => {
  clearCacophonyRuntimeIdentity();
  let calls = 0;
  const h = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl(_command, _args, options, callback) {
      calls += 1;
      assert.equal(options.cwd, h.ctx.cwd);
      callback(null, JSON.stringify({ id: "herdr-visitor", project: "agent-utils" }), "");
    },
  })(h.pi);
  await h.emit("session_start");
  await settle();
  await h.emit("session_start");
  assert.equal(calls, 1);
  assert.equal(getCacophonyRuntimeIdentity({}, h.ctx).agentId, "herdr-visitor");
  await h.emit("session_shutdown");
});

test("successful registration publishes one durable runtime identity and context message", async () => {
  clearCacophonyRuntimeIdentity();
  let calls = 0;
  const h = harness({ sessionName: "  Parser work / café; $(not-a-shell)  " });
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils", TMUX: "/tmp/tmux,1,0", CACO_BIN: "caco-test", PI_SESSION_NAME: "server-name" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl(command, args, _options, callback) {
      calls += 1;
      assert.equal(command, "caco-test");
      assert.deepEqual(args, ["agent", "register", "--project", "agent-utils", "--session-id", "pi-session", "--session-name", "Parser work / café; $(not-a-shell)", "--json"]);
      callback(null, JSON.stringify({ ok: true, data: { id: "visiting-1", project: "agent-utils" } }), "");
    },
  })(h.pi);
  await h.emit("session_start");
  await settle();
  assert.equal(calls, 1);
  assert.equal(h.appended[0].customType, CACO_VISITOR_ENTRY_TYPE);
  assert.deepEqual(getCacophonyRuntimeIdentity({}, h.ctx), {
    agentId: "visiting-1", project: "agent-utils", source: "registration", visiting: true, sessionId: "pi-session", disabled: false,
  });
  assert.match(h.messages[0].message.content, /visiting agent visiting-1/);
  assert.deepEqual(h.messages[0].options, { deliverAs: "nextTurn" });
  await h.emit("session_shutdown");
  assert.equal(getCacophonyRuntimeIdentity({}, h.ctx).agentId, "", "visiting identity is session-scoped");
});

test("unnamed or unavailable live metadata never borrows a name from IDs or environment", async () => {
  for (const getSessionName of [undefined, () => undefined, () => "", () => " \t ", () => null, () => 42, () => { throw new Error("unavailable"); }]) {
    clearCacophonyRuntimeIdentity();
    const h = harness({ sessionId: "37e41c34-558f-4bb5-b31c-e1bd4d3956c5" });
    h.pi.getSessionName = getSessionName;
    let calls = 0;
    createCacophonyRuntimeExtension({
      env: { CACO_PROJECT: "p", PI_SESSION_NAME: "parent name", PI_SESSION_TITLE: "server title", PI_SESSION_ID: "parent", PI_CACO_RUNTIME_AGENT_ID: "pd-external" },
      settings: {},
      execFileImpl(_command, args, options, callback) {
        calls++;
        assert.deepEqual(args, ["agent", "register", "--project", "p", "--session-id", h.ctx.sessionManager.getSessionId(), "--runtime-agent-id", "pd-external", "--json"]);
        assert.equal(options.cwd, h.ctx.cwd);
        callback(null, JSON.stringify({ id: "visiting-unnamed", project: "p" }), "");
      },
    })(h.pi);
    await h.commands.get("caco-agent-register").handler("", h.ctx);
    assert.equal(calls, 1);
    await h.emit("session_shutdown");
  }
});

test("session receipt restores registration without rerunning CLI or duplicating its message", async () => {
  clearCacophonyRuntimeIdentity();
  let calls = 0;
  const entry = {
    type: "custom", customType: CACO_VISITOR_ENTRY_TYPE,
    data: { version: 2, status: "registered", agentId: "visiting-restored", project: "agent-utils", sessionId: "pi-session" },
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
  assert.equal(getCacophonyRuntimeIdentity({}, h.ctx).agentId, "visiting-restored");
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
  assert.equal(getCacophonyRuntimeIdentity({}, h.ctx).agentId, "");
  assert.match(h.notifications[0].message, /returned no durable/);
});

test("choice bridge consumes a visiting runtime identity and global disable overrides it", async () => {
  clearCacophonyRuntimeIdentity();
  const registered = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "agent-utils", PI_CACO_AUTO_REGISTER: "1" }, settings: {},
    execFileImpl(_command, _args, _options, callback) { callback(null, JSON.stringify({ id: "visitor", project: "agent-utils" }), ""); },
  })(registered.pi);
  await registered.emit("session_start");
  await settle();
  {
    const bridge = createCacophonyChoiceBridge({ env: {}, persisted: {}, scope: registered.ctx });
    assert.equal(bridge.config.enabled, true, "choice mirroring reads the shared runtime identity without process-env mutation");
    const managedBridge = createCacophonyChoiceBridge({ env: { CACO_AGENT_ID: "a", CACO_PROJECT: "p" } });
    assert.equal(managedBridge.config.enabled, true);
    const disabledBridge = createCacophonyChoiceBridge({ env: { DISABLE_PI_CACO: "1", CACO_AGENT_ID: "a", CACO_PROJECT: "p" } });
    assert.equal(disabledBridge.config.enabled, false);
  }
  await registered.emit("session_shutdown");
});

test("registration injects Cacophony's visiting guidance into the context message", async () => {
  clearCacophonyRuntimeIdentity();
  const env = { CACO_PROJECT: "cacophony" };
  const before = { ...env };
  const h = harness();
  const guidance = "## Visiting agent\n\nUse CACOPHONY_ACTOR=visiting-g; publish regular PRs.";
  createCacophonyRuntimeExtension({
    env,
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { id: "visiting-g", project: "cacophony" }, guidance: { profile: "visiting", text: `${guidance}\n` } }), "");
    },
  })(h.pi);
  await h.emit("session_start");
  await settle();
  const message = h.messages[0].message;
  assert.match(message.content, /^Registered as Cacophony visiting agent visiting-g in project cacophony\.\n\n## Visiting agent/);
  assert.ok(message.content.endsWith("publish regular PRs."), "guidance is passed through trimmed");
  assert.equal(message.details.guidance, true);
  assert.equal(h.notifications.at(-1).message, "Registered as Cacophony visiting agent visiting-g in project cacophony.");
  assert.deepEqual(env, before, "guidance never changes the parent environment");
  await h.emit("session_shutdown");
});

test("registration without guidance keeps the one-line message", async () => {
  clearCacophonyRuntimeIdentity();
  const h = harness();
  createCacophonyRuntimeExtension({
    env: { CACO_PROJECT: "cacophony" },
    settings: { agentUtils: { cacophony: { autoRegister: true } } },
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { id: "visiting-old", project: "cacophony" } }), "");
    },
  })(h.pi);
  await h.emit("session_start");
  await settle();
  assert.equal(h.messages[0].message.content, "Registered as Cacophony visiting agent visiting-old in project cacophony.");
  assert.equal(h.messages[0].message.details.guidance, false);
  await h.emit("session_shutdown");
});
