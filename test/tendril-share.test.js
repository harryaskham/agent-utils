import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import tendrilShareExtension, {
  __tendrilShareTest,
  setTendrilShareCompleteForTest,
} from "../extensions/tendril-share.js";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lDL+WQAAAABJRU5ErkJggg==",
  "base64",
);

function makeHarness({ idle = true } = {}) {
  const visionModel = { provider: "github-copilot", id: "claude-opus-4.7", input: ["text", "image"] };
  const fallbackVisionModel = { provider: "litellm-anthropic", id: "claude-opus-4-7", input: ["text", "image"] };
  const commands = new Map();
  const tools = new Map();
  const notifications = [];
  const execCalls = [];
  const userMessages = [];
  const customMessages = [];
  const ctx = {
    cwd: process.cwd(),
    signal: undefined,
    isIdle: () => idle,
    ui: { notify: (message, level = "info") => notifications.push({ message, level }) },
    modelRegistry: {
      find(provider, id) {
        if (provider === visionModel.provider && id === visionModel.id) return visionModel;
        if (provider === fallbackVisionModel.provider && id === fallbackVisionModel.id) return fallbackVisionModel;
        return undefined;
      },
      async getApiKeyAndHeaders(model) { return { ok: true, apiKey: `key-for-${model.provider}-${model.id}`, headers: { "x-test": "1" } }; },
    },
  };
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(tool) { tools.set(tool.name, tool); },
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
    sendMessage(message) { customMessages.push(message); },
    on() {},
  };
  return { pi, commands, tools, notifications, execCalls, userMessages, customMessages, ctx };
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

test("tendril tool registry exposes command-tree operations", async () => {
  const { pi, tools } = makeHarness();
  tendrilShareExtension(pi);

  for (const name of ["tendril_settings", "tendril_list", "tendril_capture", "tendril_describe", "tendril_stream", "tendril_bridge_doctor"]) {
    assert.ok(tools.has(name), `${name} should be registered`);
  }

  const settings = await tools.get("tendril_settings").execute("call-1", {}, new AbortController().signal);
  assert.match(settings.content[0].text, /tendril command=tendril/);
});

test("tendril_list and tendril_capture tools return targets and PNG content", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools, execCalls } = makeHarness();
    tendrilShareExtension(pi);

    const list = await tools.get("tendril_list").execute("call-1", {}, new AbortController().signal);
    assert.match(list.content[0].text, /window 4/);

    const capture = await tools.get("tendril_capture").execute("call-2", { kind: "window", target: "browser", prompt: "inspect" }, new AbortController().signal);
    assert.match(capture.content[0].text, /Captured Tendril window 4/);
    assert.match(capture.content[0].text, /Tendril targets:/);
    assert.equal(capture.content[1].type, "image");
    assert.equal(capture.content[1].mimeType, "image/png");
    assert.equal(capture.content[1].data, ONE_PIXEL_PNG.toString("base64"));
    const pathOnly = await tools.get("tendril_capture").execute("call-3", { kind: "window", target: "4", pathOnly: true, includeList: false }, new AbortController().signal);
    assert.equal(pathOnly.content.length, 1);
    assert.match(pathOnly.content[0].text, /Image content omitted because pathOnly=true/);
    assert.doesNotMatch(pathOnly.content[0].text, /Tendril targets:/);
    const captureCall = execCalls.find((call) => call.args[0] === "capture");
    assert.ok(captureCall.args.includes("--window"));
    assert.ok(captureCall.args.includes("4"));
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tendril_describe tool returns objective prompt plus image content", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools } = makeHarness();
    tendrilShareExtension(pi);

    const result = await tools.get("tendril_describe").execute("call-1", { kind: "display", target: "1", prompt: "errors" }, new AbortController().signal);
    assert.match(result.content[0].text, /Describe the screenshot objectively/);
    assert.match(result.content[0].text, /User focus: errors/);
    assert.match(result.content[0].text, /Tendril targets:/);
    assert.equal(result.content[1].type, "image");
    assert.equal(result.content[1].data, ONE_PIXEL_PNG.toString("base64"));
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tendril_stream tool starts, reports, and stops queued frame streaming", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools, userMessages } = makeHarness();
    tendrilShareExtension(pi);

    const started = await tools.get("tendril_stream").execute("call-1", { action: "start", kind: "window", target: "browser", intervalSeconds: 10, prompt: "watch" }, new AbortController().signal);
    assert.match(started.content[0].text, /Tendril stream active/);
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0].content[0].text, /^watch\n/);
    assert.match(userMessages[0].content[0].text, /Saved screenshot:/);
    assert.match(userMessages[0].content[0].text, /Tendril targets:/);
    assert.equal(userMessages[0].content[1].type, "image");
    assert.deepEqual(userMessages[0].options, { deliverAs: "followUp" });

    const status = await tools.get("tendril_stream").execute("call-2", { action: "status" }, new AbortController().signal);
    assert.match(status.content[0].text, /frames sent 1/);
    const stopped = await tools.get("tendril_stream").execute("call-3", { action: "stop" }, new AbortController().signal);
    assert.match(stopped.content[0].text, /Stopped Tendril stream/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tendril bridge doctor reports bridge settings and probes targets", async () => {
  const { pi, execCalls } = makeHarness();
  const tools = new Map();
  pi.registerTool = (tool) => tools.set(tool.name, tool);
  tendrilShareExtension(pi);

  const result = await tools.get("tendril_bridge_doctor").execute("call-1", {}, new AbortController().signal);
  assert.match(result.content[0].text, /wslTunnel=false/);
  assert.match(result.content[0].text, /probe=ok targets=2/);
  assert.match(result.content[0].text, /hint=none/);
  assert.deepEqual(execCalls[0], { command: "tendril", args: ["list", "--json"] });
});

