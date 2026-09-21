import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { enforceTtsQueueStorage, isTtsQueueJobId, MAX_TTS_QUEUE_BYTES } from "./tts-queue-storage.js";

const LOCK_GRACE_MS = 5000;
const STORAGE_MAINTENANCE_MS = 30_000;

export const TTS_QUEUE_SYMBOL = Symbol.for("agent-utils.tts-queue.v1");
export const DEFAULT_TTS_QUEUE_CONFIG = Object.freeze({ maxParallel: 1, overlapMs: 2000 });

export function ttsQueueAgentToolsEnabled(env = process.env) {
  return ["1", "true", "yes", "on"].includes(String(env.PI_TTS_QUEUE_AGENT_TOOLS || "").trim().toLowerCase());
}

export function ttsQueueRoot(env = process.env) {
  return env.PI_TTS_QUEUE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agent-utils", "tts-queue");
}

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { rmSync(tmp, { force: true }); }
}
function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }
function alive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch (error) { return error.code === "EPERM"; }
}
function regularFile(path) { try { return lstatSync(path).isFile(); } catch { return false; } }
function cancellationResult(path) {
  try {
    const reason = readFileSync(path, "utf8").trim();
    return reason === "storage_limit" ? { interrupted: true, dropped: true, reason } : { interrupted: true };
  } catch { return { interrupted: true }; }
}

export function normalizeQueueConfig(value = {}) {
  const maxParallel = Math.max(1, Math.min(8, Math.trunc(Number(value.maxParallel) || 1)));
  const overlapMs = Math.max(0, Math.min(30_000, Math.trunc(Number(value.overlapMs) || 0)));
  return { maxParallel, overlapMs };
}

export function pcmDurationMs(bytes, options = {}) {
  // Queuing happens before the raw player applies mono→stereo panning, so pan
  // does not change source duration. Explicit channels is reserved for callers
  // that already provide interleaved multi-channel PCM.
  const channels = Number(options.channels) || 1;
  return Math.ceil(Number(bytes || 0) / (24_000 * channels * 2) * 1000);
}

