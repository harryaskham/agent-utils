import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isIncognito, sharedTtsQueueEnabled, ttsFeedEnabled, sharedImagesEnabled } from "../extensions/lib/privacy.js";
import { appendTtsFeed, prepareTtsFeed } from "../extensions/lib/tts-feed.js";
import { archiveSharedImage } from "../extensions/lib/shared-images.js";
import { createSharedImagesExtension } from "../extensions/shared-images.js";
import { isPiCacoDisabled } from "../extensions/lib/cacophony-runtime.js";
import { isAhpDisabled } from "../extensions/lib/ahp-choice.js";
import { playTtsCommand } from "../extensions/lib/tts-command.js";
import { createInterruptiblePcmPlayer } from "../extensions/lib/tts.js";
import ttsQueueExtension from "../extensions/tts-queue.js";

const queueKey = Symbol.for("agent-utils.tts-queue.v1");
test("incognito overrides explicit shared-export opt-ins; individual ordinary-session opt-outs work", () => {
  const env = { PI_INCOGNITO: "true", PI_TTS_QUEUE_ENABLED: "1", PI_TTS_FEED_ENABLED: "1", PI_SHARED_IMAGES_ENABLED: "1" };
  assert.equal(isIncognito(env), true);
  for (const enabled of [sharedTtsQueueEnabled, ttsFeedEnabled, sharedImagesEnabled]) { assert.equal(enabled(env), false); assert.equal(enabled({}), true); }
  assert.equal(isPiCacoDisabled(env), true); assert.equal(isAhpDisabled(env), true);
  assert.equal(sharedTtsQueueEnabled({ PI_TTS_QUEUE_ENABLED: "off" }), false);
  assert.equal(ttsFeedEnabled({ PI_TTS_FEED_ENABLED: "false" }), false);
  assert.equal(sharedImagesEnabled({ PI_SHARED_IMAGES_ENABLED: "0" }), false);
});

test("private speech and image helpers create no shared files or archive observers", async () => {
  const root = await mkdtemp(join(tmpdir(), "incognito-artifacts-"));
  try {
    const env = { PI_INCOGNITO: "1", PI_AGENT_UTILS_STATE_DIR: join(root, "state"), PI_TTS_QUEUE_DIR: join(root, "queue") };
    assert.equal(await prepareTtsFeed(env), null);
    await appendTtsFeed({ text: "private text", kind: "tts", session: "private" }, { env });
    assert.equal(await archiveSharedImage({ path: "/must-not-read-this" }, {}, { env }), null);
    createSharedImagesExtension({ env })({ on() { assert.fail("incognito must not install archive observers"); } });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("private playback bypasses an already-present queue for PCM and opaque commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "incognito-playback-"));
  const previous = globalThis[queueKey];
  const env = { ...process.env, PI_INCOGNITO: "1", PI_TTS_MUTE_PATH: join(root, "mute.json") };
  let spawns = 0;
  const spawnImpl = () => {
    spawns++; const child = new EventEmitter(); child.stdin = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin.write = () => true; child.stdin.end = () => setImmediate(() => child.emit("close", 0));
    child.kill = () => child.emit("close", 0); return child;
  };
  const player = createInterruptiblePcmPlayer({ queue: true, spawnImpl });
  try {
    globalThis[queueKey] = { enqueue() { assert.fail("private PCM entered shared queue"); }, enqueueTask() { assert.fail("private command entered shared queue"); } };
    await player.play(Buffer.alloc(8), { env, streamName: "/tts" });
    assert.equal(spawns, 1);
    assert.equal((await playTtsCommand("private", { env, command: "exit 0", speechKind: "choices" })).interrupted, false);
    assert.deepEqual(await readdir(root), []);
  } finally { player.dispose(); globalThis[queueKey] = previous; await rm(root, { recursive: true, force: true }); }
});

test("an explicitly loaded queue extension is inert in incognito and does not replace another session's queue", () => {
  const old = process.env.PI_INCOGNITO, previous = globalThis[queueKey], sentinel = {};
  try {
    process.env.PI_INCOGNITO = "1"; globalThis[queueKey] = sentinel;
    ttsQueueExtension({ on() { assert.fail("queue lifecycle registered"); }, registerCommand() { assert.fail("queue command registered"); }, registerTool() { assert.fail("queue tool registered"); } });
    assert.equal(globalThis[queueKey], sentinel);
  } finally { if (old === undefined) delete process.env.PI_INCOGNITO; else process.env.PI_INCOGNITO = old; globalThis[queueKey] = previous; }
});
