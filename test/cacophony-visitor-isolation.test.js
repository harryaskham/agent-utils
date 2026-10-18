import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";

import { CACO_VISITOR_ENTRY_TYPE, createCacophonyRuntimeExtension } from "../extensions/cacophony-runtime.js";
import { createCacophonyMcpExtension } from "../extensions/cacophony-mcp.js";
import { clearCacophonyRuntimeIdentity, getCacophonyRuntimeIdentity, setCacophonyRuntimeIdentity } from "../extensions/lib/cacophony-runtime.js";
import { createCacophonyChoiceBridge } from "../extensions/lib/cacophony-choice.js";
import { resolveCacophonyDecisionConfig } from "../extensions/lib/cacophony-decision.js";
import { artifactIdentity } from "../extensions/lib/artifact-state.js";

const settle = () => new Promise(resolve => setImmediate(resolve));
function host(sessionId, entries = []) {
  const handlers = new Map(), commands = new Map();
  const messages = [], notifications = [], events = [];
  const pi = {
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    registerCommand(name, def) { commands.set(name, def); },
    registerMessageRenderer() {},
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); },
    sendMessage(message) { messages.push(message); },
    events: { emit(name, data) { events.push({ name, data }); } },
  };
  const ctx = {
    cwd: "/same-checkout",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => entries },
    ui: { notify(message) { notifications.push(message); } },
  };
  return {
    pi, ctx, entries, messages, notifications, events,
    setSessionId(id) { sessionId = id; },
    async fire(name, event = {}) { for (const fn of handlers.get(name) || []) await fn({ type: name, ...event }, ctx); },
    register(args = "") { return commands.get("caco-agent-register").handler(args, ctx); },
    identity(env = {}) { return getCacophonyRuntimeIdentity(env, ctx); },
  };
}
function cli() {
  const calls = [];
  return {
    calls,
    execFileImpl(command, args, options, callback) { calls.push({ command, args, options, callback }); },
    finish(index, overrides = {}) {
      const { args, callback } = calls[index];
      callback(null, JSON.stringify({ data: {
        id: `visitor-${args[args.indexOf("--session-id") + 1]}`,
        project: args[args.indexOf("--project") + 1],
        session_id: args[args.indexOf("--session-id") + 1],
        ...overrides,
      } }), "");
    },
  };
}
const receipt = (data = {}) => ({ type: "custom", customType: CACO_VISITOR_ENTRY_TYPE, data: {
  version: 2, status: "registered", agentId: "parent-visitor", project: "p", sessionId: "parent", ...data,
} });

test("project argument works without env, overrides only the registration default, and restores on restart", async () => {
  for (const env of [{}, { CACO_PROJECT: "default" }, { CACOPHONY_PROJECT: "default" }]) {
    clearCacophonyRuntimeIdentity();
    const before = { ...env }, settings = { agentUtils: { cacophony: { autoRegister: false } } };
    const h = host("explicit"), c = cli();
    createCacophonyRuntimeExtension({ env, settings, execFileImpl: c.execFileImpl })(h.pi);
    const request = h.register("project=tools");
    assert.deepEqual(c.calls[0].args, ["agent", "register", "--project", "tools", "--session-id", "explicit", "--json"]);
    c.finish(0);
    await request;
    await h.register("project=tools");
    assert.equal(c.calls.length, 1);
    assert.deepEqual(env, before);
    assert.deepEqual(settings, { agentUtils: { cacophony: { autoRegister: false } } });
    await h.fire("session_shutdown");
    const restarted = host("explicit", h.entries);
    createCacophonyRuntimeExtension({ env, settings, execFileImpl: c.execFileImpl })(restarted.pi);
    // A no-env restart can discover its own receipt; a configured default still
    // requires the matching explicit project rather than restoring another one.
    if (env.CACO_PROJECT || env.CACOPHONY_PROJECT) await restarted.register("project=tools");
    else await restarted.fire("session_start");
    assert.equal(restarted.identity().project, "tools");
    assert.equal(c.calls.length, 1);
    assert.equal(restarted.messages.length, 0);
    await restarted.fire("session_shutdown");
  }
});

