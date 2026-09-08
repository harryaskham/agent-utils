import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const TTS_QUEUE_SYMBOL = Symbol.for("agent-utils.tts-queue.v1");
export const DEFAULT_TTS_QUEUE_CONFIG = Object.freeze({ maxParallel: 1, overlapMs: 0 });

export function ttsQueueRoot(env = process.env) {
  return env.PI_TTS_QUEUE_DIR || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agent-utils", "tts-queue");
}

function atomicJson(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}
function readJson(path, fallback = null) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }
function alive(pid) { try { process.kill(Number(pid), 0); return true; } catch { return false; } }

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
  constructor({ root = ttsQueueRoot(), player, pollMs = 200, now = Date.now } = {}) {
    if (!player) throw new Error("MachineTtsQueue requires a raw player");
    this.root = root; this.player = player; this.pollMs = pollMs; this.now = now;
    this.current = null; this.timer = null; this.waiters = new Map();
    mkdirSync(join(root, "jobs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "active"), { recursive: true, mode: 0o700 });
  }
  config() { return normalizeQueueConfig(readJson(join(this.root, "config.json"), DEFAULT_TTS_QUEUE_CONFIG)); }
  configure(patch) { const next = normalizeQueueConfig({ ...this.config(), ...patch }); atomicJson(join(this.root, "config.json"), next); this.tick(); return next; }
  start() { if (this.timer) return; this.timer = setInterval(() => this.tick(), this.pollMs); this.timer.unref?.(); this.tick(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  withLock(fn) {
    const lock = join(this.root, "lock");
    const acquire = () => {
      try { mkdirSync(lock); writeFileSync(join(lock, "owner"), String(process.pid)); return true; }
      catch {
        try {
          const owner = Number(readFileSync(join(lock, "owner"), "utf8"));
          const stale = !alive(owner) || this.now() - statSync(lock).mtimeMs > 5000;
          if (stale) { rmSync(lock, { recursive: true, force: true }); mkdirSync(lock); writeFileSync(join(lock, "owner"), String(process.pid)); return true; }
        } catch {}
        return false;
      }
    };
    if (!acquire()) return null;
    try { return fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
  }
  enqueue(buffer, options = {}) {
    const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
    if (!pcm.length) return Promise.resolve({ empty: true, interrupted: false });
    const id = `${String(this.now()).padStart(13, "0")}-${process.pid}-${randomUUID()}`;
    const base = join(this.root, "jobs", id);
    writeFileSync(`${base}.pcm.tmp`, pcm, { mode: 0o600 });
    renameSync(`${base}.pcm.tmp`, `${base}.pcm`);
    const { env: _discardedEnv, ...safeOptions } = options || {};
    atomicJson(`${base}.json`, { id, createdAt: this.now(), ownerPid: process.pid, bytes: pcm.length, durationMs: pcmDurationMs(pcm.length, safeOptions), options: safeOptions });
    this.start(); this.tick();
    const pending = new Promise((resolve) => this.waiters.set(id, resolve));
    pending.jobId = id;
    return pending;
  }
  cancel(id) {
    if (!id) return false;
    try { if (existsSync(join(this.root, "active", `${id}.json`))) writeFileSync(join(this.root, "active", `${id}.cancel`), "1", { mode: 0o600 }); } catch {}
    try { if (existsSync(join(this.root, "jobs", `${id}.json`))) writeFileSync(join(this.root, "jobs", `${id}.cancel`), "1", { mode: 0o600 }); } catch {}
    if (this.current?.id === id) this.player.interrupt();
    this.waiters.get(id)?.({ interrupted: true }); this.waiters.delete(id);
    return true;
  }
  cleanupActive() {
    const dir = join(this.root, "active");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      const path = join(dir, name); const record = readJson(path);
      if (!record || !alive(record.workerPid)) {
        const id = record?.id || name.replace(/\.json$/, "");
        const pcm = path.replace(/\.json$/, ".pcm");
        const cancel = path.replace(/\.json$/, ".cancel");
        if (record && existsSync(pcm) && !existsSync(cancel)) {
          try {
            renameSync(pcm, join(this.root, "jobs", `${id}.pcm`));
            const { workerPid: _workerPid, startedAt: _startedAt, expectedEndAt: _expectedEndAt, ...job } = record;
            atomicJson(join(this.root, "jobs", `${id}.json`), job);
          } catch {}
        }
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
      const overlap = cfg.overlapMs > 0 && active.length >= cfg.maxParallel && active.some((a) => Number(a.expectedEndAt) - now <= cfg.overlapMs);
      if (active.length >= cfg.maxParallel + (overlap ? 1 : 0)) return null;
      const jobsDir = join(this.root, "jobs");
      const names = readdirSync(jobsDir).filter((n) => n.endsWith(".json")).sort();
      for (const name of names) {
        const path = join(jobsDir, name); const job = readJson(path); if (!job) { rmSync(path, { force: true }); continue; }
        const base = join(jobsDir, job.id);
        if (existsSync(`${base}.cancel`)) { this.removeJob(job.id); continue; }
        const pcmPath = `${base}.pcm`; if (!existsSync(pcmPath)) continue;
        const claimedPcm = join(activeDir, `${job.id}.pcm`);
        try { renameSync(pcmPath, claimedPcm); } catch { continue; }
        const record = { ...job, workerPid: process.pid, startedAt: now, expectedEndAt: now + job.durationMs };
        atomicJson(join(activeDir, `${job.id}.json`), record);
        rmSync(path, { force: true });
        return { ...record, pcmPath: claimedPcm };
      }
      return null;
    });
  }
  removeJob(id) {
    for (const suffix of [".json", ".pcm", ".cancel"]) rmSync(join(this.root, "jobs", `${id}${suffix}`), { force: true });
  }
  settleRemoteWaiters() {
    for (const [id, resolve] of this.waiters) {
      if (this.current?.id === id) continue;
      const queued = existsSync(join(this.root, "jobs", `${id}.json`));
      const active = existsSync(join(this.root, "active", `${id}.json`));
      if (!queued && !active) { resolve({ interrupted: false, completedByPeer: true }); this.waiters.delete(id); }
    }
  }
  async tick() {
    this.settleRemoteWaiters();
    if (this.current) {
      if (existsSync(join(this.root, "active", `${this.current.id}.cancel`))) this.player.interrupt();
      return;
    }
    const job = this.claim(); if (!job) return;
    this.current = job;
    try {
      const result = await this.player.play(readFileSync(job.pcmPath), job.options || {});
      this.waiters.get(job.id)?.(result); this.waiters.delete(job.id);
    } catch (error) {
      this.waiters.get(job.id)?.({ interrupted: false, error: error.message }); this.waiters.delete(job.id);
    } finally {
      for (const suffix of [".json", ".pcm", ".cancel"]) rmSync(join(this.root, "active", `${job.id}${suffix}`), { force: true });
      this.current = null; queueMicrotask(() => this.tick());
    }
  }
  status() {
    this.cleanupActive();
    const jobs = readdirSync(join(this.root, "jobs")).filter((n) => n.endsWith(".json")).sort().map((n) => readJson(join(this.root, "jobs", n))).filter(Boolean);
    const active = readdirSync(join(this.root, "active")).filter((n) => n.endsWith(".json")).map((n) => readJson(join(this.root, "active", n))).filter(Boolean);
    return { config: this.config(), queued: jobs.length, active: active.length, jobs: jobs.map((j) => ({ id: j.id, createdAt: j.createdAt, durationMs: j.durationMs, streamName: j.options?.streamName })), playing: active.map((j) => ({ id: j.id, startedAt: j.startedAt, expectedEndAt: j.expectedEndAt, streamName: j.options?.streamName })) };
  }
  skipCurrent() {
    const playing = this.status().playing.sort((a, b) => a.startedAt - b.startedAt)[0];
    return playing ? this.cancel(playing.id) : false;
  }
  playNext() { this.tick(); return this.status(); }
  clearQueued() { const ids = this.status().jobs.map((j) => j.id); ids.forEach((id) => { this.cancel(id); this.removeJob(id); }); return ids.length; }
}
