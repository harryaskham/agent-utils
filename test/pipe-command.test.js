import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

import pipeExtension, {
  DEFAULT_PIPE_TIMEOUT_MS,
  PIPE_MODES,
  applyPipeUpdate,
  formatPipeStatus,
  handlePipeInput,
  normalizePipeMode,
  parsePipeArguments,
  resolvePipeTimeoutMs,
  runPipeCommand,
  stripPipeOutputTerminator,
} from "../extensions/pipe.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeCtx(options = {}) {
  const choice = Object.prototype.hasOwnProperty.call(options, "choice") ? options.choice : "send";
  const notifications = [];
  const statuses = new Map();
  const selections = [];
  let editor = "";
  return {
    ctx: {
      cwd: "/work/project",
      mode: "tui",
      hasUI: true,
      ui: {
        notify(message, level = "info") { notifications.push({ message, level }); },
        setEditorText(text) { editor = String(text ?? ""); },
        setStatus(key, value) {
          if (value === undefined) statuses.delete(key);
          else statuses.set(key, value);
        },
        async select(title, items) {
          selections.push({ title, items });
          return choice;
        },
      },
    },
    notifications,
    statuses,
    selections,
    get editor() { return editor; },
  };
}

function makeHarness(options = {}) {
  const runCommand = options.runCommand ?? (async (_command, text) => text.toUpperCase());
  const handlers = new Map();
  const commands = new Map();
  const pi = {
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    registerCommand(name, definition) { commands.set(name, definition); },
  };
  const ui = makeCtx(
    Object.prototype.hasOwnProperty.call(options, "choice") ? { choice: options.choice } : {},
  );
  pipeExtension(pi, { runCommand });
  return {
    pi,
    handlers,
    commands,
    ctx: ui.ctx,
    notifications: ui.notifications,
    statuses: ui.statuses,
    selections: ui.selections,
    get editor() { return ui.editor; },
  };
}

async function dispatchInput(handlers, event, ctx) {
  let current = { ...event };
  for (const handler of handlers.get("input") || []) {
    const result = await handler(current, ctx);
    if (result?.action === "handled") return { result, event: current };
    if (result?.action === "transform") {
      current = {
        ...current,
        text: result.text,
        images: result.images === undefined ? current.images : result.images,
      };
    }
  }
  return { result: { action: "continue" }, event: current };
}

test("pipe modes, timeout, and output terminator helpers are strict", () => {
  assert.deepEqual(PIPE_MODES, ["on", "off", "auto"]);
  assert.equal(normalizePipeMode(" AUTO "), "auto");
  assert.equal(normalizePipeMode("yes"), undefined);
  assert.equal(resolvePipeTimeoutMs({ PI_PIPE_TIMEOUT_MS: "250" }), 250);
  assert.equal(resolvePipeTimeoutMs({ PI_PIPE_TIMEOUT_MS: "0" }), DEFAULT_PIPE_TIMEOUT_MS);
  assert.equal(resolvePipeTimeoutMs({ PI_PIPE_TIMEOUT_MS: "junk" }), DEFAULT_PIPE_TIMEOUT_MS);
  assert.equal(stripPipeOutputTerminator("hello\n"), "hello");
  assert.equal(stripPipeOutputTerminator("hello\r\n"), "hello");
  assert.equal(stripPipeOutputTerminator("hello\n\n"), "hello\n");
});

test("/pipe parser accepts quoted shell commands and mode updates", () => {
  assert.deepEqual(parsePipeArguments(""), { kind: "status" });
  assert.deepEqual(parsePipeArguments("status"), { kind: "status" });
  assert.deepEqual(parsePipeArguments("auto"), { kind: "update", mode: "auto" });
  assert.deepEqual(
    parsePipeArguments('cmd="sed \'s/foo/bar/g\'" mode=on'),
    { kind: "update", command: "sed 's/foo/bar/g'", mode: "on" },
  );
  assert.throws(() => parsePipeArguments("cmd=sed s/a/b/ mode=on"), /quote cmd values/);
  assert.throws(() => parsePipeArguments("mode=maybe"), /mode must be on, off, or auto/);
  assert.throws(() => parsePipeArguments("wat=x"), /unknown setting/);
});

