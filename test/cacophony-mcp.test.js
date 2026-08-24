import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  createCacophonyMcpExtension,
  createScopedAdapterRegistrar,
  scopedAdapterPi,
} from "../extensions/cacophony-mcp.js";
import { createCacophonyRuntimeExtension } from "../extensions/cacophony-runtime.js";
import {
  clearCacophonyRuntimeIdentity,
  setCacophonyRuntimeIdentity,
} from "../extensions/lib/cacophony-runtime.js";
import { buildCacophonyMcpRegistration } from "../extensions/lib/cacophony-mcp.js";

function harness() {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const messages = [];
  const entries = [];
  const pi = {
    on(name, handler) { const list = handlers.get(name) || []; list.push(handler); handlers.set(name, list); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerMessageRenderer() {},
    appendEntry(type, data) { entries.push({ type: "custom", customType: type, data }); },
    sendMessage(message) { messages.push(message); },
    events: { emit() {} },
  };
  const ctx = {
    ui: { notify(message, level) { notifications.push({ message, level }); } },
    sessionManager: { getBranch: () => entries },
  };
  const fire = async (name, event = {}) => {
    for (const handler of handlers.get(name) || []) await handler(event, ctx);
  };
  return { pi, ctx, commands, notifications, messages, entries, fire };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("installed Agent Utils layout owns a resolvable TypeScript-capable adapter dependency", async () => {
  const require = createRequire(import.meta.url);
  assert.match(require.resolve("pi-mcp-adapter"), /node_modules[\\/]pi-mcp-adapter[\\/]index\.ts$/);
  assert.match(require.resolve("jiti"), /node_modules[\\/]jiti/);
  const { createJiti } = await import("jiti");
  const adapter = await createJiti(import.meta.url).import("pi-mcp-adapter");
  assert.equal(typeof adapter.createMcpAdapter, "function");
});

test("2.25 compatibility registrar isolates the Cacophony proxy tool and commands", () => {
  const tools = [];
  const commands = [];
  const active = ["read", "mcp"];
  const pi = {
    registerTool(definition) { tools.push(definition); },
    registerCommand(name) { commands.push(name); },
    getActiveTools() { return active; },
    setActiveTools(names) { this.active = names; },
    getAllTools() { return [{ name: "caco_mcp" }, { name: "read" }]; },
  };
  const facade = scopedAdapterPi(pi);
  facade.registerTool({ name: "mcp", label: "MCP" });
  facade.registerCommand("mcp", {});
  assert.equal(tools[0].name, "caco_mcp");
  assert.equal(tools[0].label, "Cacophony MCP");
  assert.deepEqual(commands, ["caco-mcp"]);
  assert.deepEqual(facade.getActiveTools(), ["read", "mcp"]);
  facade.setActiveTools(["read", "mcp"]);
  assert.deepEqual(pi.active, ["read", "caco_mcp"]);
  assert.deepEqual(facade.getAllTools().map((tool) => tool.name), ["mcp", "read"]);

  let config;
  const register = createScopedAdapterRegistrar({
    createMcpAdapter(options) {
      config = options.config;
      return (scoped) => scoped.registerTool({ name: "mcp", label: "MCP" });
    },
  });
  const handle = register({ pi, name: "cacophony-runtime", definition: { command: "caco", args: ["mcp", "stdio"] } });
  assert.deepEqual(config, { mcpServers: { "cacophony-runtime": { command: "caco", args: ["mcp", "stdio"] } } });
  assert.equal(typeof handle.dispose, "function");
  assert.equal(handle.compatAdapter, true);
});

test("registration plan scopes managed identity to one keep-alive stdio child", () => {
  const env = { CACO_BIN: "/opt/caco", CACO_AGENT_ID: "managed-1", CACO_PROJECT: "agent-utils" };
  assert.deepEqual(buildCacophonyMcpRegistration({ agentId: "managed-1", project: "agent-utils" }, env), {
    name: "cacophony-runtime",
    identityKey: "agent-utils:managed-1",
    definition: {
      command: "/opt/caco",
      args: ["mcp", "stdio"],
      env: { CACO_AGENT_ID: "managed-1", CACO_PROJECT: "agent-utils" },
      literalEnv: true,
      lifecycle: "keep-alive",
      directTools: false,
    },
  });
  assert.equal(buildCacophonyMcpRegistration({ agentId: "a", project: "p" }, { DISABLE_PI_CACO: "1" }), null);
  assert.equal(buildCacophonyMcpRegistration({ agentId: "", project: "p" }, {}), null);
});

test("managed identity registers once, exposes diagnostics, and disposes on shutdown", async () => {
  clearCacophonyRuntimeIdentity();
  const h = harness();
  const registrations = [];
  let disposals = 0;
  createCacophonyMcpExtension({
    env: { CACO_AGENT_ID: "managed-1", CACO_PROJECT: "agent-utils", CACO_BIN: "caco-test" },
    registerServer(options) { registrations.push(options); return { async dispose() { disposals += 1; } }; },
  })(h.pi);
  await h.fire("session_start");
  await settle();
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].definition.command, "caco-test");
  assert.deepEqual(registrations[0].definition.args, ["mcp", "stdio"]);
  assert.deepEqual(registrations[0].definition.env, { CACO_AGENT_ID: "managed-1", CACO_PROJECT: "agent-utils" });
  assert.equal(registrations[0].definition.lifecycle, "keep-alive", "adapter auto-connects and publishes proxy metadata without restart");
  await h.fire("session_start");
  await settle();
  assert.equal(registrations.length, 1, "repeat startup is deduplicated");
  await h.commands.get("caco-mcp").handler("status", h.ctx);
  assert.match(h.notifications.at(-1).message, /registered as agent-utils:managed-1/);
  await h.fire("session_shutdown");
  await h.fire("session_shutdown");
  assert.equal(disposals, 1, "shutdown disposes the exact registration once");
});

