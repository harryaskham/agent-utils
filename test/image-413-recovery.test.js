import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createImage413RecoveryExtension } from "../extensions/image-413-recovery.js";
import {
  IMAGE_413_ENTRY_TYPE,
  createHalfImagePreview,
  halfDimensions,
  imageMessageKey,
  imageRecoveryMessage,
  isImagePayload413,
  latestImageToolCandidate,
  pngDimensions,
  replaceRecoveredImageMessage,
} from "../extensions/lib/image-413-recovery.js";

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test("413 classification is exact and unrelated provider errors stay untouched", () => {
  assert.equal(isImagePayload413(413), true);
  assert.equal(isImagePayload413(400, "413 Request Entity Too Large"), true);
  assert.equal(isImagePayload413(undefined, 'OpenAI API error (413): {"message":"failed to parse request"}'), true);
  assert.equal(isImagePayload413(401, "unauthorized"), false);
  assert.equal(isImagePayload413(429, "too many requests"), false);
});

test("PNG dimensions and half-size calculation preserve aspect ratio by exact halving", () => {
  assert.deepEqual(pngDimensions(pngHeader(2480, 3508)), { width: 2480, height: 3508 });
  assert.deepEqual(halfDimensions({ width: 2480, height: 3508 }), { width: 1240, height: 1754 });
  assert.deepEqual(halfDimensions({ width: 1, height: 1 }), { width: 1, height: 1 });
});

