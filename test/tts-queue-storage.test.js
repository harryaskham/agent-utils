import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { MachineTtsQueue } from "../extensions/lib/tts-queue.js";
import { enforceTtsQueueStorage, MAX_TTS_QUEUE_BYTES, STALE_QUEUE_FILE_MS } from "../extensions/lib/tts-queue-storage.js";

async function waitFor(predicate, message = "condition did not settle") {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function heldPlayer() {
  let finish;
  return { play() { return new Promise((resolve) => { finish = resolve; }); }, interrupt() { finish?.({ interrupted: true }); }, finish() { finish?.({ interrupted: false }); } };
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tts-storage-")), queues = [];
  mkdirSync(join(root, "jobs")); mkdirSync(join(root, "active"));
  t.after(async () => {
    for (const queue of queues) { if (queue.current) queue.cancel(queue.current.id); queue.stop(); queue.player.interrupt(); }
    await Promise.all(queues.map((queue) => queue.maintenance?.catch(() => {})));
    await waitFor(() => queues.every((queue) => queue.admitting.size === 0 && queue.current === null), "queue shutdown");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, queue(options = {}) {
    const queue = new MachineTtsQueue({ root, player: heldPlayer(), pollMs: 10, ...options });
    queues.push(queue); return queue;
  } };
}
function seed(root, { directory = "jobs", bytes = 100, createdAt = Date.now(), ownerPid = process.pid, workerPid = process.pid, cancel = false } = {}) {
  const id = `${String(createdAt).padStart(13, "0")}-${ownerPid}-${randomUUID()}`;
  const base = join(root, directory, id);
  const record = { id, ownerPid, bytes, createdAt, durationMs: 60_000, options: {} };
  if (directory === "active") Object.assign(record, { workerPid, startedAt: createdAt, expectedEndAt: Date.now() + 60_000 });
  writeFileSync(`${base}.pcm`, Buffer.alloc(bytes, 42), { mode: 0o600 });
  writeFileSync(`${base}.json`, JSON.stringify(record), { mode: 0o600 });
  if (cancel) writeFileSync(`${base}.cancel`, "1", { mode: 0o600 });
  return { id, base, bytes: bytes + statSync(`${base}.json`).size + (cancel ? 1 : 0) };
}
function spoolBytes(root) {
  return ["jobs", "active"].flatMap((dir) => readdirSync(join(root, dir)).map((name) => join(root, dir, name)))
    .reduce((sum, path) => { const stat = lstatSync(path); return sum + (stat.isFile() ? stat.size : 0); }, 0);
}

test("queue hard ceiling is one GiB and oversize clips never reach disk", async (t) => {
  const f = fixture(t), queue = f.queue({ maxBytes: 1024 });
  assert.equal(MAX_TTS_QUEUE_BYTES, 1_073_741_824);
  assert.throws(() => f.queue({ maxBytes: MAX_TTS_QUEUE_BYTES + 1 }), /1 GiB/);
  assert.deepEqual(await queue.enqueue(Buffer.alloc(1025)), { interrupted: true, dropped: true, reason: "storage_limit" });
  assert.equal(spoolBytes(f.root), 0);
});

test("old ownerless lock is recovered but fresh initialization and live old leases are protected", (t) => {
  const f = fixture(t), queue = f.queue();
  const lock = join(f.root, "lock");
  mkdirSync(lock);
  assert.equal(queue.withLock(() => 1), null);
  const old = new Date(Date.now() - 10_000); utimesSync(lock, old, old);
  assert.equal(queue.withLock(() => 42), 42);
  assert.equal(existsSync(lock), false);
  mkdirSync(lock); writeFileSync(join(lock, "owner"), String(process.pid));
  utimesSync(lock, old, old);
  assert.equal(queue.withLock(() => 1), null, "a long scan cannot have its live lock stolen");
});

test("the machine lock stays held until asynchronous maintenance has finished", async (t) => {
  const f = fixture(t), first = f.queue(), second = f.queue();
  let release;
  const held = first.withLock(() => new Promise((resolve) => { release = resolve; }));
  assert.equal(second.withLock(() => true), null);
  release("finished"); assert.equal(await held, "finished");
  assert.equal(second.withLock(() => true), true);
});

test("startup drains cancelled legacy audio even when no job can be played", async (t) => {
  const f = fixture(t), queue = f.queue({ maxBytes: 4096 });
  seed(f.root, { directory: "active", bytes: 200 });
  for (let i = 0; i < 12; i++) seed(f.root, { bytes: 2048, createdAt: Date.now() - 1000 + i, ownerPid: 2147483647, cancel: true });
  mkdirSync(join(f.root, "lock"));
  const old = new Date(Date.now() - 10_000); utimesSync(join(f.root, "lock"), old, old);
  assert.ok(spoolBytes(f.root) > queue.maxBytes);
  queue.start();
  await waitFor(() => queue.storage.checkedAt !== null && readdirSync(join(f.root, "jobs")).length === 0);
  assert.ok(spoolBytes(f.root) <= queue.maxBytes);
  assert.equal(queue.status().active, 1, "active playback remains protected");
});

test("size eviction removes the oldest waiting job, not active or newer speech", async (t) => {
  const f = fixture(t);
  const active = seed(f.root, { directory: "active", bytes: 200 });
  const oldest = seed(f.root, { bytes: 700, createdAt: Date.now() - 2000 });
  const newest = seed(f.root, { bytes: 600, createdAt: Date.now() - 1000 });
  const maxBytes = active.bytes + newest.bytes + Buffer.byteLength("storage_limit");
  const result = await enforceTtsQueueStorage(f.root, { maxBytes });
  assert.deepEqual(result.evicted, [oldest.id]);
  assert.equal(existsSync(`${oldest.base}.pcm`), false);
  assert.equal(readFileSync(`${oldest.base}.cancel`, "utf8"), "storage_limit");
  assert.equal(existsSync(`${newest.base}.pcm`), true);
  assert.equal(existsSync(`${active.base}.pcm`), true);
  assert.equal(result.bytes, spoolBytes(f.root));
  assert.ok(result.bytes <= maxBytes);
});

test("active-only overflow is reported without interrupting or deleting playback", async (t) => {
  const f = fixture(t), queue = f.queue({ maxBytes: 1024 });
  const active = seed(f.root, { directory: "active", bytes: 2048 });
  const result = await queue.maintainStorage();
  assert.equal(result.fits, false);
  assert.equal(existsSync(`${active.base}.pcm`), true);
  assert.equal(queue.status().storage.overLimit, true);
  assert.deepEqual(await queue.enqueue(Buffer.alloc(50)), { interrupted: true, dropped: true, reason: "storage_limit" });
  assert.equal(existsSync(`${active.base}.pcm`), true);
});

test("an incoming clip that cannot fit beside active speech does not evict healthy waiting work", async (t) => {
  const f = fixture(t);
  const active = seed(f.root, { directory: "active", bytes: 700 });
  const waiting = seed(f.root, { bytes: 100 });
  const maxBytes = active.bytes + waiting.bytes;
  const result = await enforceTtsQueueStorage(f.root, { maxBytes, reserveBytes: waiting.bytes + 10 });
  assert.equal(result.fits, false);
  assert.deepEqual(result.evicted, []);
  assert.equal(existsSync(`${waiting.base}.pcm`), true);
});

test("a cancelled incoming reservation does not discard healthy waiting speech", async (t) => {
  const f = fixture(t), waiting = seed(f.root, { bytes: 500 });
  const result = await enforceTtsQueueStorage(f.root, { maxBytes: waiting.bytes + 10, reserveBytes: 500, keepReservation: () => false });
  assert.equal(result.fits, true);
  assert.deepEqual(result.evicted, []);
  assert.equal(existsSync(`${waiting.base}.pcm`), true);
});

test("stale orphan PCM and partial files are removed; recent publication is left alone", async (t) => {
  const f = fixture(t);
  const stale = seed(f.root), recent = seed(f.root);
  rmSync(`${stale.base}.json`); rmSync(`${recent.base}.json`);
  writeFileSync(`${stale.base}.pcm.tmp`, "partial");
  const old = new Date(Date.now() - STALE_QUEUE_FILE_MS - 1000);
  utimesSync(`${stale.base}.pcm`, old, old); utimesSync(`${stale.base}.pcm.tmp`, old, old);
  await enforceTtsQueueStorage(f.root);
  assert.equal(existsSync(`${stale.base}.pcm`), false);
  assert.equal(existsSync(`${stale.base}.pcm.tmp`), false);
  assert.equal(existsSync(`${recent.base}.pcm`), true);
});

test("an interrupted claim is restored instead of orphaning its accepted audio", async (t) => {
  const f = fixture(t), job = seed(f.root);
  const pcm = readFileSync(`${job.base}.pcm`);
  rmSync(`${job.base}.pcm`);
  writeFileSync(join(f.root, "active", `${job.id}.pcm`), pcm);
  await enforceTtsQueueStorage(f.root);
  assert.equal(existsSync(`${job.base}.pcm`), true);
  assert.equal(existsSync(join(f.root, "active", `${job.id}.pcm`)), false);
});

test("a cancelled interrupted claim is cleaned rather than replayed", async (t) => {
  const f = fixture(t), job = seed(f.root);
  rmSync(`${job.base}.pcm`);
  writeFileSync(join(f.root, "active", `${job.id}.pcm`), "pcm");
  writeFileSync(join(f.root, "active", `${job.id}.cancel`), "1");
  await enforceTtsQueueStorage(f.root);
  assert.equal(existsSync(`${job.base}.pcm`), false);
  assert.equal(existsSync(`${job.base}.json`), false);
  assert.equal(existsSync(join(f.root, "active", `${job.id}.pcm`)), false);
  assert.equal(existsSync(`${job.base}.cancel`), true);
});

test("foreign files and symlink targets cannot be evicted or overwritten", async (t) => {
  const f = fixture(t), oldest = seed(f.root, { bytes: 700, createdAt: Date.now() - 1000 });
  const outside = join(f.root, "outside.txt"), foreign = join(f.root, "jobs", "keep-notes.txt");
  writeFileSync(outside, "outside-data"); writeFileSync(foreign, "foreign-data");
  symlinkSync(outside, `${oldest.base}.cancel`);
  const result = await enforceTtsQueueStorage(f.root, { maxBytes: 100 });
  assert.deepEqual(result.evicted, [oldest.id]);
  assert.equal(readFileSync(outside, "utf8"), "outside-data");
  assert.equal(readFileSync(foreign, "utf8"), "foreign-data");
  assert.equal(lstatSync(`${oldest.base}.cancel`).isSymbolicLink(), false);
});

test("cancellation reclaims waiting PCM while another job owns the playback slot", async (t) => {
  const f = fixture(t), first = f.queue(), second = f.queue();
  first.configure({ overlapMs: 0 });
  const active = first.enqueue(Buffer.alloc(48_000));
  await waitFor(() => first.current !== null);
  const waiting = second.enqueue(Buffer.alloc(24_000));
  await waitFor(() => !second.admitting.has(waiting.jobId));
  const path = join(f.root, "jobs", `${waiting.jobId}.pcm`);
  assert.equal(existsSync(path), true);
  second.cancel(waiting.jobId);
  assert.deepEqual(await waiting, { interrupted: true });
  await waitFor(() => !existsSync(path));
  assert.equal(existsSync(first.current.pcmPath), true);
  first.player.finish(); await active;
});

test("peer eviction is reported as dropped speech, never completed playback", async (t) => {
  const f = fixture(t), owner = f.queue({ maxBytes: 3000 }), peer = f.queue({ maxBytes: 1200 });
  const blocker = seed(f.root, { directory: "active", bytes: 100 });
  owner.configure({ overlapMs: 0 });
  const waiting = owner.enqueue(Buffer.alloc(700));
  await waitFor(() => !owner.admitting.has(waiting.jobId));
  const next = peer.enqueue(Buffer.alloc(500));
  await waitFor(() => !peer.admitting.has(next.jobId));
  owner.settleRemoteWaiters();
  assert.deepEqual(await waiting, { interrupted: true, dropped: true, reason: "storage_limit" });
  assert.ok(spoolBytes(f.root) <= peer.maxBytes);
  assert.equal(existsSync(`${blocker.base}.pcm`), true);
  peer.cancel(next.jobId); await next;
});

test("independent Node processes serialize byte admission and recover one abandoned lock", async (t) => {
  const f = fixture(t), children = [];
  seed(f.root, { directory: "active", bytes: 100 });
  writeFileSync(join(f.root, "config.json"), JSON.stringify({ maxParallel: 1, overlapMs: 0 }));
  mkdirSync(join(f.root, "lock"));
  const old = new Date(Date.now() - 10_000); utimesSync(join(f.root, "lock"), old, old);
  try {
    for (let i = 0; i < 4; i++) {
      const child = fork(new URL("./fixtures/tts-queue-storage-worker.mjs", import.meta.url), [f.root, "1800", "500"], {
        stdio: ["ignore", "ignore", "pipe", "ipc"], env: { PATH: process.env.PATH, HOME: f.root },
      });
      children.push(child);
      child.stderr.setEncoding("utf8");
      let stderr = ""; child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
      const [ready] = await once(child, "message", { signal: AbortSignal.timeout(4000) });
      assert.equal(ready.type, "ready", stderr);
    }
    const replies = children.map((child) => once(child, "message", { signal: AbortSignal.timeout(6000) }));
    for (const child of children) child.send("enqueue");
    for (const [reply] of await Promise.all(replies)) {
      assert.equal(reply.type, "admitted");
      assert.ok(reply.storage.bytes <= 1800);
    }
    assert.ok(spoolBytes(f.root) <= 1800, "no concurrent writer can bypass the machine byte budget");
  } finally {
    await Promise.all(children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      if (child.connected) child.send("stop");
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }));
  }
});

