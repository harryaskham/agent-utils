// File-liveness checks are async and bounded; never stat from a render method.
// Missing paths are expected after /tmp cleanup. Other I/O failures (permissions,
// EIO, ...) aren't evidence of deletion and must not silently discard an item.
import { stat } from "node:fs/promises";

export function isMissingImageError(error) {
  return ["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code);
}
export async function findMissingImages(items, { statImpl = stat, current = () => true } = {}) {
  const candidates = items.map(item => ({ item, path: item.path }));
  const missing = [];
  let next = 0;
  async function worker() {
    while (current() && next < candidates.length) {
      const candidate = candidates[next++];
      try {
        const info = await statImpl(candidate.path);
        if (!info.isFile()) missing.push(candidate);
      } catch (error) {
        if (isMissingImageError(error)) missing.push(candidate);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, candidates.length) }, worker));
  return current() ? missing : [];
}

// Commit only checks for the same object and path. A live stream can replace an
// item (even reusing its GPU id) while a filesystem check is still in flight.
export function removeMissingImages(state, missing) {
  const absent = new Map(missing.map(({ item, path }) => [item, path]));
  const old = state.items;
  const selected = old[state.index];
  const removed = old.filter(item => absent.has(item) && absent.get(item) === item.path);
  if (!removed.length) return [];
  const remove = new Set(removed);
  const before = old.slice(0, state.index).filter(item => !remove.has(item)).length;
  state.items = old.filter(item => !remove.has(item));
  const keptIndex = state.items.indexOf(selected);
  state.index = keptIndex >= 0 ? keptIndex : Math.min(before, Math.max(0, state.items.length - 1));
  // Geometry and selected payload may both change, including when only a page
  // sibling vanished. Keep valid item payloads but discard vanished memo entries.
  const liveIds = new Set(state.items.map(item => item.id));
  for (const item of removed) if (!liveIds.has(item.id)) {
    state.pagePrepared?.delete?.(item.id);
    state.transmittedSignatures?.delete?.(item.id);
  }
  if (!state.items.some(item => item.id === state.currentCommand?.itemId)) state.currentCommand = undefined;
  if (!state.items.length) { state.visible = false; state.currentCommand = undefined; state.pagePrepared = undefined; }
  return removed;
}