test("tendril bridge doctor flags stale remote WSL tunnel support", async () => {
  const previous = {
    remote: process.env.AGENT_UTILS_TENDRIL_REMOTE,
    wsl: process.env.AGENT_UTILS_TENDRIL_WSL_TUNNEL,
  };
  process.env.AGENT_UTILS_TENDRIL_REMOTE = "ms-dev";
  process.env.AGENT_UTILS_TENDRIL_WSL_TUNNEL = "1";
  try {
    const tools = new Map();
    const execCalls = [];
    const pi = {
      registerCommand() {},
      registerTool: (tool) => tools.set(tool.name, tool),
      on() {},
      async exec(command, args) {
        execCalls.push({ command, args });
        return { code: 2, stdout: "", stderr: "error: unexpected argument '--wsl-tunnel' found" };
      },
    };
    tendrilShareExtension(pi);

    const result = await tools.get("tendril_bridge_doctor").execute("call-1", {}, new AbortController().signal);

    assert.deepEqual(execCalls[0], { command: "tendril", args: ["--remote", "ms-dev", "--wsl-tunnel", "list", "--json"] });
    assert.match(result.content[0].text, /remote=ms-dev wslTunnel=true/);
    assert.match(result.content[0].text, /probe=error/);
    assert.match(result.content[0].text, /stale.*--wsl-tunnel|--wsl-tunnel.*stale/i);
    assert.match(result.data.hint, /remote Tendril binary appears stale/);
  } finally {
    if (previous.remote === undefined) delete process.env.AGENT_UTILS_TENDRIL_REMOTE;
    else process.env.AGENT_UTILS_TENDRIL_REMOTE = previous.remote;
    if (previous.wsl === undefined) delete process.env.AGENT_UTILS_TENDRIL_WSL_TUNNEL;
    else process.env.AGENT_UTILS_TENDRIL_WSL_TUNNEL = previous.wsl;
  }
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
    assert.match(userMessages[0].content[0].text, /^what is visible\?/);
    assert.match(userMessages[0].content[0].text, /Saved screenshot:/);
    assert.match(userMessages[0].content[0].text, /Tendril targets:/);
    assert.match(userMessages[0].content[0].text, /window 4 \[capture\] Browser/);
    assert.equal(userMessages[0].content[1].type, "image");
    assert.equal(userMessages[0].content[1].mimeType, "image/png");
    assert.equal(userMessages[0].content[1].data, ONE_PIXEL_PNG.toString("base64"));
    assert.equal(userMessages[0].options, undefined);
    assert.match(notifications.at(-1).message, /Sent Tendril window 4 screenshot/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/tendril describe captures, describes, and sends text context", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  const completeCalls = [];
  setTendrilShareCompleteForTest(async (model, request, options) => {
    completeCalls.push({ model, request, options });
    return {
      content: [{ type: "text", text: "A browser window with a dashboard is visible." }],
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 9 },
    };
  });
  try {
    const { pi, commands, notifications, userMessages, ctx } = makeHarness();
    tendrilShareExtension(pi);

    await commands.get("tendril").handler("describe window 4 focus on errors", ctx);

    assert.equal(completeCalls.length, 1);
    assert.equal(completeCalls[0].model.provider, "github-copilot");
    assert.equal(completeCalls[0].model.id, "claude-opus-4.7");
    assert.equal(completeCalls[0].options.apiKey, "key-for-github-copilot-claude-opus-4.7");
    assert.match(completeCalls[0].request.messages[0].content[0].text, /focus on errors/);
    assert.equal(completeCalls[0].request.messages[0].content[1].type, "image");
    assert.equal(completeCalls[0].request.messages[0].content[1].data, ONE_PIXEL_PNG.toString("base64"));
    assert.equal(userMessages.length, 1);
    assert.equal(typeof userMessages[0].content, "string");
    assert.match(userMessages[0].content, /screenshot description from github-copilot\/claude-opus-4\.7/);
    assert.match(userMessages[0].content, /A browser window with a dashboard is visible/);
    assert.match(userMessages[0].content, /Tendril targets:/);
    assert.match(notifications.at(-1).message, /Sent Tendril window 4 description/);
  } finally {
    setTendrilShareCompleteForTest();
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/tendril-describe aliases the describe command and queues while busy", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  setTendrilShareCompleteForTest(async () => ({
    content: [{ type: "text", text: "Display overview." }],
    stopReason: "end_turn",
    usage: {},
  }));
  try {
    const { pi, commands, userMessages, ctx } = makeHarness({ idle: false });
    tendrilShareExtension(pi);

    await commands.get("tendril-describe").handler("display 1", ctx);

    assert.equal(userMessages.length, 1);
    assert.deepEqual(userMessages[0].options, { deliverAs: "followUp" });
    assert.match(userMessages[0].content, /Display overview/);
  } finally {
    setTendrilShareCompleteForTest();
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/tendril resolves unique target name matches and records capture history", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, commands, execCalls, userMessages, customMessages, ctx } = makeHarness();
    tendrilShareExtension(pi);

    await commands.get("tendril").handler("window browser inspect tab", ctx);

    const captureCall = execCalls.find((call) => call.args[0] === "capture");
    assert.ok(captureCall.args.includes("--window"));
    assert.ok(captureCall.args.includes("4"));
    assert.match(userMessages[0].content[0].text, /^inspect tab\n/);
    assert.match(userMessages[0].content[0].text, /Tendril targets:/);
    assert.equal(customMessages.length, 1);
    assert.equal(customMessages[0].customType, "tendril-share");
    assert.match(customMessages[0].content, /Browser/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/tendril stream sends low-resolution frames and can be stopped", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, commands, notifications, execCalls, userMessages, ctx } = makeHarness();
    tendrilShareExtension(pi);

    await commands.get("tendril").handler("stream window browser 10 watch the page", ctx);

    const captureCall = execCalls.find((call) => call.args[0] === "capture");
    assert.ok(captureCall.args.includes("--max-width"));
    assert.ok(captureCall.args.includes("640"));
    assert.ok(captureCall.args.includes("--max-height"));
    assert.ok(captureCall.args.includes("360"));
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0].content[0].text, /^watch the page\n/);
    assert.match(userMessages[0].content[0].text, /Tendril targets:/);
    assert.equal(userMessages[0].content[1].type, "image");
    assert.match(notifications.at(-1).message, /every 10s/);

    await commands.get("tendril").handler("stream status", ctx);
    assert.match(notifications.at(-1).message, /Tendril stream active/);
    await commands.get("tendril").handler("stream stop", ctx);
    assert.match(notifications.at(-1).message, /Stopped Tendril stream/);
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
    assert.match(userMessages[0].content[0].text, /Tendril targets:/);
    assert.equal(userMessages[0].content[1].type, "image");
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
    target: "2",
    id: "2",
    intervalSeconds: undefined,
    prompt: "inspect",
    pathOnly: false,
    includeList: true,
  });
  assert.deepEqual(__tendrilShareTest.parseCaptureArgs("describe window 4 errors --no-list"), {
    action: "describe",
    kind: "window",
    target: "4",
    id: "4",
    intervalSeconds: undefined,
    prompt: "errors",
    pathOnly: false,
    includeList: false,
  });
  assert.deepEqual(__tendrilShareTest.parseCaptureArgs("display 1", "describe"), {
    action: "describe",
    kind: "display",
    target: "1",
    id: "1",
    intervalSeconds: undefined,
    prompt: "",
    pathOnly: false,
    includeList: true,
  });
  assert.deepEqual(__tendrilShareTest.parseCaptureArgs("stream window browser 45 --path-only watch"), {
    action: "stream",
    kind: "window",
    target: "browser",
    id: "browser",
    intervalSeconds: 45,
    prompt: "watch",
    pathOnly: true,
    includeList: true,
  });
  assert.equal(__tendrilShareTest.parseJsonEnvelope("log\n{\"status\":\"ok\"}\n").status, "ok");
  assert.match(__tendrilShareTest.listTargetsText({ data: { targets: [] } }), /none/);
  assert.deepEqual(__tendrilShareTest.buildTendrilCommand(["list", "--json"], {
    AGENT_UTILS_TENDRIL_REMOTE: "ms-dev",
    AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1",
  }), {
    command: "tendril",
    args: ["--remote", "ms-dev", "--wsl-tunnel", "list", "--json"],
    remote: "ms-dev",
    wslTunnel: true,
  });
});
