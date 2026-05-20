import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

process.env.PI_AUTO_UPDATE_ON_STARTUP = process.env.PI_AUTO_UPDATE_ON_STARTUP ?? "0";

import piSelfUpdateExtension, { buildPiRestartPlan, executePiRestartPlan } from "../extensions/pi-self-update.js";

async function loadExtension(pi) {
  await piSelfUpdateExtension(pi);
}

function makeHarness({ execResult = { code: 0, stdout: "updated", stderr: "" } } = {}) {
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const userMessages = [];
  const activeToolsCalls = [];
  const customEntries = [];
  let refreshToolsCount = 0;
  let reloadCount = 0;
  let execCount = 0;
  let idleWaitCount = 0;
  let lastExec = null;
  const handlers = new Map();
  const pi = {
    on(event, handler) { const arr = handlers.get(event) || []; arr.push(handler); handlers.set(event, arr); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    async exec(command, args, options) {
      execCount += 1;
      lastExec = { command, args, options };
      return { command, args, options, ...execResult };
    },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
    refreshTools() { refreshToolsCount += 1; },
    getAllTools() { return [{ name: "read" }, { name: "pi_self_update" }, { name: "realtime_agent_control" }]; },
    getActiveTools() { return activeToolsCalls.at(-1) || []; },
    setActiveTools(names) { activeToolsCalls.push(names); },
    appendEntry(type, data) { customEntries.push({ type, data }); },
  };
  const ctx = {
    cwd: "/work/project",
    ui: { notify(message, level = "info") { notifications.push({ message, level }); } },
    sessionManager: {
      getSessionFile() { return "/tmp/pi-session/session.jsonl"; },
      getSessionDir() { return "/tmp/pi-session"; },
    },
    async waitForIdle() { idleWaitCount += 1; },
    async reload() { reloadCount += 1; },
  };
  return { pi, ctx, commands, tools, handlers, notifications, userMessages, activeToolsCalls, customEntries, get execCount() { return execCount; }, get lastExec() { return lastExec; }, get reloadCount() { return reloadCount; }, get idleWaitCount() { return idleWaitCount; }, get refreshToolsCount() { return refreshToolsCount; } };
}

test("/update runs pi update --extensions from home and reloads on success", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.equal(h.execCount, 1);
  assert.equal(h.lastExec.command, "pi");
  assert.deepEqual(h.lastExec.args, ["update", "--extensions"]);
  assert.equal(h.notifications.at(0).message, "Running pi update --extensions from home directory...");
  assert.deepEqual(h.userMessages, [{ message: "/reload-tools --activate", options: { deliverAs: "followUp", streamingBehavior: "followUp" } }]);
  assert.match(h.notifications.at(-2).message, /pi update --extensions exited with code 0/);
  assert.match(h.notifications.at(-1).message, /reloading Pi runtime/);
});

test("pi update --extensions exec uses home directory cwd", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("--no-reload", h.ctx);

  assert.equal(h.notifications.at(0).message, "Running pi update --extensions from home directory...");
  assert.equal(h.lastExec.options.cwd, homedir());
});

test("/update --no-reload skips reload", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("--no-reload", h.ctx);

  assert.equal(h.reloadCount, 0);
  assert.match(h.notifications.at(-1).message, /reload: skipped/);
});

test("/update reloads even after failed update attempts", async () => {
  const h = makeHarness({ execResult: { code: 1, stdout: "", stderr: "failed" } });
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.match(h.notifications.at(-2).message, /failed/);
  assert.match(h.notifications.at(-1).message, /reloading Pi runtime/);
});

test("/update treats Nix read-only self-update failure as reload-worthy", async () => {
  const h = makeHarness({ execResult: { code: 1, stdout: "Updated packages", stderr: "error: pi cannot self-update this installation. install path is not writable" } });
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.equal(h.notifications.at(-2).level, "info");
  assert.match(h.notifications.at(-2).message, /reload: requested after package update/);
});

test("pi_self_update tool runs update and queues reload-tools follow-up", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_self_update").execute("tool-1", {}, null, null, h.ctx);

  assert.deepEqual(h.userMessages, [{ message: "/reload-tools", options: { deliverAs: "followUp", streamingBehavior: "followUp" } }]);
  assert.equal(result.details.queued, true);
});

test("pi_self_update dryRun reports without queueing", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_self_update").execute("tool-1", { dryRun: true }, null, null, h.ctx);

  assert.deepEqual(h.userMessages, []);
  assert.equal(h.execCount, 0);
  assert.match(result.content[0].text, /Would run pi update --extensions/);
  assert.deepEqual(result.details.updateArgs, ["update", "--extensions"]);
});