test("half preview uses exact target dimensions and leaves the original untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "image-413-half-"));
  const input = join(dir, "briefing.png");
  const original = pngHeader(3508, 2480);
  writeFileSync(input, original);
  const calls = [];
  const execFileImpl = (command, args, _options, callback) => {
    calls.push({ command, args });
    const output = args.at(-1);
    writeFileSync(output, pngHeader(1754, 1240));
    callback(null, "", "");
  };
  try {
    const result = await createHalfImagePreview(input, { cwd: dir, previewDir: join(dir, "previews"), execFileImpl });
    assert.equal(result.ok, true);
    assert.deepEqual({ width: result.width, height: result.height }, { width: 1754, height: 1240 });
    assert.deepEqual(calls[0].args.slice(1, 4), ["-auto-orient", "-resize", "1754x1240!"]);
    assert.deepEqual(pngDimensions(await import("node:fs").then(({ readFileSync }) => readFileSync(input))), { width: 3508, height: 2480 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("replacement targets only the exact failed tool result", () => {
  const recovery = { toolCallId: "read-2", message: "Image read failed: 413. A resized version is available at: /tmp/half.png" };
  const older = { role: "toolResult", toolCallId: "read-1", content: [{ type: "image", data: "old" }] };
  const failed = { role: "toolResult", toolCallId: "read-2", content: [{ type: "text", text: "x" }, { type: "image", data: "large" }] };
  const user = { role: "user", content: [{ type: "image", data: "user" }] };
  assert.equal(replaceRecoveredImageMessage(older, recovery), older);
  assert.equal(replaceRecoveredImageMessage(user, recovery), user);
  const replaced = replaceRecoveredImageMessage(failed, recovery);
  assert.deepEqual(replaced.content, [{ type: "text", text: recovery.message }]);
  assert.equal(replaced.details.image413Recovery.replaced, true);
});

function harness({ resize, entries = [], cwd = process.cwd() } = {}) {
  const handlers = new Map();
  const appended = [];
  const sent = [];
  const notifications = [];
  const pi = {
    on(name, fn) { const list = handlers.get(name) || []; list.push(fn); handlers.set(name, list); },
    registerCommand() {},
    registerEntryRenderer() {},
    appendEntry(type, data) { appended.push({ type: "custom", customType: type, data }); },
    sendMessage(message, options) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd,
    sessionManager: { getBranch: () => [...entries, ...appended] },
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  createImage413RecoveryExtension({ resize })(pi);
  const emit = async (name, event) => {
    let result;
    for (const fn of handlers.get(name) || []) result = await fn(event || {}, ctx);
    return result;
  };
  return { handlers, appended, sent, notifications, ctx, emit };
}

test("provider 413 replaces the latest image read, queues one retry, and persists recovery", async () => {
  let resizeCalls = 0;
  const h = harness({ resize: async (path) => {
    resizeCalls += 1;
    return { ok: true, originalPath: path, previewPath: `${process.cwd()}/.pi/image-guard/previews/half.png`, originalWidth: 2480, originalHeight: 3508, width: 1240, height: 1754 };
  } });
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolName: "read", toolCallId: "read-2", args: { path: "briefing.png" } });
  await h.emit("tool_execution_end", { toolName: "read", toolCallId: "read-2", result: { content: [{ type: "image", data: "large" }] } });
  await h.emit("after_provider_response", { status: 413 });
  assert.equal(resizeCalls, 1);
  assert.equal(h.appended[0].customType, IMAGE_413_ENTRY_TYPE);
  assert.match(h.appended[0].data.message, /^Image read failed: 413 Request Entity Too Large\. A resized version is available at:/);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { deliverAs: "followUp", triggerTurn: true });

  const context = await h.emit("context", { messages: [
    { role: "toolResult", toolCallId: "read-1", content: [{ type: "image", data: "old" }] },
    { role: "toolResult", toolCallId: "read-2", content: [{ type: "image", data: "large" }] },
    { role: "custom", customType: "agent-utils-image-413-retry", content: "hidden" },
  ] });
  assert.equal(context.messages.length, 2);
  assert.equal(context.messages[0].content[0].type, "image");
  assert.equal(context.messages[1].content[0].type, "text");

  await h.emit("after_provider_response", { status: 413 });
  assert.equal(resizeCalls, 1, "the same recovery never queues a second retry");
  assert.equal(h.sent.length, 1);
});

test("resize failure still prunes the image and reports bounded failure text", async () => {
  const dir = mkdtempSync(join(tmpdir(), "image-413-fail-"));
  try {
    const h = harness({ cwd: dir, resize: async () => ({ ok: false, error: "no resize tool" }) });
    await h.emit("session_start");
    await h.emit("tool_execution_start", { toolName: "read", toolCallId: "read-fail", args: { path: "large.jpg" } });
    await h.emit("tool_execution_end", { toolName: "read", toolCallId: "read-fail", result: { content: [{ type: "image", data: "large" }] } });
    await h.emit("after_provider_response", { status: 413 });
    const result = await h.emit("context", { messages: [{ role: "toolResult", toolCallId: "read-fail", content: [{ type: "image", data: "large" }] }] });
    assert.match(result.messages[0].content[0].text, /Resizing also failed: no resize tool/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful provider response clears the candidate and unrelated later 413 is ignored", async () => {
  let calls = 0;
  const h = harness({ resize: async () => { calls += 1; return { ok: false }; } });
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolName: "read", toolCallId: "read-ok", args: { path: "ok.png" } });
  await h.emit("tool_execution_end", { toolName: "read", toolCallId: "read-ok", result: { content: [{ type: "image", data: "ok" }] } });
  await h.emit("after_provider_response", { status: 200 });
  await h.emit("after_provider_response", { status: 413 });
  assert.equal(calls, 0);
  assert.equal(h.sent.length, 0);
});

test("restored Tendril and user images are discovered without current-process tool events", async () => {
  const tendril = {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "tendril-1",
      toolName: "tendril_pi_capture",
      content: [
        { type: "text", text: "Captured.\nSaved screenshot: /tmp/tendril.png\n" },
        { type: "image", data: "large-tendril" },
      ],
    },
  };
  const user = { type: "message", message: { role: "user", content: [{ type: "image", data: "clipboard-image" }] } };
  assert.deepEqual(latestImageToolCandidate([tendril]), {
    messageKey: "tool:tendril-1", toolCallId: "tendril-1", path: "/tmp/tendril.png", imageData: "large-tendril", mimeType: "image/png", toolName: "tendril_pi_capture",
  });
  assert.match(latestImageToolCandidate([tendril, user]).messageKey, /^image:/);

  const h = harness({ entries: [tendril], resize: async () => ({ ok: true, previewPath: "/tmp/tendril-half.png" }) });
  await h.emit("session_start");
  await h.emit("after_provider_response", { status: 413 });
  assert.equal(h.appended[0].data.toolCallId, "tendril-1");

  const userDir = mkdtempSync(join(tmpdir(), "image-413-user-"));
  try {
    const userHarness = harness({ cwd: userDir, entries: [user], resize: async () => { throw new Error("resize failed after materialization"); } });
    await userHarness.emit("session_start");
    await userHarness.emit("after_provider_response", { status: 413 });
    const context = await userHarness.emit("context", { messages: [user.message] });
    assert.equal(context.messages[0].content[0].type, "text");
    assert.match(context.messages[0].content[0].text, /resize failed after materialization/);
  } finally { rmSync(userDir, { recursive: true, force: true }); }
});

test("image message keys are stable and tolerate non-array message content", () => {
  const message = { role: "user", content: [{ type: "image", data: "abc" }] };
  assert.equal(imageMessageKey(message), imageMessageKey(structuredClone(message)));
  assert.equal(imageMessageKey({ role: "assistant", content: "plain text" }), "");
  assert.equal(imageMessageKey({ role: "custom", content: null }), "");
});

test("agent_end recovers provider 413 when no raw response hook fired", async () => {
  const imageEntry = {
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "read-agent-end",
      toolName: "read",
      content: [{ type: "text", text: "Saved image: /tmp/agent-end.png" }, { type: "image", data: "large" }],
    },
  };
  const h = harness({
    entries: [imageEntry],
    resize: async () => ({ ok: true, previewPath: "/tmp/agent-end-half.png", width: 10, height: 10 }),
  });
  await h.emit("session_start");
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error", errorMessage: 'OpenAI API error (413): {"message":"failed to parse request"}' }] });
  assert.equal(h.sent.length, 1, "one repaired retry is queued");
  assert.equal(h.appended[0].data.toolCallId, "read-agent-end");
  const context = await h.emit("context", { messages: [imageEntry.message] });
  assert.equal(context.messages[0].content[0].type, "text");
  assert.match(context.messages[0].content[0].text, /resized version is available/);
});

test("recovery message never embeds multiline provider or resize output", () => {
  assert.equal(
    imageRecoveryMessage({ errorMessage: "413\nRequest Entity Too Large", resizeError: "failed\nsecret output" }),
    "Image read failed: 413 Request Entity Too Large. Resizing also failed: failed secret output",
  );
});
