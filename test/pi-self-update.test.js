import test from "node:test";
import assert from "node:assert/strict";

import piSelfUpdateExtension from "../extensions/pi-self-update.js";

function makeHarness({ execResult = { code: 0, stdout: "updated", stderr: "" } } = {}) {
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const userMessages = [];
  let reloadCount = 0;
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    async exec(command, args, options) {
      return { command, args, options, ...execResult };
    },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
  };
  const ctx = {
    ui: { notify(message, level = "info") { notifications.push({ message, level }); } },
    async reload() { reloadCount += 1; },
  };
  return { pi, ctx, commands, tools, notifications, userMessages, get reloadCount() { return reloadCount; } };
}

test("/update runs pi update and reloads on success", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 1);
  assert.match(h.notifications.at(-2).message, /pi update exited with code 0/);
  assert.match(h.notifications.at(-1).message, /reloading Pi runtime/);
});

test("/update --no-reload skips reload", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("--no-reload", h.ctx);

  assert.equal(h.reloadCount, 0);
  assert.match(h.notifications.at(-1).message, /reload: skipped/);
});

test("/update does not reload after failed update", async () => {
  const h = makeHarness({ execResult: { code: 1, stdout: "", stderr: "failed" } });
  piSelfUpdateExtension(h.pi);

  await h.commands.get("update").handler("", h.ctx);

  assert.equal(h.reloadCount, 0);
  assert.equal(h.notifications.at(-1).level, "error");
  assert.match(h.notifications.at(-1).message, /failed/);
});

test("pi_self_update tool queues update command as follow-up", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_self_update").execute("tool-1", { skipReload: true }, null, null, h.ctx);

  assert.deepEqual(h.userMessages, [{ message: "/update --no-reload", options: { deliverAs: "followUp" } }]);
  assert.equal(result.details.queued, true);
});

test("pi_self_update dryRun reports without queueing", async () => {
  const h = makeHarness();
  piSelfUpdateExtension(h.pi);

  const result = await h.tools.get("pi_self_update").execute("tool-1", { dryRun: true }, null, null, h.ctx);

  assert.deepEqual(h.userMessages, []);
  assert.match(result.content[0].text, /Would queue \/update/);
});