test("pipe updates preserve omitted values and require a command for active modes", () => {
  assert.deepEqual(
    applyPipeUpdate({ command: "fix", mode: "on" }, { mode: "auto" }),
    { command: "fix", mode: "auto" },
  );
  assert.deepEqual(
    applyPipeUpdate({ command: "fix", mode: "auto" }, { mode: "off", command: "" }),
    { command: "", mode: "off" },
  );
  assert.throws(
    () => applyPipeUpdate({ command: "", mode: "off" }, { mode: "on" }),
    /cmd is required/,
  );
  assert.equal(formatPipeStatus({ command: "fix", mode: "auto" }), "pipe:auto · cmd:fix");
});

test("runPipeCommand sends text on stdin without shell interpolation and honors cwd/timeout", async () => {
  let spec;
  let stdin = "";
  const output = await runPipeCommand("fix --quiet", "hello $USER", {
    cwd: "/tmp/project",
    env: { PATH: "/bin" },
    timeoutMs: 321,
    runSubprocess: async (value) => {
      spec = value;
      value.onSpawn({
        stdin: {
          on() {},
          end(text) { stdin = text; },
        },
      });
      return { code: 0, stdout: Buffer.from("fixed hello\n"), stderr: Buffer.alloc(0) };
    },
  });

  assert.equal(spec.command, "fix --quiet");
  assert.deepEqual(spec.args, []);
  assert.deepEqual(spec.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(spec.spawnOptions.cwd, "/tmp/project");
  assert.equal(spec.spawnOptions.shell, true);
  assert.equal(spec.timeoutMs, 321);
  assert.equal(stdin, "hello $USER\n", "user text is stdin, not interpolated into the shell command");
  assert.equal(output, "fixed hello");
});

test("runPipeCommand surfaces bounded stderr for non-zero exits", async () => {
  await assert.rejects(
    runPipeCommand("bad", "input", {
      runSubprocess: async () => ({
        code: 7,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from("bad transform\n"),
      }),
    }),
    /exit code 7: bad transform/,
  );
});

test("mode=auto transforms interactive text immediately and preserves images", async () => {
  const image = { type: "image", source: { type: "base64", data: "abc" } };
  const harness = makeCtx();
  const result = await handlePipeInput(
    { command: "fix", mode: "auto" },
    { text: "teh message", source: "interactive", images: [image] },
    harness.ctx,
    { runCommand: async (command, text, options) => {
      assert.equal(command, "fix");
      assert.equal(text, "teh message");
      assert.equal(options.cwd, "/work/project");
      return "the message";
    } },
  );
  assert.deepEqual(result, { action: "transform", text: "the message", images: [image] });
  assert.equal(harness.selections.length, 0);
});

test("mode=on popup offers send, send raw, and cancel", async () => {
  for (const [choice, expectedAction, expectedText] of [
    ["send", "transform", "FIXED"],
    ["send raw", "continue", undefined],
    ["cancel", "handled", undefined],
    [undefined, "handled", undefined],
  ]) {
    const harness = makeCtx({ choice });
    const result = await handlePipeInput(
      { command: "fix", mode: "on" },
      { text: "raw", source: "interactive" },
      harness.ctx,
      { runCommand: async () => "FIXED" },
    );
    assert.equal(result.action, expectedAction, `choice ${String(choice)}`);
    assert.equal(result.text, expectedText, `choice ${String(choice)}`);
    assert.deepEqual(harness.selections[0].items, ["send", "send raw", "cancel"]);
    assert.match(harness.selections[0].title, /FIXED/);
    if (expectedAction === "handled") assert.equal(harness.editor, "raw");
  }
});

test("command failure or empty output cancels send and restores original editor text", async () => {
  for (const runCommand of [
    async () => { throw new Error("timed out"); },
    async () => "",
  ]) {
    const harness = makeCtx();
    const result = await handlePipeInput(
      { command: "fix", mode: "auto" },
      { text: "keep this", source: "interactive" },
      harness.ctx,
      { runCommand },
    );
    assert.equal(result.action, "handled");
    assert.equal(harness.editor, "keep this");
    assert.equal(harness.notifications.at(-1).level, "warning");
  }
});

test("pipe bypasses off mode, extension-injected messages, blanks, and slash commands", async () => {
  let calls = 0;
  const runCommand = async () => { calls += 1; return "changed"; };
  const harness = makeCtx();
  const cases = [
    [{ command: "fix", mode: "off" }, { text: "hello", source: "interactive" }],
    [{ command: "fix", mode: "auto" }, { text: "hello", source: "extension" }],
    [{ command: "fix", mode: "auto" }, { text: "   ", source: "interactive" }],
    [{ command: "fix", mode: "auto" }, { text: "/skill:thing", source: "interactive" }],
  ];
  for (const [config, event] of cases) {
    assert.deepEqual(
      await handlePipeInput(config, event, harness.ctx, { runCommand }),
      { action: "continue" },
    );
  }
  assert.equal(calls, 0);
});

test("/fix <mode> is an alias for cmd=fix with the selected mode", async () => {
  const h = makeHarness();
  assert.ok(h.commands.has("pipe"));
  assert.ok(h.commands.has("fix"));

  await h.commands.get("fix").handler("auto", h.ctx);
  assert.deepEqual(h.pi.agentUtilsPipe.getConfig(), { command: "fix", mode: "auto" });
  assert.equal(h.notifications.at(-1).message, "pipe:auto · cmd:fix");

  await h.commands.get("fix").handler("off", h.ctx);
  assert.deepEqual(h.pi.agentUtilsPipe.getConfig(), { command: "fix", mode: "off" });

  await h.commands.get("fix").handler("maybe", h.ctx);
  assert.match(h.notifications.at(-1).message, /Usage: \/fix/);
  assert.deepEqual(h.commands.get("fix").getArgumentCompletions("a").map((item) => item.value), ["auto"]);
});

test("/pipe command updates config and reports malformed unquoted commands", async () => {
  const h = makeHarness();
  await h.commands.get("pipe").handler('cmd="tr a-z A-Z" mode=on', h.ctx);
  assert.deepEqual(h.pi.agentUtilsPipe.getConfig(), { command: "tr a-z A-Z", mode: "on" });
  assert.match(h.statuses.get("pipe"), /on · tr a-z A-Z/);

  await h.commands.get("pipe").handler("cmd=sed s/a/b/ mode=auto", h.ctx);
  assert.equal(h.notifications.at(-1).level, "warning");
  assert.match(h.notifications.at(-1).message, /quote cmd values/);
  assert.deepEqual(h.pi.agentUtilsPipe.getConfig(), { command: "tr a-z A-Z", mode: "on" });
});

test("pipe loads before /read and downstream input handlers see exactly the selected text", async () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const extensions = pkg.pi.extensions;
  assert.ok(
    extensions.indexOf("./extensions/pipe.js") < extensions.indexOf("./extensions/read-aloud.js"),
    "pipe must load before read-aloud so /read speaks transformed text",
  );

  const transformed = makeHarness({ runCommand: async () => "the fixed message" });
  await transformed.commands.get("fix").handler("auto", transformed.ctx);
  const spoken = [];
  transformed.handlers.get("input").push((event) => {
    spoken.push(event.text); // Equivalent to /read's downstream on-send hook.
    return { action: "continue" };
  });
  const sent = await dispatchInput(
    transformed.handlers,
    { text: "teh fixed mesage", source: "interactive" },
    transformed.ctx,
  );
  assert.equal(sent.event.text, "the fixed message");
  assert.deepEqual(spoken, ["the fixed message"]);

  const raw = makeHarness({ runCommand: async () => "changed", choice: "send raw" });
  await raw.commands.get("fix").handler("on", raw.ctx);
  const rawSpoken = [];
  raw.handlers.get("input").push((event) => {
    rawSpoken.push(event.text);
    return { action: "continue" };
  });
  const rawSent = await dispatchInput(
    raw.handlers,
    { text: "original", source: "interactive" },
    raw.ctx,
  );
  assert.equal(rawSent.event.text, "original");
  assert.deepEqual(rawSpoken, ["original"]);

  const cancelled = makeHarness({ runCommand: async () => "changed", choice: "cancel" });
  await cancelled.commands.get("fix").handler("on", cancelled.ctx);
  const cancelledSpoken = [];
  cancelled.handlers.get("input").push((event) => {
    cancelledSpoken.push(event.text);
    return { action: "continue" };
  });
  const cancelledResult = await dispatchInput(
    cancelled.handlers,
    { text: "restore me", source: "interactive" },
    cancelled.ctx,
  );
  assert.equal(cancelledResult.result.action, "handled");
  assert.equal(cancelled.editor, "restore me");
  assert.deepEqual(cancelledSpoken, [], "/read must not speak a cancelled send");
});