test("no argument keeps configured project; malformed arguments never invoke CLI", async () => {
  const h = host("default"), c = cli();
  createCacophonyRuntimeExtension({ env: { CACOPHONY_PROJECT: "configured" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  for (const arg of ["tools", "project=", "project=p extra", "project=p project=q", "project=p=q"]) await h.register(arg);
  assert.equal(c.calls.length, 0);
  const request = h.register();
  assert.equal(c.calls[0].args[3], "configured");
  c.finish(0);
  await request;
  await h.fire("session_shutdown");
});

test("fork does not inherit a parent's receipt or PI session environment", async () => {
  const h = host("fork", [receipt()]), c = cli();
  const env = { CACO_PROJECT: "p", PI_SESSION_ID: "parent", PI_SESSION_FILE: "/parent/session.jsonl" };
  createCacophonyRuntimeExtension({ env, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  const request = h.register();
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].args[c.calls[0].args.indexOf("--session-id") + 1], "fork");
  c.finish(0);
  await request;
  assert.equal(h.identity().agentId, "visitor-fork");
  assert.equal(h.entries.at(-1).data.sessionId, "fork");
  await h.fire("session_shutdown");
});

test("legacy receipts lacking session provenance are not restored", async () => {
  const h = host("legacy", [receipt({ sessionId: undefined, version: 1 })]), c = cli();
  createCacophonyRuntimeExtension({ env: { CACO_PROJECT: "p" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  const request = h.register();
  assert.equal(c.calls.length, 1);
  c.finish(0);
  await request;
  assert.equal(h.identity().agentId, "visitor-legacy");
  await h.fire("session_shutdown");
});

test("missing live session ID fails closed even with inherited PI_SESSION_ID", async () => {
  const h = host(""), c = cli();
  createCacophonyRuntimeExtension({ env: { CACO_PROJECT: "p", PI_SESSION_ID: "parent" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  await h.register();
  assert.equal(c.calls.length, 0);
  assert.match(h.notifications[0], /getSessionId/);
});

for (const reason of ["new", "resume", "fork"]) {
  test(`session_start(${reason}) invalidates visitor fallback and fences old async completion/finalizer`, async () => {
    const h = host("old"), c = cli();
    createCacophonyRuntimeExtension({ env: { CACO_PROJECT: "p", PI_CACO_AUTO_REGISTER: "1" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
    await h.fire("session_start");
    h.setSessionId("new");
    await h.fire("session_start", { reason });
    assert.equal(c.calls.length, 2);
    c.finish(0);
    await settle();
    assert.equal(h.entries.length, 0);
    assert.equal(h.messages.length, 0);
    assert.equal(h.events.length, 0);
    assert.equal(h.identity().agentId, "");
    const sameFlight = h.register();
    assert.equal(c.calls.length, 2, "old finalizer must not clear new single-flight");
    c.finish(1);
    await sameFlight;
    assert.equal(h.identity().agentId, "visitor-new");
    assert.equal(h.entries.length, 1);
    await h.fire("session_shutdown");
  });
}

test("completed registration is cleared on fork and switching back restores only the matching receipt", async () => {
  const h = host("parent"), c = cli();
  createCacophonyRuntimeExtension({ env: { CACO_PROJECT: "p" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  const parent = h.register(); c.finish(0); await parent;
  h.setSessionId("child"); await h.fire("session_start", { reason: "fork" });
  assert.equal(h.identity().agentId, "");
  const child = h.register(); c.finish(1); await child;
  h.setSessionId("parent"); await h.fire("session_start", { reason: "resume" });
  assert.equal(h.identity().agentId, "visitor-parent");
  assert.equal(c.calls.length, 2);
  await h.fire("session_shutdown");
});

test("shutdown ignores late success/failure and does not attach to a restarted session", async () => {
  const h = host("same"), c = cli();
  createCacophonyRuntimeExtension({ env: { CACO_PROJECT: "p", PI_CACO_AUTO_REGISTER: "1" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  await h.fire("session_start");
  await h.fire("session_shutdown");
  await h.fire("session_start");
  c.finish(0);
  await settle();
  assert.equal(h.messages.length, 0);
  c.finish(1);
  await settle();
  assert.equal(h.identity().agentId, "visitor-same");
  await h.fire("session_shutdown");
});

test("four concurrent logical sessions in one cwd keep runtime identity, consumers, MCP, and shutdown separate", async () => {
  clearCacophonyRuntimeIdentity();
  const storage = new AsyncLocalStorage();
  // Model Pi-Daemon's stable process.env proxy with async-local values. No live
  // session/process environment is touched and no real CLI/daemon is called.
  const env = new Proxy({}, { get(_target, key) { return storage.getStore()?.[key]; } });
  const c = cli();
  const extension = createCacophonyRuntimeExtension({ env, settings: {}, execFileImpl: c.execFileImpl });
  const sessions = Array.from({ length: 4 }, (_, index) => {
    const h = host(`foreign-${index}`);
    const values = { CACO_PROJECT: "p", PI_CACO_AUTO_REGISTER: "1", PI_CACO_RUNTIME_AGENT_ID: `pd-${index}`, PI_SESSION_ID: "inherited-parent" };
    const registrations = [], disposals = [];
    const run = fn => storage.run(values, fn);
    run(() => {
      extension(h.pi);
      createCacophonyMcpExtension({ env, registerServer(plan) {
        registrations.push(plan);
        return { async dispose() { disposals.push(plan); } };
      } })(h.pi);
    });
    return { h, values, run, registrations, disposals };
  });
  await Promise.all(sessions.map(({ h, run }) => run(() => h.fire("session_start"))));
  assert.equal(c.calls.length, 4);
  // Reverse completion order exposes module-global fallback/listener bugs.
  for (let i = 3; i >= 0; i--) sessions[i].run(() => c.finish(i, { runtime_agent_id: `pd-${i}` }));
  await settle(); await settle();
  for (let i = 0; i < 4; i++) {
    const { h, run, registrations, values } = sessions[i];
    const args = c.calls[i].args;
    assert.equal(args[args.indexOf("--runtime-agent-id") + 1], `pd-${i}`);
    assert.equal(c.calls[i].options.cwd, "/same-checkout");
    run(() => {
      assert.equal(h.identity(env).agentId, `visitor-foreign-${i}`);
      assert.equal(getCacophonyRuntimeIdentity(env).agentId, "", "unscoped consumers cannot borrow any visitor");
      assert.equal(createCacophonyChoiceBridge({ env, scope: h.ctx }).config.agentId, `visitor-foreign-${i}`);
      assert.equal(resolveCacophonyDecisionConfig(env, {}, {}, h.ctx).agentId, `visitor-foreign-${i}`);
      assert.equal(artifactIdentity(h.pi, h.ctx, env).agent, `visitor-foreign-${i}`);
    });
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].definition.env.CACO_AGENT_ID, `visitor-foreign-${i}`);
    assert.equal(h.entries[0].data.runtimeAgentId, `pd-${i}`);
    assert.equal(values.CACO_AGENT_ID, undefined);
    assert.equal(values.PI_CACO_RUNTIME_AGENT_ID, `pd-${i}`);
  }
  await sessions[0].run(() => sessions[0].h.fire("session_shutdown"));
  assert.equal(sessions[0].disposals.length, 1);
  for (let i = 1; i < 4; i++) {
    assert.equal(sessions[i].disposals.length, 0);
    assert.equal(sessions[i].h.identity().agentId, `visitor-foreign-${i}`);
    await sessions[i].run(() => sessions[i].h.fire("session_shutdown"));
  }
});

test("overlapping reload runtimes fence predecessor completion and shutdown for the same session", async () => {
  const old = host("reload"), next = host("reload"), c = cli();
  const options = { env: { CACO_PROJECT: "p" }, settings: {}, execFileImpl: c.execFileImpl };
  createCacophonyRuntimeExtension(options)(old.pi);
  const first = old.register();
  createCacophonyRuntimeExtension(options)(next.pi);
  const second = next.register();
  c.finish(1); await second;
  c.finish(0); await first;
  assert.equal(old.messages.length, 0);
  assert.equal(old.entries.length, 0);
  assert.equal(next.messages.length, 1);
  await old.fire("session_shutdown");
  assert.equal(next.identity().agentId, "visitor-reload");
  await next.fire("session_shutdown");
});

test("MCP invalidation disposes only its scoped child and a slow adapter load cannot publish stale identity", async () => {
  const h = host("mcp-old");
  let loaded, registrations = 0;
  createCacophonyMcpExtension({ env: {}, loadRegister: () => new Promise(resolve => { loaded = resolve; }) })(h.pi);
  await h.fire("session_start");
  setCacophonyRuntimeIdentity({ agentId: "old", project: "p", visiting: true }, h.ctx);
  await settle();
  h.setSessionId("mcp-new"); await h.fire("session_start", { reason: "new" });
  loaded(() => { registrations++; return { async dispose() {} }; });
  await settle(); await settle();
  assert.equal(registrations, 0);
  await h.fire("session_shutdown");
  clearCacophonyRuntimeIdentity("mcp-old");
});

test("managed environment wins over visiting receipts, project arg, and runtime provenance", async () => {
  const h = host("managed", [receipt({ sessionId: "managed" })]), c = cli();
  const env = { CACO_PROJECT: "managed-project", CACO_AGENT_ID: "managed-agent", PI_CACO_RUNTIME_AGENT_ID: "external-pd" };
  createCacophonyRuntimeExtension({ env, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  await h.register("project=other");
  assert.equal(c.calls.length, 0);
  assert.equal(h.identity(env).agentId, "managed-agent");
  assert.equal(h.identity(env).visiting, false);
  assert.equal(h.identity().agentId, "", "managed identity must not populate another session's fallback");
});

test("DISABLE_PI_CACO blocks explicit project and late registration without affecting a foreign session", async () => {
  const h = host("disabled"), c = cli(), env = { DISABLE_PI_CACO: "1" };
  createCacophonyRuntimeExtension({ env, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
  await h.register("project=p");
  assert.equal(c.calls.length, 0);
  delete env.DISABLE_PI_CACO;
  // Startup disable is immutable for this extension instance.
  await h.register("project=p");
  assert.equal(c.calls.length, 0);
  const liveEnv = { CACO_PROJECT: "p" }, live = host("live");
  createCacophonyRuntimeExtension({ env: liveEnv, settings: {}, execFileImpl: c.execFileImpl })(live.pi);
  const request = live.register();
  liveEnv.DISABLE_PI_CACO = "1";
  c.finish(0); await request;
  assert.equal(live.messages.length, 0);
  assert.equal(live.identity(liveEnv).disabled, true);
  assert.equal(setCacophonyRuntimeIdentity({ agentId: "other", project: "p", visiting: true }, "unaffected"), true);
  assert.equal(getCacophonyRuntimeIdentity({}, "unaffected").agentId, "other");
  clearCacophonyRuntimeIdentity("unaffected");
});

test("receipt/response provenance mismatches are rejected and never use an abandoned branch", async () => {
  for (const overrides of [{ project: "wrong" }, { session_id: "wrong" }, { runtime_agent_id: "wrong" }]) {
    const h = host("response"), c = cli();
    h.ctx.sessionManager.getEntries = () => [receipt({ sessionId: "response" })];
    createCacophonyRuntimeExtension({ env: { CACO_PROJECT: "p" }, settings: {}, execFileImpl: c.execFileImpl })(h.pi);
    const request = h.register(); c.finish(0, overrides); await request;
    assert.equal(h.identity().agentId, "");
    assert.equal(h.entries.length, 0);
    assert.equal(h.notifications.length, 1);
  }
});
