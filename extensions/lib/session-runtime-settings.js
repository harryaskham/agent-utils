// Session-durable runtime settings (bd-4dd60f).
//
// Harry's contract, unchanged: `settings.json` is IMMUTABLE startup policy. A
// runtime command (`/tts on`, `/ptt`, `/rt voice=alloy`, ...) must never write
// back to it — a fresh session always starts from config, not from whatever the
// last session happened to be doing.
//
// But "runtime-only" was implemented as "process-only", so a `/restart` or a
// crash-revive silently reverted every runtime toggle. That is the wrong
// boundary: the operator's intent when they type `/tts` is scoped to THIS
// session, and a restart does not end the session — Pi re-execs against the same
// session file.
//
// This module adds the missing middle layer, using the same mechanism `/loop`
// already uses to survive restarts: a `custom` session entry (never part of LLM
// context) holding the newest snapshot, restored by scanning the session
// backwards on `session_start`.
//
// Resulting precedence, lowest to highest:
//   1. hardcoded defaults
//   2. settings.json  (agentUtils.* slices — immutable startup policy)
//   3. environment
//   4. session-persisted runtime overrides   <- this module
//
// Layer 4 is session-scoped by construction: it lives inside the session file,
// so a NEW session cannot see it and config wins there, exactly as before.

const DEFAULT_CUSTOM_TYPE = "runtime-settings";

// Coalesce bursts of k=v assignments into one entry instead of appending one
// per key. `/rt voice=alloy speed=1.2 thresh=0.4` is a single operator action.
const DEFAULT_FLUSH_MS = 250;

function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  // Prototype check, not just `typeof`: a Map/Set/Date/class instance is also
  // `typeof "object"`, and `Object.values(new Map())` is `[]`, so a naive
  // "every value is persistable" walk would wave live runtime objects straight
  // through into the snapshot.
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Values that survive a JSON round-trip through the session file.
 *
 * Anything else (functions, symbols, class instances, circular structures) is a
 * live runtime object, not operator intent, and is dropped rather than silently
 * corrupting the snapshot.
 */
export function isPersistableValue(value) {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return t !== "number" || Number.isFinite(value);
  }
  if (Array.isArray(value)) return value.every(isPersistableValue);
  if (isPlainObject(value)) return Object.values(value).every(isPersistableValue);
  return false;
}

/**
 * Drop non-persistable entries from a namespace patch, returning the kept
 * subset plus the rejected keys so callers can warn instead of failing silently.
 */
export function filterPersistable(values = {}) {
  const kept = {};
  const rejected = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (isPersistableValue(value)) kept[key] = value;
    else rejected.push(key);
  }
  return { kept, rejected };
}

/**
 * Find the newest runtime-settings snapshot on the session's active branch.
 *
 * Scans backwards so the latest write wins, mirroring the `/loop` restore path.
 * Returns `{}` when there is no snapshot, so callers treat absence as "no
 * runtime overrides" rather than an error.
 */
export function readSnapshotFromEntries(entries, customType = DEFAULT_CUSTOM_TYPE) {
  if (!Array.isArray(entries)) return {};
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "custom" && entry.customType === customType && isPlainObject(entry.data)) {
      const namespaces = entry.data.namespaces;
      if (isPlainObject(namespaces)) return namespaces;
      return {};
    }
  }
  return {};
}

/**
 * Merge a session snapshot over a config/env-derived base.
 *
 * Only keys the operator actually set at runtime appear in the snapshot, so
 * unset keys keep falling through to the lower-precedence layers.
 */
export function applySnapshotOver(base = {}, overrides = {}) {
  return { ...base, ...overrides };
}

/**
 * Create a session-durable runtime settings store.
 *
 * The store is namespaced (`tts`, `realtime`, `stt`, ...) so unrelated
 * extensions can share one session entry without clobbering each other.
 */