test("bulk maintenance yields to the event loop while reclaiming cancelled files", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 100; i++) seed(f.root, { bytes: 20, ownerPid: 2147483647, cancel: true });
  let turns = 0;
  const timer = setInterval(() => { turns++; }, 1);
  try {
    const result = await enforceTtsQueueStorage(f.root, { maxBytes: 1024, alive: () => false });
    assert.equal(result.bytes, 0);
    assert.ok(turns > 0, "large legacy cleanup must not block Pi's event loop");
  } finally { clearInterval(timer); }
});

test("pending admission memory includes metadata and refuses another over-budget buffer", async (t) => {
  const f = fixture(t), queue = f.queue({ maxBytes: 1024, admissionWaitMs: 100 });
  mkdirSync(join(f.root, "lock")); writeFileSync(join(f.root, "lock", "owner"), String(process.pid));
  const first = queue.enqueue(Buffer.alloc(500));
  const second = queue.enqueue(Buffer.alloc(500));
  assert.deepEqual(await second, { interrupted: true, dropped: true, reason: "storage_limit" });
  queue.cancel(first.jobId); await first;
  await waitFor(() => queue.admissionBytes === 0);
  assert.equal(spoolBytes(f.root), 0);
});

test("a fresh token protects initialization even before the owner file is published", (t) => {
  const f = fixture(t), queue = f.queue();
  mkdirSync(join(f.root, "lock"));
  writeFileSync(join(f.root, "lock", "token"), `${process.pid}:${randomUUID()}`);
  const old = new Date(Date.now() - 10_000); utimesSync(join(f.root, "lock"), old, old);
  assert.equal(queue.withLock(() => true), null);
});

test("bounded pending admissions can be cancelled without creating an orphan", async (t) => {
  const f = fixture(t), queue = f.queue({ maxBytes: 1024, admissionWaitMs: 100 });
  mkdirSync(join(f.root, "lock")); writeFileSync(join(f.root, "lock", "owner"), String(process.pid));
  const waiting = queue.enqueue(Buffer.alloc(500));
  queue.cancel(waiting.jobId);
  assert.deepEqual(await waiting, { interrupted: true });
  await waitFor(() => queue.admitting.size === 0);
  assert.equal(spoolBytes(f.root), 0);
});
