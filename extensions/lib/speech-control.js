// Machine-local runtime policy shared with `ag tts mute/unmute`. Filesystem
// events are watched only while speech is in flight. An active-only metadata
// reconciliation covers dropped fs.watch notifications; no idle polling/writes.
import { constants, watch } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { agentUtilsStateRoot, expandStatePath } from "./artifact-state.js";

export const SPEECH_KINDS = Object.freeze(["read", "tts", "narrate", "choices"]);
export const SPEECH_STREAM_NAMES = Object.freeze(Object.fromEntries(SPEECH_KINDS.map((kind) => [kind, `/${kind}`])));
const MAX_STATE_BYTES = 16 * 1024;
const observers = new Map();
const RECONCILE_MS = 200;

export function speechKind(options = {}) {
  const value = options.speechKind ?? options.speechControl?.kind ?? String(options.streamName || "").replace(/^\//, "");
  const kind = value === "choice" ? "choices" : value;
  return SPEECH_KINDS.includes(kind) ? kind : null;
}
export function speechMutePath(env = process.env) {
  return expandStatePath(env.PI_TTS_MUTE_PATH || join(agentUtilsStateRoot(env), "tts", "mute.json"), env);
}
export function normalizeSpeechMuteState(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || Object.keys(value).some((key) => !["version", "muted", "epochs", "updated_at_ms"].includes(key))) throw new Error("Invalid speech mute state (expected version 1)");
  const state = { version: 1, muted: {}, epochs: {}, updated_at_ms: Object.hasOwn(value, "updated_at_ms") ? value.updated_at_ms : 0 };
  if (!Number.isSafeInteger(state.updated_at_ms) || state.updated_at_ms < 0) throw new Error("Invalid speech mute state timestamp");
  for (const field of ["muted", "epochs"]) {
    const map = Object.hasOwn(value, field) ? value[field] : {};
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.keys(map).some((key) => !SPEECH_KINDS.includes(key))) throw new Error(`Invalid speech mute ${field}`);
    for (const kind of SPEECH_KINDS) {
      const item = Object.hasOwn(map, kind) ? map[kind] : (field === "muted" ? false : 0);
      if (field === "muted" ? typeof item !== "boolean" : !Number.isSafeInteger(item) || item < 0) throw new Error(`Invalid speech mute ${field}`);
      state[field][kind] = item;
    }
  }
  return state;
}
export async function readSpeechMuteState(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (error.code === "ENOENT") return normalizeSpeechMuteState({ version: 1 }); throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error("Speech mute state must be a regular file ≤16 KiB");
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_STATE_BYTES) throw new Error("Speech mute state exceeds 16 KiB");
    let value;
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")); }
    catch { throw new Error(`Invalid speech mute JSON at ${path}; inspect/repair it before speaking`); }
    return normalizeSpeechMuteState(value);
  } finally { await file.close(); }
}

async function watchLocations(path) {
  const files = [path];
  let target = path;
  for (let hop = 0; hop < 32; hop++) {
    const info = await lstat(target).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (!info?.isSymbolicLink()) break;
    const link = await readlink(target);
    target = resolve(dirname(target), link);
    files.push(target);
    if (hop === 31) throw new Error("Speech mute state symlink cycle/depth exceeds 32");
  }
  const locations = new Map();
  for (const file of files) {
    let child = file, parent = dirname(file);
    for (;;) {
      const info = await stat(parent).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (info?.isDirectory()) {
        const directory = await realpath(parent);
        locations.set(`${directory}\0${basename(child)}`, { directory, name: basename(child) });
        break;
      }
      if (parent === dirname(parent)) throw new Error("No watchable parent for speech mute state");
      child = parent; parent = dirname(parent);
    }
  }
  return locations;
}