export function createSessionRuntimeSettings(pi, options = {}) {
  const customType = options.customType || DEFAULT_CUSTOM_TYPE;
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const now = options.now || (() => Date.now());
  const onWarn = typeof options.onWarn === "function" ? options.onWarn : null;

  /** @type {Record<string, Record<string, unknown>>} */
  let namespaces = {};
  let restored = false;
  let flushTimer = null;
  let pendingWrite = false;
  let writes = 0;

  function persistNow() {
    pendingWrite = false;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    try {
      pi.appendEntry?.(customType, {
        namespaces: JSON.parse(JSON.stringify(namespaces)),
        savedAt: now(),
      });
      writes++;
    } catch {
      // Persistence is best-effort: losing durability must never break the
      // command the operator actually ran.
    }
  }

  function schedulePersist() {
    if (flushMs <= 0) {
      persistNow();
      return;
    }
    pendingWrite = true;
    if (flushTimer) return;
    flushTimer = setTimeout(persistNow, flushMs);
    // Never hold the process open just to write a settings snapshot.
    if (typeof flushTimer?.unref === "function") flushTimer.unref();
  }

  return {
    customType,

    /**
     * Rehydrate from the session file. Safe to call more than once; later calls
     * re-read rather than stacking, so a re-entrant `session_start` cannot
     * duplicate state.
     */
    restore(ctx) {
      let entries = [];
      try {
        entries = ctx?.sessionManager?.getEntries?.() || [];
      } catch {
        entries = [];
      }
      namespaces = readSnapshotFromEntries(entries, customType);
      restored = true;
      return namespaces;
    },

    wasRestored() {
      return restored;
    },

    /** Current runtime overrides for a namespace (never the merged view). */
    get(namespace) {
      return { ...(namespaces[namespace] || {}) };
    },

    /** All namespaces, for status output and tests. */
    all() {
      return JSON.parse(JSON.stringify(namespaces));
    },

    /**
     * Merge runtime overrides into a namespace and persist.
     *
     * Setting a key to `null` records an explicit runtime null; use `unset` to
     * drop back to the config/env layer instead.
     */
    merge(namespace, values = {}) {
      const { kept, rejected } = filterPersistable(values);
      if (rejected.length && onWarn) {
        onWarn(`runtime settings: skipped non-persistable ${namespace} key(s): ${rejected.join(", ")}`);
      }
      if (Object.keys(kept).length === 0) return this.get(namespace);
      namespaces[namespace] = { ...(namespaces[namespace] || {}), ...kept };
      schedulePersist();
      return this.get(namespace);
    },

    set(namespace, key, value) {
      return this.merge(namespace, { [key]: value });
    },

    /** Drop specific keys so they fall back to config/env on the next read. */
    unset(namespace, keys = []) {
      const list = Array.isArray(keys) ? keys : [keys];
      const ns = namespaces[namespace];
      if (!ns) return {};
      let changed = false;
      for (const key of list) {
        if (key in ns) {
          delete ns[key];
          changed = true;
        }
      }
      if (Object.keys(ns).length === 0) delete namespaces[namespace];
      if (changed) schedulePersist();
      return this.get(namespace);
    },

    /** Drop a whole namespace, or every namespace when called with no args. */
    clear(namespace) {
      if (namespace === undefined) {
        if (Object.keys(namespaces).length === 0) return;
        namespaces = {};
        schedulePersist();
        return;
      }
      if (!(namespace in namespaces)) return;
      delete namespaces[namespace];
      schedulePersist();
    },

    /** Config/env base with this session's runtime overrides layered on top. */
    resolve(namespace, base = {}) {
      return applySnapshotOver(base, namespaces[namespace] || {});
    },

    /** Force any coalesced write out immediately (shutdown, tests). */
    flush() {
      if (pendingWrite || flushTimer) persistNow();
    },

    /** Number of session entries written, for tests and diagnostics. */
    writeCount() {
      return writes;
    },
  };
}

export const RUNTIME_SETTINGS_CUSTOM_TYPE = DEFAULT_CUSTOM_TYPE;
