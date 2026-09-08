import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MachineTtsQueue, normalizeQueueConfig, pcmDurationMs } from "../extensions/lib/tts-queue.js";

test("queue config and PCM duration are bounded", () => {
  assert.deepEqual(normalizeQueueConfig({ maxParallel: 99, overlapMs: 99999 }), { maxParallel: 8, overlapMs: 30000 });
  assert.deepEqual(normalizeQueueConfig({ maxParallel: 0, overlapMs: -1 }), { maxParallel: 1, overlapMs: 0 });
  assert.equal(pcmDurationMs(48_000, {}), 1000);
  assert.equal(pcmDurationMs(48_000, { pan: 0 }), 1000);
  assert.equal(pcmDurationMs(96_000, { channels: 2 }), 1000);
});

test("machine queue persists, claims, plays, and removes a job without serializing env", async () => {
  const root = mkdtempSync(join(tmpdir(), "tts-queue-"));
  const played = [];
  const player = { interrupt() {}, async play(pcm, options) { played.push({ pcm: pcm.toString(), options }); return { interrupted: false }; } };
  const queue = new MachineTtsQueue({ root, player, pollMs: 10_000 });
  try {
    const pending = queue.enqueue(Buffer.from("pcm"), { backend: "pulse", env: { SECRET: "never-write" } });
    const metadata = ["jobs", "active"].flatMap((dir) => readdirSync(join(root, dir)).filter((name) => name.endsWith(".json")).map((name) => readFileSync(join(root, dir, name), "utf8"))).join("\n");
    if (metadata) assert.doesNotMatch(metadata, /never-write|SECRET/);
    assert.deepEqual(await pending, { interrupted: false });
    assert.equal(played[0].pcm, "pcm");
    assert.equal(played[0].options.backend, "pulse");
    assert.deepEqual(queue.status().queued, 0);
    assert.deepEqual(queue.status().active, 0);
  } finally { queue.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("two independent workers honor machine-global parallel capacity", async () => {
  const root = mkdtempSync(join(tmpdir(), "tts-queue-parallel-"));
  const finishes = [];
  const makePlayer = () => ({ interrupt() {}, play() { return new Promise((resolve) => finishes.push(resolve)); } });
  const first = new MachineTtsQueue({ root, player: makePlayer(), pollMs: 10_000 });
  const second = new MachineTtsQueue({ root, player: makePlayer(), pollMs: 10_000 });
  try {
    first.configure({ maxParallel: 2 });
    const a = first.enqueue(Buffer.alloc(48_000), { streamName: "a" });
    const b = second.enqueue(Buffer.alloc(48_000), { streamName: "b" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(first.status().active, 2);
    finishes.splice(0).forEach((finish) => finish({ interrupted: false }));
    await Promise.all([a, b]);
  } finally { first.stop(); second.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("skip current writes a cross-process cancellation marker", async () => {
  const root = mkdtempSync(join(tmpdir(), "tts-queue-skip-"));
  let interrupted = false;
  let finish;
  const player = { interrupt() { interrupted = true; finish?.({ interrupted: true }); }, play() { return new Promise((resolve) => { finish = resolve; }); } };
  const queue = new MachineTtsQueue({ root, player, pollMs: 10 });
  try {
    const pending = queue.enqueue(Buffer.alloc(48_000), {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(queue.skipCurrent(), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(interrupted, true);
    assert.deepEqual(await pending, { interrupted: true });
  } finally { queue.stop(); rmSync(root, { recursive: true, force: true }); }
});