export class MachineTtsQueue {
  constructor({ root = ttsQueueRoot(), player, pollMs = 200, now = Date.now, maxBytes = MAX_TTS_QUEUE_BYTES, admissionWaitMs = 10_000 } = {}) {
    if (!player) throw new Error("MachineTtsQueue requires a raw player");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_TTS_QUEUE_BYTES) throw new Error("TTS queue byte limit must be between 1 and 1 GiB");
    this.root = root; this.player = player; this.pollMs = pollMs; this.now = now;
    this.maxBytes = maxBytes; this.admissionWaitMs = admissionWaitMs;
    this.current = null; this.timer = null; this.waiters = new Map();
    this.tasks = new Map(); this.taskAbort = null;
    this.admitting = new Set(); this.admissionBytes = 0; this.stopped = false;
    this.acknowledgedCancellations = new Set();
    this.maintenance = null; this.needsMaintenance = true; this.lastMaintenance = null;
    this.storage = { bytes: null, maxBytes, checkedAt: null }; this.lastError = null;
    mkdirSync(join(root, "jobs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "active"), { recursive: true, mode: 0o700 });
  }
  config() { return normalizeQueueConfig(readJson(join(this.root, "config.json"), DEFAULT_TTS_QUEUE_CONFIG)); }
  configure(patch) { const next = normalizeQueueConfig({ ...this.config(), ...patch }); atomicJson(join(this.root, "config.json"), next); this.kick(); return next; }
  kick() { void this.tick().catch((error) => { this.lastError = error.code || error.message; }); }
  start() {
    if (this.timer) return;
    this.stopped = false; this.needsMaintenance = true;
    this.timer = setInterval(() => this.kick(), this.pollMs); this.timer.unref?.(); this.kick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null; this.stopped = true;
    for (const id of this.tasks.keys()) this.cancel(id);
    this.taskAbort?.abort();
  }
  interruptCurrent() { if (this.taskAbort) this.taskAbort.abort(); else this.player.interrupt(); }
  enqueueTask(run, options = {}) {
    if (typeof run !== "function") throw new Error("TTS queue task requires a function");
    return this.enqueue(Buffer.from([0]), options, run);
  }
  withLock(fn) {
    const lock = join(this.root, "lock"), token = `${process.pid}:${randomUUID()}`;
    const create = () => {
      mkdirSync(lock, { mode: 0o700 });
      try {
        writeFileSync(join(lock, "token"), token, { mode: 0o600, flag: "wx" });
        const temporary = join(lock, `owner.${process.pid}.tmp`);
        writeFileSync(temporary, String(process.pid), { mode: 0o600, flag: "wx" });
        renameSync(temporary, join(lock, "owner"));
      } catch (error) {
        try { if (readFileSync(join(lock, "token"), "utf8") === token) rmSync(lock, { recursive: true, force: true }); } catch {}
        throw error;
      }
    };
    try { create(); }
    catch {
      try {
        const before = lstatSync(lock);
        if (!before.isDirectory()) return null;
        let owner = null;
        try { owner = Number(readFileSync(join(lock, "owner"), "utf8")); } catch (error) { if (error.code !== "ENOENT") return null; }
        // An abandoned mkdir can have no owner file. Give fresh initialization
        // a grace period, but never steal a live lease just because work is slow.
        const validOwner = Number.isSafeInteger(owner) && owner > 0;
        if (!validOwner) {
          let initializingPid = null;
          try { initializingPid = Number(readFileSync(join(lock, "token"), "utf8").match(/^([1-9]\d*):[0-9a-f-]{36}$/)?.[1]); } catch {}
          if (alive(initializingPid)) return null;
        }
        if (validOwner ? alive(owner) : this.now() - before.mtimeMs < LOCK_GRACE_MS) return null;
        const current = lstatSync(lock);
        if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) return null;
        rmSync(lock, { recursive: true }); create();
      } catch { return null; }
    }
    const release = () => {
      try { if (readFileSync(join(lock, "token"), "utf8") === token) rmSync(lock, { recursive: true, force: true }); } catch {}
    };
    let result;
    try { result = fn(); } catch (error) { release(); throw error; }
    if (result?.then) return Promise.resolve(result).finally(release);
    release(); return result;
  }
  async enforceStorage(reserveBytes = 0, keepReservation = () => true) {
    this.cleanupActive();
    const result = await enforceTtsQueueStorage(this.root, { maxBytes: this.maxBytes, reserveBytes, now: this.now(), alive, keepReservation });
    this.storage = { bytes: result.bytes, maxBytes: this.maxBytes, checkedAt: this.now() };
    this.lastMaintenance = this.now();
    return result;
  }
  maintainStorage() {
    if (this.maintenance) return this.maintenance;
    const work = this.withLock(() => this.enforceStorage());
    if (work === null) return Promise.resolve(null);
    this.needsMaintenance = false;
    const pending = Promise.resolve(work).catch((error) => { this.needsMaintenance = true; this.lastError = error.code || error.message; throw error; })
      .finally(() => { if (this.maintenance === pending) this.maintenance = null; });
    this.maintenance = pending;
    return pending;
  }
  enqueue(buffer, options = {}, task = null) {
    const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!pcm.length) return Promise.resolve({ empty: true, interrupted: false });
    const id = `${String(this.now()).padStart(13, "0")}-${process.pid}-${randomUUID()}`;
    const { env: _discardedEnv, ...safeOptions } = options || {};
    const job = { id, createdAt: this.now(), ownerPid: process.pid, bytes: pcm.length, durationMs: task ? null : pcmDurationMs(pcm.length, safeOptions), options: safeOptions, ...(task ? { kind: "task" } : {}) };
    const metadataBytes = Buffer.byteLength(`${JSON.stringify(job)}\n`);
    const reservedBytes = pcm.length + metadataBytes;
    if (reservedBytes > this.maxBytes || this.admissionBytes + reservedBytes > this.maxBytes) {
      return Promise.resolve({ interrupted: true, dropped: true, reason: "storage_limit" });
    }
    const pending = new Promise((resolve) => this.waiters.set(id, resolve));
    pending.jobId = id;
    if (task) { this.tasks.set(id, task); void pending.then(() => this.tasks.delete(id)); }
    this.admitting.add(id); this.admissionBytes += reservedBytes;
    this.start();
    void this.admit(job, pcm, metadataBytes).catch((error) => {
      this.lastError = error.code || error.message;
      this.waiters.get(id)?.({ interrupted: true, error: "TTS queue storage failed", code: error.code }); this.waiters.delete(id);
    }).finally(() => { this.admitting.delete(id); this.admissionBytes -= reservedBytes; this.kick(); });
    return pending;
  }
  async admit(job, pcm, metadataBytes) {
    const deadline = Date.now() + this.admissionWaitMs;
    while (this.waiters.has(job.id) && !this.stopped) {
      const work = this.withLock(async () => {
        const storage = await this.enforceStorage(pcm.length + metadataBytes, () => this.waiters.has(job.id) && !this.stopped);
        if (!this.waiters.has(job.id) || this.stopped) {
          this.waiters.get(job.id)?.({ interrupted: true, reason: "stopped" }); this.waiters.delete(job.id); return false;
        }
        if (!storage.fits) {
          this.waiters.get(job.id)?.({ interrupted: true, dropped: true, reason: "storage_limit" }); this.waiters.delete(job.id);
          return false;
        }
        const base = join(this.root, "jobs", job.id);
        try {
          await writeFile(`${base}.pcm.tmp`, pcm, { mode: 0o600, flag: "wx" });
          await rename(`${base}.pcm.tmp`, `${base}.pcm`);
          if (!this.waiters.has(job.id) || this.stopped) {
            await rm(`${base}.pcm`, { force: true });
            this.waiters.get(job.id)?.({ interrupted: true, reason: "stopped" }); this.waiters.delete(job.id); return false;
          }
          atomicJson(`${base}.json`, job);
          this.storage.bytes = storage.bytes + pcm.length + metadataBytes;
          return true;
        } catch (error) {
          await rm(`${base}.pcm`, { force: true }); throw error;
        } finally { await rm(`${base}.pcm.tmp`, { force: true }); }
      });
      if (work !== null) { await work; return; }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, this.pollMs)));
    }
    this.waiters.get(job.id)?.({ interrupted: true, error: this.stopped ? "TTS queue stopped before admission" : "TTS queue lock busy", reason: this.stopped ? "stopped" : "queue_busy" });
    this.waiters.delete(job.id);
  }
  cancel(id) {
    if (!isTtsQueueJobId(id)) return false;
    try { if (regularFile(join(this.root, "active", `${id}.json`))) atomicJson(join(this.root, "active", `${id}.cancel`), 1); } catch {}
    try { if (regularFile(join(this.root, "jobs", `${id}.json`))) atomicJson(join(this.root, "jobs", `${id}.cancel`), 1); } catch {}
    if (this.current?.id === id) this.interruptCurrent();
    if (this.waiters.has(id)) this.acknowledgedCancellations.add(id);
    this.waiters.get(id)?.({ interrupted: true }); this.waiters.delete(id);
    // Cancellation cleanup must not wait for an idle playback slot.
    this.needsMaintenance = true; this.kick();
    return true;
  }
  cleanupActive() {
    const dir = join(this.root, "active");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const id = name.replace(/\.json$/, "");
      if (!isTtsQueueJobId(id)) continue;
      const path = join(dir, name);
      if (!regularFile(path)) continue;
      const parsed = readJson(path), record = parsed?.id === id ? parsed : null;
      if (!record || !alive(record.workerPid)) {
        const pcm = path.replace(/\.json$/, ".pcm");
        const cancel = path.replace(/\.json$/, ".cancel");
        if (record && regularFile(pcm) && !existsSync(cancel)) {
          try {
            renameSync(pcm, join(this.root, "jobs", `${id}.pcm`));
            const { workerPid: _workerPid, startedAt: _startedAt, expectedEndAt: _expectedEndAt, ...job } = record;
            atomicJson(join(this.root, "jobs", `${id}.json`), job);
          } catch {
            // Do not strand accepted PCM if publishing its recovered metadata
            // fails after the move. Leave the lease retryable on the next pass.
            try { if (!existsSync(pcm)) renameSync(join(this.root, "jobs", `${id}.pcm`), pcm); } catch {}
            continue;
          }
        }
        if (existsSync(cancel)) atomicJson(join(this.root, "jobs", `${id}.cancel`), 1);
        rmSync(path, { force: true }); rmSync(pcm, { force: true }); rmSync(cancel, { force: true });
      }
    }
  }
  claim() {
    return this.withLock(() => {
      this.cleanupActive();
      const activeDir = join(this.root, "active");
      const active = readdirSync(activeDir).filter((n) => n.endsWith(".json")).map((n) => readJson(join(activeDir, n))).filter(Boolean);
      const cfg = this.config(); const now = this.now();
      const overlap = cfg.overlapMs > 0 && active.length >= cfg.maxParallel && active.some((a) => a.expectedEndAt != null && Number(a.expectedEndAt) - now <= cfg.overlapMs);
      if (active.length >= cfg.maxParallel + (overlap ? 1 : 0)) return null;
      const jobsDir = join(this.root, "jobs");
      const names = readdirSync(jobsDir).filter((n) => n.endsWith(".json")).sort();
      for (const name of names) {
        const id = name.replace(/\.json$/, "");
        if (!isTtsQueueJobId(id)) continue;
        const path = join(jobsDir, name); if (!regularFile(path)) continue;
        const job = readJson(path); if (!job || job.id !== id) { rmSync(path, { force: true }); continue; }
        const base = join(jobsDir, id);
        if (existsSync(`${base}.cancel`)) { this.removeJob(id, true); continue; }
        // Opaque playback runs only where its closure and environment live.
        if (job.kind === "task" && !this.tasks.has(id)) {
          if (!alive(job.ownerPid)) this.removeJob(id);
          continue;
        }
        const pcmPath = `${base}.pcm`; if (!regularFile(pcmPath)) continue;
        const claimedPcm = join(activeDir, `${job.id}.pcm`);
        try { renameSync(pcmPath, claimedPcm); } catch { continue; }
        const record = { ...job, workerPid: process.pid, startedAt: now, expectedEndAt: job.durationMs == null ? null : now + job.durationMs };
        atomicJson(join(activeDir, `${job.id}.json`), record);
        rmSync(path, { force: true });
        return { ...record, pcmPath: claimedPcm };
      }
      return null;
    });
  }
  removeJob(id, keepCancellation = false) {
    if (!isTtsQueueJobId(id)) return;
    for (const suffix of keepCancellation ? [".json", ".pcm"] : [".json", ".pcm", ".cancel"]) rmSync(join(this.root, "jobs", `${id}${suffix}`), { force: true });
  }
  settleRemoteWaiters() {
    for (const id of this.acknowledgedCancellations) {
      if (!this.admitting.has(id) && !existsSync(join(this.root, "jobs", `${id}.json`)) && !existsSync(join(this.root, "active", `${id}.json`))) {
        rmSync(join(this.root, "jobs", `${id}.cancel`), { force: true }); this.acknowledgedCancellations.delete(id);
      }
    }
    for (const [id, resolve] of this.waiters) {
      if (this.current?.id === id || this.admitting.has(id)) continue;
      const queued = existsSync(join(this.root, "jobs", `${id}.json`));
      const active = existsSync(join(this.root, "active", `${id}.json`));
      const cancel = join(this.root, "jobs", `${id}.cancel`);
      if (existsSync(cancel)) {
        resolve(cancellationResult(cancel)); this.waiters.delete(id);
        if (!queued && !active) rmSync(cancel, { force: true });
      } else if (!queued && !active) { resolve({ interrupted: false, completedByPeer: true }); this.waiters.delete(id); }
    }
  }
  async tick() {
    if (this.stopped) return;
    this.settleRemoteWaiters();
    if (this.current && existsSync(join(this.root, "active", `${this.current.id}.cancel`))) this.interruptCurrent();
    if (this.needsMaintenance || this.lastMaintenance === null || this.now() - this.lastMaintenance >= STORAGE_MAINTENANCE_MS) {
      await this.maintainStorage(); this.settleRemoteWaiters();
    }
    if (this.stopped) return;
    if (this.current) {
      if (existsSync(join(this.root, "active", `${this.current.id}.cancel`))) this.interruptCurrent();
      return;
    }
    const job = this.claim(); if (!job) return;
    this.current = job;
    try {
      const pcm = await readFile(job.pcmPath);
      if (job.kind === "task") this.taskAbort = new AbortController();
      const result = existsSync(join(this.root, "active", `${job.id}.cancel`))
        ? { interrupted: true }
        : job.kind === "task"
          ? await this.tasks.get(job.id)(this.taskAbort.signal)
          : await this.player.play(pcm, job.options || {});
      this.waiters.get(job.id)?.(result); this.waiters.delete(job.id);
    } catch (error) {
      this.waiters.get(job.id)?.({ interrupted: false, error: error.message }); this.waiters.delete(job.id);
    } finally {
      for (const suffix of [".json", ".pcm", ".cancel"]) rmSync(join(this.root, "active", `${job.id}${suffix}`), { force: true });
      this.taskAbort = null;
      this.current = null; queueMicrotask(() => this.kick());
    }
  }
  status() {
    this.withLock(() => this.cleanupActive());
    const jobs = readdirSync(join(this.root, "jobs")).filter((n) => n.endsWith(".json")).sort().map((n) => readJson(join(this.root, "jobs", n))).filter(Boolean);
    const active = readdirSync(join(this.root, "active")).filter((n) => n.endsWith(".json")).map((n) => readJson(join(this.root, "active", n))).filter(Boolean);
    return { config: this.config(), storage: { ...this.storage, overLimit: this.storage.bytes !== null && this.storage.bytes > this.maxBytes }, lastError: this.lastError, queued: jobs.length, active: active.length, jobs: jobs.map((j) => ({ id: j.id, createdAt: j.createdAt, durationMs: j.durationMs, streamName: j.options?.streamName })), playing: active.map((j) => ({ id: j.id, startedAt: j.startedAt, expectedEndAt: j.expectedEndAt, streamName: j.options?.streamName })) };
  }
  skipCurrent() {
    const playing = this.status().playing.sort((a, b) => a.startedAt - b.startedAt)[0];
    return playing ? this.cancel(playing.id) : false;
  }
  playNext() { this.kick(); return this.status(); }
  clearQueued() { const ids = this.status().jobs.map((j) => j.id); ids.forEach((id) => this.cancel(id)); return ids.length; }
}