test("/reload-tools reloads first and queues post-reload activation", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("reload-tools").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.deepEqual(h.userMessages, [{ message: "/reload-tools --activate", options: { deliverAs: "followUp", streamingBehavior: "followUp" } }]);
  assert.deepEqual(h.activeToolsCalls, []);
});

test("/reload-tools --activate enables every registered tool", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("reload-tools").handler("--activate", h.ctx);

  assert.equal(h.reloadCount, 0);
  assert.deepEqual(h.activeToolsCalls, [["read", "pi_self_update", "realtime_agent_control"]]);
  assert.equal(h.refreshToolsCount, 1);
  assert.match(h.notifications.at(-1).message, /Activated 3 registered tools/);
  assert.match(h.notifications.at(-1).message, /refreshing the tool registry/);
});

test("pi_reload_tools tool activates registered tools inline without queueing a follow-up", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_reload_tools").execute("tool-1", {}, null, null, h.ctx);

  assert.deepEqual(h.userMessages, []);
  assert.equal(result.details.activated, true);
  assert.equal(result.details.queued, false);
  assert.match(result.content[0].text, /Activated/);
});

test("pi_reload_tools dryRun reports without activating or queueing", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_reload_tools").execute("tool-1", { dryRun: true }, null, null, h.ctx);

  assert.deepEqual(h.userMessages, []);
  assert.equal(result.details.dryRun, true);
  assert.equal(result.details.queued, false);
  assert.match(result.content[0].text, /Would activate/);

  await h.commands.get("reload-tools").handler("", h.ctx);
  assert.equal(h.reloadCount, 1);
  assert.deepEqual(h.userMessages.map((m) => m.message), ["/reload-tools --activate"]);
});

test("buildPiRestartPlan preserves runtime flags, switches to current session, and drops startup prompts", () => {
  const plan = buildPiRestartPlan({
    argv: ["/usr/bin/node", "/old/pi/dist/cli.js", "--model", "openai/gpt-5", "--extension", "./ext.js", "--continue", "@startup.md", "non-idempotent prompt", "--unknown-bool"],
    env: { PATH: "/definitely/missing" },
    sessionFile: "/tmp/pi-session/session.jsonl",
    sessionDir: "/tmp/pi-session",
    cwd: "/work/project",
  });

  assert.equal(plan.executable, "/old/pi/dist/cli.js");
  assert.deepEqual(plan.restartArgs, ["--model", "openai/gpt-5", "--extension", "./ext.js", "--unknown-bool", "--session-dir", "/tmp/pi-session", "--session", "/tmp/pi-session/session.jsonl"]);
  assert.deepEqual(plan.droppedArgs, ["--continue", "@startup.md", "non-idempotent prompt"]);
  assert.equal(plan.env.PI_RESTARTED_WITHOUT_INITIAL_PROMPT, "1");
  assert.equal(plan.env.PI_RESTART_SESSION_FILE, "/tmp/pi-session/session.jsonl");
});

test("/restart --dry-run reports reexec plan without executing", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  await h.commands.get("restart").handler("--dry-run", h.ctx);

  assert.equal(h.idleWaitCount, 0);
  assert.match(h.notifications.at(-1).message, /restart argv:/);
  assert.match(h.notifications.at(-1).message, /--session/);
  assert.deepEqual(h.customEntries, []);
});

test("/restart dry-run redacts API key argv values", async () => {
  const originalArgv = process.argv;
  process.argv = ["/usr/bin/node", "/old/pi/dist/cli.js", "--api-key", "secret-token", "hello"];
  try {
    const h = makeHarness();
    await piSelfUpdateExtension(h.pi);

    await h.commands.get("restart").handler("--dry-run", h.ctx);

    assert.match(h.notifications.at(-1).message, /<redacted>/);
    assert.doesNotMatch(h.notifications.at(-1).message, /secret-token/);
  } finally {
    process.argv = originalArgv;
  }
});

test("pi_restart tool queues restart command", async () => {
  const h = makeHarness();
  await piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_restart").execute("tool-1", {}, null, null, h.ctx);

  assert.deepEqual(h.userMessages, [{ message: "/restart", options: { deliverAs: "followUp", streamingBehavior: "followUp" } }]);
  assert.equal(result.details.queued, true);
});

