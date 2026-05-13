import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";

import piSelfUpdateExtension from "../extensions/pi-self-update.js";

function makeHarness({ execResult = { code: 0, stdout: "updated", stderr: "" } } = {}) {
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const userMessages = [];
  const activeToolsCalls = [];
  let reloadCount = 0;
  let execCount = 0;
  let lastExec = null;
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    async exec(command, args, options) {
      execCount += 1;
      lastExec = { command, args, options };
      return { command, args, options, ...execResult };
    },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
    getAllTools() { return [{ name: "read" }, { name: "pi_self_update" }, { name: "realtime_agent_control" }]; },
    setActiveTools(names) { activeToolsCalls.push(names); },
  };
  const ctx = {
    ui: { notify(message, level = "info") { notifications.push({ message, level }); } },
    async reload() { reloadCount += 1; },
  };
  return { pi, ctx, commands, tools, notifications, userMessages, activeToolsCalls, get execCount() { return execCount; }, get lastExec() { return lastExec; }, get reloadCount() { return reloadCount; } };
}

test("/update runs pi update from home and reloads on success", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.equal(h.execCount, 1);
  assert.equal(h.notifications.at(0).message, "Running pi update from home directory...");
  assert.deepEqual(h.userMessages, [{ message: "/reload-tools --activate", options: { deliverAs: "followUp" } }]);
  assert.match(h.notifications.at(-2).message, /pi update exited with code 0/);
  assert.match(h.notifications.at(-1).message, /reloading Pi runtime/);
});

test("pi update exec uses home directory cwd", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("--no-reload", h.ctx);

  assert.equal(h.notifications.at(0).message, "Running pi update from home directory...");
  assert.equal(h.lastExec.options.cwd, homedir());
});

test("/update --no-reload skips reload", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("--no-reload", h.ctx);

  assert.equal(h.reloadCount, 0);
  assert.match(h.notifications.at(-1).message, /reload: skipped/);
});

test("/update reloads even after failed update attempts", async () => {
  const h = makeHarness({ execResult: { code: 1, stdout: "", stderr: "failed" } });
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.match(h.notifications.at(-2).message, /failed/);
  assert.match(h.notifications.at(-1).message, /reloading Pi runtime/);
});

test("/update treats Nix read-only self-update failure as reload-worthy", async () => {
  const h = makeHarness({ execResult: { code: 1, stdout: "Updated packages", stderr: "error: pi cannot self-update this installation. install path is not writable" } });
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.equal(h.notifications.at(-2).level, "info");
  assert.match(h.notifications.at(-2).message, /reload: requested after package update/);
});

test("pi_self_update tool runs update and queues reload-tools follow-up", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_self_update").execute("tool-1", {}, null, null, h.ctx);

  assert.deepEqual(h.userMessages, [{ message: "/reload-tools", options: { deliverAs: "followUp" } }]);
  assert.equal(result.details.queued, true);
});

test("pi_self_update dryRun reports without queueing", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_self_update").execute("tool-1", { dryRun: true }, null, null, h.ctx);

  assert.deepEqual(h.userMessages, []);
  assert.equal(h.execCount, 0);
  assert.match(result.content[0].text, /Would run pi update/);
});

test("/reload-tools reloads first and queues post-reload activation", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("reload-tools").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.deepEqual(h.userMessages, [{ message: "/reload-tools --activate", options: { deliverAs: "followUp" } }]);
  assert.deepEqual(h.activeToolsCalls, []);
});

test("/reload-tools --activate enables every registered tool", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("reload-tools").handler("--activate", h.ctx);

  assert.equal(h.reloadCount, 0);
  assert.deepEqual(h.activeToolsCalls, [["read", "pi_self_update", "realtime_agent_control"]]);
  assert.match(h.notifications.at(-1).message, /Activated 3 registered tools/);
});

test("pi_reload_tools tool queues reload-tools command", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_reload_tools").execute("tool-1", {}, null, null, h.ctx);

  assert.deepEqual(h.userMessages, [{ message: "/reload-tools", options: { deliverAs: "followUp" } }]);
  assert.equal(result.details.queued, true);
});
