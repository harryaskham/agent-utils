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
  const visionModel = { provider: "github-copilot", id: "claude-opus-4.8", input: ["text", "image"] };
  const oldVisionModel = { provider: "github-copilot", id: "claude-opus-4.7", input: ["text", "image"] };
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
        if (provider === oldVisionModel.provider && id === oldVisionModel.id) return oldVisionModel;
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
      if (args.includes("list")) {
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
      if (args.includes("capture")) {
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

test("tendril describe model configuration reads env, settings, and default", async () => {
  const oldModel = process.env.TENDRIL_SHARE_DESCRIBE_MODEL;
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-settings-test-"));
  try {
    delete process.env.TENDRIL_SHARE_DESCRIBE_MODEL;
    process.env.PI_CODING_AGENT_DIR = tmp;
    assert.deepEqual(__tendrilShareTest.describeModelConfig(), { spec: "github-copilot/claude-opus-4.8", source: "default" });
    await writeFile(path.join(tmp, "settings.json"), JSON.stringify({ tendril: { describeModel: "github-copilot/claude-opus-4.7" } }), "utf8");
    assert.deepEqual(__tendrilShareTest.describeModelConfig(), { spec: "github-copilot/claude-opus-4.7", source: "settings.json" });
    process.env.TENDRIL_SHARE_DESCRIBE_MODEL = "litellm-anthropic/claude-opus-4-7";
    assert.deepEqual(__tendrilShareTest.describeModelConfig(), { spec: "litellm-anthropic/claude-opus-4-7", source: "TENDRIL_SHARE_DESCRIBE_MODEL" });
  } finally {
    if (oldModel === undefined) delete process.env.TENDRIL_SHARE_DESCRIBE_MODEL;
    else process.env.TENDRIL_SHARE_DESCRIBE_MODEL = oldModel;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("tendril tool registry exposes command-tree operations", async () => {
  const { pi, commands, tools } = makeHarness();
  tendrilShareExtension(pi);

  assert.ok(commands.has("tendril-settings"), "tendril-settings shortcut should be registered");
  for (const name of ["tendril_settings", "tendril_list", "tendril_capture", "tendril_describe", "tendril_stream", "tendril_bridge_doctor"]) {
    assert.ok(tools.has(name), `${name} should be registered`);
  }

  const settings = await tools.get("tendril_settings").execute("call-1", {}, new AbortController().signal);
  assert.match(settings.content[0].text, /tendril command=tendril/);
  assert.match(settings.content[0].text, /describeModel=github-copilot\/claude-opus-4\.8 source=(default|settings\.json)/);
  assert.match(settings.content[0].text, /preview=on source=/);
});

test("/tendril settings reports fallback settings when overlay UI is unavailable", async () => {
  const { pi, commands, notifications, ctx } = makeHarness();
  tendrilShareExtension(pi);

  await commands.get("tendril").handler("settings", ctx);

  assert.match(notifications.at(-1).message, /Tendril settings: describeModel=/);
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

test("tendril_capture and tendril_describe return the same data envelope shape (bd-e8a473)", async () => {
  // The capture/describe tool-result `data` envelope is centralized in
  // buildTendrilToolData; both tools must expose the identical key set and
  // honor pathOnly/includeList so future fields stay single-site.
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools } = makeHarness();
    tendrilShareExtension(pi);

    const capture = await tools
      .get("tendril_capture")
      .execute("call-1", { kind: "window", target: "4", includeList: false }, new AbortController().signal);
    const describe = await tools
      .get("tendril_describe")
      .execute("call-2", { kind: "display", target: "1", pathOnly: true }, new AbortController().signal);

    const expectedKeys = ["outputPath", "target", "envelope", "sourceMachine", "pathOnly", "includeList"].sort();
    assert.deepEqual(Object.keys(capture.data).sort(), expectedKeys);
    assert.deepEqual(Object.keys(describe.data).sort(), expectedKeys);

    // Flags are derived consistently from params by the shared builder.
    assert.equal(capture.data.pathOnly, false);
    assert.equal(capture.data.includeList, false);
    assert.equal(describe.data.pathOnly, true);
    assert.equal(describe.data.includeList, true);
    assert.equal(typeof capture.data.outputPath, "string");
    assert.equal(typeof describe.data.outputPath, "string");
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
    assert.match(status.content[0].text, /kitty preview=(pending|off)|kitty preview image=/);
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
  assert.match(result.content[0].text, /^display=display (?:available|MISSING) \(/m);
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
    assert.equal(completeCalls[0].model.id, "claude-opus-4.8");
    assert.equal(completeCalls[0].options.apiKey, "key-for-github-copilot-claude-opus-4.8");
    assert.match(completeCalls[0].request.messages[0].content[0].text, /focus on errors/);
    assert.equal(completeCalls[0].request.messages[0].content[1].type, "image");
    assert.equal(completeCalls[0].request.messages[0].content[1].data, ONE_PIXEL_PNG.toString("base64"));
    assert.equal(userMessages.length, 1);
    assert.equal(typeof userMessages[0].content, "string");
    assert.match(userMessages[0].content, /screenshot description from github-copilot\/claude-opus-4\.8/);
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
    assert.match(notifications.at(-1).message, /kitty preview=(pending|off)|kitty preview image=/);
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
    remoteSource: "env",
    wslTunnelSource: "env",
  });
});

test("buildTendrilCommand applies per-call remote/wslTunnel overrides over env", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev", AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" };
  // Override targets a different host and disables the tunnel for this call only.
  assert.deepEqual(
    __tendrilShareTest.buildTendrilCommand(["list", "--json"], env, { remote: "astra", wslTunnel: false }),
    {
      command: "tendril",
      args: ["--remote", "astra", "list", "--json"],
      remote: "astra",
      wslTunnel: false,
      remoteSource: "override",
      wslTunnelSource: "override",
    },
  );
  // Empty-string remote override forces the local bridge even when env sets one.
  const local = __tendrilShareTest.buildTendrilCommand(["list", "--json"], env, { remote: "" });
  assert.deepEqual(local.args, ["--wsl-tunnel", "list", "--json"]);
  assert.equal(local.remote, null);
  assert.equal(local.remoteSource, "override");
  assert.equal(local.wslTunnelSource, "env");
  // Omitted override keys fall back to env defaults.
  const fallback = __tendrilShareTest.buildTendrilCommand(["list", "--json"], env, {});
  assert.deepEqual(fallback.args, ["--remote", "ms-dev", "--wsl-tunnel", "list", "--json"]);
  assert.equal(fallback.remoteSource, "env");
});

test("overrideFromParams forwards only explicitly provided bridge keys", () => {
  assert.equal(__tendrilShareTest.overrideFromParams({}), undefined);
  assert.equal(__tendrilShareTest.overrideFromParams({ kind: "window", target: "4" }), undefined);
  assert.deepEqual(__tendrilShareTest.overrideFromParams({ remote: "astra" }), { remote: "astra" });
  assert.deepEqual(__tendrilShareTest.overrideFromParams({ remote: "", wslTunnel: true }), { remote: "", wslTunnel: true });
});

test("parseShareFlags parses --remote, --local, and --wsl-tunnel slash flags", () => {
  assert.deepEqual(
    __tendrilShareTest.parseShareFlags(["window", "Safari", "--remote", "astra", "--wsl-tunnel", "inspect"]),
    { tokens: ["window", "Safari", "inspect"], flags: { pathOnly: false, includeList: true, remote: "astra", wslTunnel: true } },
  );
  assert.deepEqual(
    __tendrilShareTest.parseShareFlags(["window", "4", "--remote=ms-dev"]),
    { tokens: ["window", "4"], flags: { pathOnly: false, includeList: true, remote: "ms-dev" } },
  );
  assert.deepEqual(
    __tendrilShareTest.parseShareFlags(["window", "4", "--local", "--no-wsl-tunnel"]),
    { tokens: ["window", "4"], flags: { pathOnly: false, includeList: true, remote: "", wslTunnel: false } },
  );
});

test("parseCaptureArgs threads remote override flags into the parsed command", () => {
  const parsed = __tendrilShareTest.parseCaptureArgs("window Safari --remote astra inspect now");
  assert.equal(parsed.action, "capture");
  assert.equal(parsed.kind, "window");
  assert.equal(parsed.target, "Safari");
  assert.equal(parsed.remote, "astra");
  assert.equal(parsed.prompt, "inspect now");
});

test("tendril_capture forwards a per-call remote override to the tendril bridge", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools, execCalls } = makeHarness();
    tendrilShareExtension(pi);

    await tools.get("tendril_capture").execute("call-1", { kind: "window", target: "4", remote: "astra", wslTunnel: true, includeList: false }, new AbortController().signal);

    // Every tendril invocation (list resolution + capture) should carry the override prefix.
    for (const call of execCalls) {
      assert.equal(call.command, "tendril");
      assert.equal(call.args[0], "--remote");
      assert.equal(call.args[1], "astra");
      assert.equal(call.args[2], "--wsl-tunnel");
    }
    const captureCall = execCalls.find((call) => call.args.includes("capture"));
    assert.ok(captureCall, "expected a capture invocation");
    assert.ok(captureCall.args.includes("--window"));
    assert.ok(captureCall.args.includes("4"));
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("resolveSourceMachine derives source machine from bridge override and env", () => {
  // Remote override identifies the source machine for inference association.
  const remote = __tendrilShareTest.resolveSourceMachine({ remote: "astra" }, {});
  assert.deepEqual(remote, { host: "astra", remote: true, source: "override" });

  // Env-configured remote is honoured when no override is supplied.
  const envRemote = __tendrilShareTest.resolveSourceMachine(undefined, { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev" });
  assert.deepEqual(envRemote, { host: "ms-dev", remote: true, source: "env" });

  // No remote anywhere collapses to the local source machine label.
  const local = __tendrilShareTest.resolveSourceMachine(undefined, {});
  assert.deepEqual(local, { host: "local", remote: false, source: "env" });

  // Empty-string override forces local even when env sets a remote host.
  const forcedLocal = __tendrilShareTest.resolveSourceMachine({ remote: "" }, { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev" });
  assert.deepEqual(forcedLocal, { host: "local", remote: false, source: "override" });

  assert.equal(__tendrilShareTest.sourceMachineLabel({ host: "astra", remote: true }), "astra");
  assert.equal(__tendrilShareTest.sourceMachineLabel({ host: "astra", remote: false }), "local");
  assert.equal(__tendrilShareTest.sourceMachineLabel(undefined), "local");
});

test("tendril_describe associates inference result with the remote source machine", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools } = makeHarness();
    tendrilShareExtension(pi);

    const result = await tools.get("tendril_describe").execute(
      "call-describe",
      { kind: "window", target: "4", remote: "astra", includeList: false },
      new AbortController().signal,
    );

    // Inference result data carries the source machine for downstream association.
    assert.deepEqual(result.data.sourceMachine, { host: "astra", remote: true, source: "override" });
    // The textual context surfaces the source machine so the model can attribute it.
    assert.match(result.content[0].text, /Source machine: astra/);
    // The on-disk artifact filename is namespaced by source machine to avoid collisions.
    assert.match(path.basename(result.data.outputPath), /-astra-window-4\.png$/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("/tendril describe tags the inference description with its source machine", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  const completeCalls = [];
  setTendrilShareCompleteForTest(async (model, request, options) => {
    completeCalls.push({ model, request, options });
    return {
      content: [{ type: "text", text: "Remote dashboard visible." }],
      stopReason: "end_turn",
      usage: { inputTokens: 5, outputTokens: 4 },
    };
  });
  try {
    const { pi, commands, userMessages, ctx } = makeHarness();
    tendrilShareExtension(pi);

    await commands.get("tendril").handler("describe window 4 --remote astra --no-list", ctx);

    // The inference request prompt carries the source machine for attribution.
    assert.match(completeCalls[0].request.messages[0].content[0].text, /Source machine: astra/);
    // The shared description message attributes the source machine to the operator/model.
    assert.equal(userMessages.length, 1);
    assert.match(userMessages[0].content, /source machine astra/);
    assert.match(userMessages[0].content, /Source machine: astra/);
    assert.match(userMessages[0].content, /Remote dashboard visible/);
  } finally {
    setTendrilShareCompleteForTest();
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});

test("concurrent remote captures from different machines produce distinct artifacts", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "tendril-share-test-"));
  const oldDir = process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
  process.env.TENDRIL_SHARE_SCREENSHOT_DIR = tmp;
  try {
    const { pi, tools } = makeHarness();
    tendrilShareExtension(pi);
    const capture = tools.get("tendril_capture");

    // Two remote hosts capturing the same window id concurrently must not collide.
    const [astra, msDev] = await Promise.all([
      capture.execute("call-a", { kind: "window", target: "4", remote: "astra", includeList: false }, new AbortController().signal),
      capture.execute("call-b", { kind: "window", target: "4", remote: "ms-dev", includeList: false }, new AbortController().signal),
    ]);

    assert.deepEqual(astra.data.sourceMachine, { host: "astra", remote: true, source: "override" });
    assert.deepEqual(msDev.data.sourceMachine, { host: "ms-dev", remote: true, source: "override" });
    assert.notEqual(astra.data.outputPath, msDev.data.outputPath);
    assert.match(path.basename(astra.data.outputPath), /-astra-window-4\.png$/);
    assert.match(path.basename(msDev.data.outputPath), /-ms-dev-window-4\.png$/);
  } finally {
    if (oldDir === undefined) delete process.env.TENDRIL_SHARE_SCREENSHOT_DIR;
    else process.env.TENDRIL_SHARE_SCREENSHOT_DIR = oldDir;
    await rm(tmp, { recursive: true, force: true });
  }
});