test("executePiRestartPlan prefers execve with full argv", () => {
  const calls = [];
  const plan = {
    executable: "/bin/pi",
    args: ["pi", "--session", "/tmp/session.jsonl"],
    env: { PI_RESTARTED_WITHOUT_INITIAL_PROMPT: "1" },
    cwd: "/work/project",
  };

  const result = executePiRestartPlan(plan, {
    execve(file, args, env) { calls.push({ file, args, env }); },
  });

  assert.equal(result.method, "execve");
  assert.deepEqual(calls, [{ file: "/bin/pi", args: ["pi", "--session", "/tmp/session.jsonl"], env: { PI_RESTARTED_WITHOUT_INITIAL_PROMPT: "1" } }]);
});

test("session_start triggers a silent background pi update --extensions", async () => {
  const previous = process.env.PI_AUTO_UPDATE_ON_STARTUP;
  process.env.PI_AUTO_UPDATE_ON_STARTUP = "1";
  try {
    const h = makeHarness({ execResult: { code: 0, stdout: "Already up to date", stderr: "" } });
    await piSelfUpdateExtension(h.pi);
    await h.handlers.get("session_start")[0]({ reason: "startup" }, h.ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.execCount, 1);
    assert.deepEqual(h.lastExec.args, ["update", "--extensions"]);
    assert.equal(h.reloadCount, 0);
    assert.equal(h.notifications.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_UPDATE_ON_STARTUP;
    else process.env.PI_AUTO_UPDATE_ON_STARTUP = previous;
  }
});

test("background auto-update notifies the user to /reload only if packages changed", async () => {
  const previous = process.env.PI_AUTO_UPDATE_ON_STARTUP;
  const prevReload = process.env.PI_AUTO_RELOAD_AFTER_UPDATE;
  process.env.PI_AUTO_UPDATE_ON_STARTUP = "1";
  process.env.PI_AUTO_RELOAD_AFTER_UPDATE = "0";
  try {
    const h = makeHarness({ execResult: { code: 0, stdout: "Updating abc1234..def5678\nFast-forward\n 3 files changed\nUpdated packages", stderr: "" } });
    await piSelfUpdateExtension(h.pi);
    await h.handlers.get("session_start")[0]({ reason: "startup" }, h.ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.execCount, 1);
    assert.equal(h.reloadCount, 0);
    assert.equal(h.notifications.length, 1);
    assert.match(h.notifications[0].message, /\/reload/);
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_UPDATE_ON_STARTUP;
    else process.env.PI_AUTO_UPDATE_ON_STARTUP = previous;
    if (prevReload === undefined) delete process.env.PI_AUTO_RELOAD_AFTER_UPDATE;
    else process.env.PI_AUTO_RELOAD_AFTER_UPDATE = prevReload;
  }
});

test("background auto-update auto-reloads runtime when autoReloadAfterUpdate is enabled", async () => {
  const previous = process.env.PI_AUTO_UPDATE_ON_STARTUP;
  const prevReload = process.env.PI_AUTO_RELOAD_AFTER_UPDATE;
  process.env.PI_AUTO_UPDATE_ON_STARTUP = "1";
  process.env.PI_AUTO_RELOAD_AFTER_UPDATE = "1";
  try {
    const h = makeHarness({ execResult: { code: 0, stdout: "Updating abc1234..def5678\nFast-forward\n 3 files changed\nUpdated packages", stderr: "" } });
    await piSelfUpdateExtension(h.pi);
    await h.handlers.get("session_start")[0]({ reason: "startup" }, h.ctx);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(h.execCount, 1);
    assert.equal(h.reloadCount, 1);
    assert.equal(h.activeToolsCalls.length, 1);
    assert.equal(h.notifications.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_AUTO_UPDATE_ON_STARTUP;
    else process.env.PI_AUTO_UPDATE_ON_STARTUP = previous;
    if (prevReload === undefined) delete process.env.PI_AUTO_RELOAD_AFTER_UPDATE;
    else process.env.PI_AUTO_RELOAD_AFTER_UPDATE = prevReload;
  }
});

test("PI_OFFLINE disables the background auto-update", async () => {
  const prev1 = process.env.PI_OFFLINE;
  const prev2 = process.env.PI_AUTO_UPDATE_ON_STARTUP;
  process.env.PI_OFFLINE = "1";
  delete process.env.PI_AUTO_UPDATE_ON_STARTUP;
  try {
    const h = makeHarness();
    await piSelfUpdateExtension(h.pi);
    await h.handlers.get("session_start")[0]({ reason: "startup" }, h.ctx);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.execCount, 0);
  } finally {
    if (prev1 === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = prev1;
    if (prev2 === undefined) delete process.env.PI_AUTO_UPDATE_ON_STARTUP;
    else process.env.PI_AUTO_UPDATE_ON_STARTUP = prev2;
  }
});