function subscribe(path, changed, failed) {
  let entry = observers.get(path);
  if (!entry) {
    entry = { path, listeners: new Set(), watches: new Map(), closed: false, binding: null, dirty: false, reconciling: false, signature: null, timer: null };
    entry.rebind = () => {
      if (entry.closed) return Promise.resolve();
      entry.dirty = true;
      if (entry.binding) return entry.binding;
      entry.binding = (async () => {
        while (entry.dirty && !entry.closed) {
          entry.dirty = false;
          const locations = await watchLocations(path);
          if (entry.closed) return;
          for (const [key, location] of locations) {
            if (entry.watches.has(key)) continue;
            const watcher = watch(location.directory, { persistent: false }, (event, name) => {
              // Atomic publishers can be reported under a temporary filename by
              // coalescing filesystems. Reconcile directory renames as well.
              if (event !== "rename" && name != null && String(name) !== location.name) return;
              for (const listener of [...entry.listeners]) listener.changed();
              void entry.rebind().catch((error) => { for (const listener of [...entry.listeners]) listener.failed(error); });
            });
            watcher.on("error", (error) => { for (const listener of [...entry.listeners]) listener.failed(error); });
            entry.watches.set(key, watcher);
          }
          for (const [key, watcher] of entry.watches) if (!locations.has(key)) { watcher.close(); entry.watches.delete(key); }
          // Directory creation/atomic publication may have raced rebinding.
          for (const listener of [...entry.listeners]) listener.changed();
        }
      })().finally(() => {
        entry.binding = null;
        // An event can arrive after the async loop exits but before finally
        // runs. Do not lose that wake-up (especially ancestor→leaf rebinding).
        if (entry.dirty && !entry.closed) void entry.rebind().catch((error) => { for (const listener of [...entry.listeners]) listener.failed(error); });
      });
      return entry.binding;
    };
    // macOS fs.watch can silently miss a cold-start/atomic-rename event. One
    // stat per active policy path (shared across kinds) bounds detection latency
    // without repeatedly opening unchanged policy content or touching queue locks.
    entry.timer = setInterval(async () => {
      if (entry.closed || entry.reconciling) return;
      entry.reconciling = true;
      try {
        const info = await stat(path, { bigint: true }).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (entry.closed) return;
        const signature = info ? `${info.dev}:${info.ino}:${info.mtimeNs ?? info.mtimeMs}:${info.ctimeNs ?? info.ctimeMs}:${info.size}:${info.mode}` : "missing";
        if (signature !== entry.signature) {
          entry.signature = signature;
          for (const listener of [...entry.listeners]) listener.changed();
          await entry.rebind();
        }
      } catch (error) { for (const listener of [...entry.listeners]) listener.failed(error); }
      finally { entry.reconciling = false; }
    }, RECONCILE_MS);
    entry.timer.unref?.();
    observers.set(path, entry);
  }
  const listener = { changed, failed };
  entry.listeners.add(listener);
  const ready = entry.rebind();
  let released = false;
  return {
    ready,
    release() {
      if (released) return;
      released = true;
      entry.listeners.delete(listener);
      if (entry.listeners.size) return;
      entry.closed = true;
      clearInterval(entry.timer);
      entry.timer = null;
      for (const watcher of entry.watches.values()) watcher.close();
      entry.watches.clear();
      if (observers.get(path) === entry) observers.delete(path);
    },
  };
}

// Diagnostic/test surface contains counts, never policy content or private paths.
export function speechControlObserverCounts() {
  return { files: observers.size, watchers: [...observers.values()].reduce((n, e) => n + e.watches.size, 0), listeners: [...observers.values()].reduce((n, e) => n + e.listeners.size, 0) };
}

export async function withSpeechControl(options, run) {
  const kind = speechKind(options);
  if (!kind) {
    if (options.speechControl) throw new Error("Invalid speech control token kind");
    return run(options);
  }
  const parent = options.signal;
  if (parent?.aborted) return { interrupted: true };
  const path = options.speechControl?.path || speechMutePath(options.env);
  const previous = options.speechControl;
  if (previous && (previous.kind !== kind || !Number.isSafeInteger(previous.epoch) || previous.epoch < 0 || typeof previous.path !== "string" || !previous.path)) throw new Error("Invalid speech control token");
  const controller = new AbortController();
  let epoch, muted = false, failure = null, armed = false, dirty = false, checking = null, lease;
  const abort = () => { controller.abort(); lease?.release(); };
  const fail = (error) => { failure = error; abort(); };
  const inspect = (state) => {
    if (state.muted[kind] || state.epochs[kind] !== epoch) { muted = true; abort(); }
  };
  const check = () => {
    dirty = true;
    if (!armed || controller.signal.aborted) return Promise.resolve();
    if (checking) return checking;
    checking = (async () => {
      while (dirty && armed && !controller.signal.aborted) {
        dirty = false;
        const state = await readSpeechMuteState(path);
        if (armed) inspect(state);
      }
    })().catch(fail).finally(() => {
      checking = null;
      if (dirty && armed && !controller.signal.aborted) void check();
    });
    return checking;
  };
  parent?.addEventListener("abort", abort, { once: true });
  try {
    lease = subscribe(path, () => { void check(); }, fail);
    if (parent?.aborted) abort();
    await lease.ready;
    if (!controller.signal.aborted) {
      const state = await readSpeechMuteState(path);
      epoch = previous?.epoch ?? state.epochs[kind];
      armed = true;
      inspect(state);
      if (dirty) await check();
    }
    if (failure) throw failure;
    if (controller.signal.aborted) return muted ? { interrupted: true, muted: true, reason: "muted" } : { interrupted: true };
    const effective = { ...options, speechKind: kind, speechControl: { kind, epoch, path }, signal: controller.signal };
    try {
      const result = await run(effective);
      // Also reconcile an epoch change if a peer finished/discarded queued work
      // before this process received its filesystem notification.
      if (!controller.signal.aborted) inspect(await readSpeechMuteState(path));
      if (failure) throw failure;
      return muted ? { interrupted: true, muted: true, reason: "muted" } : result;
    } catch (error) {
      if (failure) throw failure;
      if (muted) return { interrupted: true, muted: true, reason: "muted" };
      if (parent?.aborted) return { interrupted: true };
      throw error;
    }
  } finally {
    armed = false;
    dirty = false;
    parent?.removeEventListener("abort", abort);
    lease?.release();
    if (checking) await checking;
  }
}