test("visiting registration hands identity to MCP without mutating parent environment", async () => {
  clearCacophonyRuntimeIdentity();
  const env = { CACO_PROJECT: "agent-utils", TMUX: "/tmp/tmux.sock", PI_CACO_AUTO_REGISTER: "1", CACO_BIN: "caco-test" };
  const before = { ...env };
  const h = harness();
  const registrations = [];
  createCacophonyRuntimeExtension({
    env,
    settings: {},
    execFileImpl(_command, _args, _options, callback) {
      queueMicrotask(() => callback(null, JSON.stringify({ data: { id: "visitor-1", project: "agent-utils" } }), ""));
    },
  })(h.pi);
  createCacophonyMcpExtension({
    env,
    registerServer(options) { registrations.push(options); return { async dispose() {} }; },
  })(h.pi);
  await h.fire("session_start");
  await settle();
  await settle();
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0].definition.env, { CACO_AGENT_ID: "visitor-1", CACO_PROJECT: "agent-utils" });
  assert.deepEqual(env, before, "visiting identity is passed only to the child definition");
  await h.fire("session_shutdown");
  clearCacophonyRuntimeIdentity();
});

test("disabled, identity-less, and no-tmux skipped sessions never register MCP", async () => {
  for (const scenario of [
    { env: { DISABLE_PI_CACO: "1", CACO_AGENT_ID: "a", CACO_PROJECT: "p" } },
    { env: {} },
    { env: { CACO_PROJECT: "p", PI_CACO_AUTO_REGISTER: "1" }, withRuntime: true },
  ]) {
    clearCacophonyRuntimeIdentity();
    const h = harness();
    let registrations = 0;
    if (scenario.withRuntime) createCacophonyRuntimeExtension({ env: scenario.env, settings: {} })(h.pi);
    createCacophonyMcpExtension({ env: scenario.env, registerServer() { registrations += 1; return { async dispose() {} }; } })(h.pi);
    await h.fire("session_start");
    await settle();
    assert.equal(registrations, 0);
    await h.fire("session_shutdown");
  }
});

test("identity changes replace one owned registration and duplicate events are deduplicated", async () => {
  clearCacophonyRuntimeIdentity();
  const h = harness();
  const registrations = [];
  const disposals = [];
  createCacophonyMcpExtension({
    env: {},
    registerServer(options) {
      registrations.push(options);
      return { async dispose() { disposals.push(options.identityKey); } };
    },
  })(h.pi);
  await h.fire("session_start");
  setCacophonyRuntimeIdentity({ agentId: "visitor-a", project: "p", visiting: true }, h.pi);
  setCacophonyRuntimeIdentity({ agentId: "visitor-a", project: "p", visiting: true }, h.pi);
  await settle();
  await settle();
  assert.equal(registrations.length, 1);
  setCacophonyRuntimeIdentity({ agentId: "visitor-b", project: "p", visiting: true }, h.pi);
  await settle();
  assert.equal(registrations.length, 2);
  assert.equal(disposals.length, 1);
  await h.fire("session_shutdown");
  assert.equal(disposals.length, 2);
  clearCacophonyRuntimeIdentity(h.pi);
});

test("adapter registration failure warns once and leaves Pi commands functional", async () => {
  clearCacophonyRuntimeIdentity();
  const h = harness();
  createCacophonyMcpExtension({
    env: { CACO_AGENT_ID: "managed-1", CACO_PROJECT: "p" },
    registerServer() { throw new Error("adapter unavailable"); },
  })(h.pi);
  await h.fire("session_start");
  await settle();
  await h.fire("session_start");
  await settle();
  assert.equal(h.notifications.filter((item) => /MCP unavailable/.test(item.message)).length, 1);
  assert.ok(h.commands.has("caco-mcp"));
  await h.fire("session_shutdown");
});
