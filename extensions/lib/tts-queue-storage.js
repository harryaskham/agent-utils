import { lstat, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_TTS_QUEUE_BYTES = 1024 ** 3;
export const STALE_QUEUE_FILE_MS = 60_000;
export const CANCEL_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_ID = /^\d{13,}-([1-9]\d*)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTtsQueueJobId(id) { return typeof id === "string" && JOB_ID.test(id); }

function spoolName(name) {
  const dot = name.indexOf(".");
  if (dot < 0) return null;
  const id = name.slice(0, dot), suffix = name.slice(dot);
  if (!isTtsQueueJobId(id)) return null;
  if ([".pcm", ".json", ".cancel"].includes(suffix)) return { id, suffix };
  if (suffix === ".pcm.tmp" || /^\.(json|cancel)\.\d+\.[0-9a-f-]+\.tmp$/.test(suffix)) return { id, suffix: ".tmp" };
  return null;
}

/** Must run under the machine queue lock. All bulk filesystem work yields. */
export async function enforceTtsQueueStorage(root, { maxBytes = MAX_TTS_QUEUE_BYTES, reserveBytes = 0, now = Date.now(), alive = () => true, keepReservation = () => true } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_TTS_QUEUE_BYTES || !Number.isSafeInteger(reserveBytes) || reserveBytes < 0) throw new Error("Invalid TTS spool byte budget");
  const files = new Map(), queued = new Map(), activeIds = new Set(), activeMetadata = new Set();
  let bytes = 0, removedFiles = 0;
  for (const directory of ["jobs", "active"]) {
    const entries = await readdir(join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      // Never follow a cache-entry symlink or recursively remove foreign data.
      if (!entry.isFile()) continue;
      const path = join(root, directory, entry.name);
      let stat;
      try { stat = await lstat(path); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (!stat.isFile()) continue;
      const record = { path, bytes: stat.size, mtimeMs: stat.mtimeMs, directory, ...spoolName(entry.name) };
      files.set(path, record); bytes += stat.size;
      if (!record.id) continue;
      if (directory === "active") {
        activeIds.add(record.id);
        if (record.suffix === ".json") activeMetadata.add(record.id);
      }
      else {
        if (!queued.has(record.id)) queued.set(record.id, new Map());
        queued.get(record.id).set(record.suffix, record);
      }
    }
  }
  const remove = async (record) => {
    if (!record || !files.has(record.path)) return;
    await rm(record.path, { force: true });
    bytes -= record.bytes; files.delete(record.path); removedFiles++;
  };

  for (const record of [...files.values()]) {
    if (record.directory !== "active" || record.suffix !== ".cancel" || activeMetadata.has(record.id)) continue;
    // A cancellation without an active lease must follow an interrupted claim
    // back to the waiting side, not allow its audio to be replayed.
    const path = join(root, "jobs", `${record.id}.cancel`);
    const replacedBytes = files.get(path)?.bytes || 0;
    await rename(record.path, path); files.delete(record.path); bytes -= replacedBytes;
    const restored = { ...record, path, directory: "jobs" };
    files.set(path, restored);
    if (!queued.has(record.id)) queued.set(record.id, new Map());
    queued.get(record.id).set(".cancel", restored); activeIds.delete(record.id);
  }
  for (const record of [...files.values()]) {
    if (record.suffix === ".tmp" && now - record.mtimeMs >= STALE_QUEUE_FILE_MS) await remove(record);
    if (record.directory === "active" && record.suffix === ".pcm" && !activeMetadata.has(record.id)) {
      const group = queued.get(record.id);
      if (group?.has(".json") && !group.has(".cancel")) {
        // Recover a crash between moving the PCM and publishing its active lease.
        if (!group.has(".pcm")) {
          const path = join(root, "jobs", `${record.id}.pcm`);
          await rename(record.path, path); files.delete(record.path);
          const restored = { ...record, path, directory: "jobs" };
          files.set(path, restored); group.set(".pcm", restored);
        } else await remove(record);
        activeIds.delete(record.id);
      } else if (group?.has(".cancel") || now - record.mtimeMs >= STALE_QUEUE_FILE_MS) {
        await remove(record); activeIds.delete(record.id);
      }
    }
  }
  for (const [id, group] of queued) {
    if (activeIds.has(id)) continue;
    const pcm = group.get(".pcm"), metadata = group.get(".json"), cancel = group.get(".cancel");
    if (cancel) {
      await remove(pcm); await remove(metadata);
      // Leave a short-lived cancellation receipt for a live originating peer.
      // It must never mistake a vanished, evicted job for completed playback.
      const ownerPid = Number(id.match(JOB_ID)[1]);
      if (!alive(ownerPid) || now - cancel.mtimeMs >= CANCEL_RECEIPT_TTL_MS) await remove(cancel);
    } else if (!metadata && pcm && now - pcm.mtimeMs >= STALE_QUEUE_FILE_MS) {
      await remove(pcm);
    } else if (!pcm && metadata && now - metadata.mtimeMs >= STALE_QUEUE_FILE_MS) {
      await remove(metadata);
    }
  }

  const evicted = [];
  const candidates = [...queued.keys()].sort().filter((id) => {
    const group = queued.get(id);
    return !activeIds.has(id) && files.has(group.get(".pcm")?.path) && files.has(group.get(".json")?.path);
  });
  const protectedBytes = bytes - candidates.reduce((sum, id) => {
    const group = queued.get(id);
    return sum + group.get(".pcm").bytes + group.get(".json").bytes;
  }, 0);
  // If the new request cannot fit beside active/protected bytes, reject it
  // without evicting healthy waiting jobs merely to attempt that admission.
  if (!keepReservation()) reserveBytes = 0;
  let target = protectedBytes + reserveBytes > maxBytes ? maxBytes : maxBytes - reserveBytes;
  // Creation-ordered queue IDs give deterministic oldest-waiting-first eviction.
  // Active leases and unknown files are protected, even for an oversized legacy spool.
  for (const id of candidates) {
    if (!keepReservation()) { reserveBytes = 0; target = maxBytes; }
    if (bytes <= target) break;
    if (activeIds.has(id)) continue;
    const group = queued.get(id), pcm = group.get(".pcm"), metadata = group.get(".json");
    if (!pcm || !metadata || !files.has(pcm.path) || !files.has(metadata.path)) continue;
    const path = join(root, "jobs", `${id}.cancel`);
    const reason = "storage_limit";
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, reason, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    bytes += Buffer.byteLength(reason) - (files.get(path)?.bytes || 0);
    files.set(path, { path, bytes: Buffer.byteLength(reason), mtimeMs: now, directory: "jobs", id, suffix: ".cancel" });
    await remove(pcm); await remove(metadata); evicted.push(id);
    if (!alive(Number(id.match(JOB_ID)[1]))) await remove(files.get(path));
  }
  return { bytes: Math.max(0, bytes), maxBytes, reserveBytes, protectedBytes, fits: bytes + reserveBytes <= maxBytes, removedFiles, evicted };
}
