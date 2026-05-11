import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import tendrilShareExtension, { __tendrilShareTest } from "../extensions/tendril-share.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDL+WQAAAABJRU5ErkJggg==",
  "base64",
);

function makeHarness({ idle = true } = {}) {
  const commands = new Map();
  const notifications = [];
  const execCalls = [];
  const userMessages = [];
  const ctx = {
    cwd: process.cwd(),
    signal: undefined,
    isIdle: () => idle,
    ui: { notify: (message, level = "info") => notifications.push({ message, level }) },
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    async exec(command, args) {
      execCalls.push({ command, args });
      if (args[0] === "list") {
        return {
          code: 0,
          stdout: JSON.stringify({
            status: "ok",
            data: {
              targets: [
                { kind: "display", id: "1", name: "Built-in", capabilities: { capture: true } },
                { kind: "window", id: "4", title: "Browser", app_name: "Safari", capabilities: { capture: true } },
              ],
            },
          }),
          stderr: "",
        };
      }
      if (args[0] === "capture") {
        const outputPath = args[args.indexOf("--output") + 1];
        await writeFile(outputPath, ONE_PIXEL_PNG);
        return { code: 0, stdout: JSON.stringify({ status: "ok", data: { output: outputPath } }), stderr: "" };
      }
      return { code: 1, stdout: JSON.stringify({ status: "error", error: { message: "bad command" } }), stderr: "" };
    },
    sendUserMessage(content, options) { userMessages.push({ content, options }); },
  };
  return { pi, commands, notifications, execCalls, userMessages, ctx };
}

test("/tendril list formats Tendril targets", async () => {
  const { pi, commands, notifications, execCalls, ctx } = makeHarness();
  tendrilShareExtension(pi);

  await commands.get("tendril").handler("list", ctx);

  assert.deepEqual(execCalls[0], { command: "tendril", args: ["list", "--json"] });
  assert.match(notifications.at(-1).message, /Tendril targets:/);
  assert.match(notifications.at(-1).message, /display 1/);
  assert.match(notifications.at(-1).message, /window 4/);
});

test("/tendril window captures and sends image content to the model", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, commands, notifications, execCalls, userMessages, ctx } = makeHarness();
    tendrilShareExtension(pi);

    await commands.get("tendril").handler("window 4 what is visible?", ctx);

    const captureCall = execCalls.find((call) => call.args[0] === "capture");
    assert.ok(captureCall);
    assert.ok(captureCall.args.includes("--window"));
    assert.ok(captureCall.args.includes("4"));
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0].content[0].text, "what is visible?");
    assert.equal(userMessages[0].content[1].type, "image");
    assert.equal(userMessages[0].content[1].source.mediaType, "image/png");
    assert.equal(userMessages[0].content[1].source.data, ONE_PIXEL_PNG.toString("base64"));
    assert.equal(userMessages[0].options, undefined);
    assert.match(notifications.at(-1).message, /Sent Tendril window 4 screenshot/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/tendril display queues follow-up image message when agent is busy", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, commands, userMessages, ctx } = makeHarness({ idle: false });
    tendrilShareExtension(pi);

    await commands.get("tendril").handler("display 1", ctx);

    assert.equal(userMessages.length, 1);
    assert.deepEqual(userMessages[0].options, { deliverAs: "followUp" });
    assert.match(userMessages[0].content[0].text, /Tendril display screenshot/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tendril share helpers parse commands and JSON envelopes", () => {
  assert.deepEqual(__tendrilShareTest.parseCaptureArgs("screen 2 inspect"), {
    action: "capture",
    kind: "display",
    id: "2",
    prompt: "inspect",
  });
  assert.equal(__tendrilShareTest.parseJsonEnvelope("log\n{\"status\":\"ok\"}\n").status, "ok");
  assert.match(__tendrilShareTest.listTargetsText({ data: { targets: [] } }), /none/);
});
