import test from "node:test";
import assert from "node:assert/strict";

import {
  createSessionRuntimeSettings,
  readSnapshotFromEntries,
  applySnapshotOver,
  isPersistableValue,
  filterPersistable,
  RUNTIME_SETTINGS_CUSTOM_TYPE,
} from "../extensions/lib/session-runtime-settings.js";

function makePi() {
  const entries = [];
  return {
    entries,
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
  };
}

function ctxWith(entries) {
  return { sessionManager: { getEntries: () => entries } };
}

test("readSnapshotFromEntries takes the newest snapshot and ignores foreign entries", () => {
  const entries = [
    { type: "custom", customType: RUNTIME_SETTINGS_CUSTOM_TYPE, data: { namespaces: { tts: { enabled: false } } } },
    { type: "custom", customType: "loop-state", data: { namespaces: { tts: { enabled: "bogus" } } } },
    { type: "message", message: { role: "user", content: "hi" } },
    { type: "custom", customType: RUNTIME_SETTINGS_CUSTOM_TYPE, data: { namespaces: { tts: { enabled: true } } } },
  ];
  assert.deepEqual(readSnapshotFromEntries(entries), { tts: { enabled: true } });
});

test("readSnapshotFromEntries returns empty for missing, malformed, or absent snapshots", () => {
  assert.deepEqual(readSnapshotFromEntries([]), {});
  assert.deepEqual(readSnapshotFromEntries(undefined), {});
  assert.deepEqual(readSnapshotFromEntries([{ type: "message" }]), {});
  assert.deepEqual(
    readSnapshotFromEntries([{ type: "custom", customType: RUNTIME_SETTINGS_CUSTOM_TYPE, data: { namespaces: "nope" } }]),
    {}
  );
});

test("applySnapshotOver layers runtime overrides above the config base", () => {
  const base = { voice: "config-voice", speed: 1, model: "config-model" };
  const merged = applySnapshotOver(base, { voice: "runtime-voice" });
  assert.deepEqual(merged, { voice: "runtime-voice", speed: 1, model: "config-model" });
});

test("isPersistableValue accepts JSON-safe values and rejects live runtime objects", () => {
  assert.equal(isPersistableValue("x"), true);
  assert.equal(isPersistableValue(1.5), true);
  assert.equal(isPersistableValue(false), true);
  assert.equal(isPersistableValue(null), true);
  assert.equal(isPersistableValue([1, "a", { b: true }]), true);
  assert.equal(isPersistableValue({ nested: { deep: [1] } }), true);

  assert.equal(isPersistableValue(() => {}), false);
  assert.equal(isPersistableValue(Symbol("s")), false);
  assert.equal(isPersistableValue(NaN), false);
  assert.equal(isPersistableValue(Infinity), false);
  assert.equal(isPersistableValue(new Map()), false);
});

test("filterPersistable keeps JSON-safe keys, drops undefined, and reports rejects", () => {
  const { kept, rejected } = filterPersistable({
    voice: "alloy",
    skipped: undefined,
    handler: () => {},
    socket: new Map(),
  });
  assert.deepEqual(kept, { voice: "alloy" });
  assert.deepEqual(rejected.sort(), ["handler", "socket"]);
});

test("set/merge persist to the session and survive a restore into a fresh store", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });

  store.set("tts", "enabled", true);
  store.merge("realtime", { voice: "alloy", speed: 1.2 });

  assert.deepEqual(store.get("tts"), { enabled: true });
  assert.deepEqual(store.get("realtime"), { voice: "alloy", speed: 1.2 });

  // Simulate a /restart: brand new process, same session file.
  const revived = createSessionRuntimeSettings(makePi(), { flushMs: 0 });
  revived.restore(ctxWith(pi.entries));

  assert.deepEqual(revived.get("tts"), { enabled: true });
  assert.deepEqual(revived.get("realtime"), { voice: "alloy", speed: 1.2 });
  assert.equal(revived.wasRestored(), true);
});

test("resolve layers the session snapshot over a config base without mutating it", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  const base = Object.freeze({ voice: "config-voice", speed: 1 });

  assert.deepEqual(store.resolve("realtime", base), { voice: "config-voice", speed: 1 });

  store.set("realtime", "voice", "runtime-voice");
  assert.deepEqual(store.resolve("realtime", base), { voice: "runtime-voice", speed: 1 });
  assert.deepEqual(base, { voice: "config-voice", speed: 1 }, "base must not be mutated");
});

test("unset drops back to the config layer; clear removes a whole namespace", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  const base = { voice: "config-voice", speed: 1 };

  store.merge("realtime", { voice: "runtime-voice", speed: 2 });
  store.unset("realtime", ["voice"]);
  assert.deepEqual(store.resolve("realtime", base), { voice: "config-voice", speed: 2 });

  store.clear("realtime");
  assert.deepEqual(store.resolve("realtime", base), base);
  assert.deepEqual(store.all(), {});
});

test("a namespace is dropped entirely once its last key is unset", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  store.set("tts", "enabled", true);
  store.unset("tts", ["enabled"]);
  assert.deepEqual(store.all(), {});
});

test("bursts of k=v assignments coalesce into a single session entry", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 50 });

  // One operator action: /rt voice=alloy speed=1.2 thresh=0.4
  store.set("realtime", "voice", "alloy");
  store.set("realtime", "speed", 1.2);
  store.set("realtime", "thresh", 0.4);

  assert.equal(pi.entries.length, 0, "writes are coalesced, not one-per-key");

  store.flush();
  assert.equal(pi.entries.length, 1, "the burst lands as exactly one entry");
  assert.deepEqual(pi.entries[0].data.namespaces.realtime, { voice: "alloy", speed: 1.2, thresh: 0.4 });
});

test("no-op operations write nothing", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });

  store.merge("tts", {});
  store.merge("tts", { ignored: undefined });
  store.unset("tts", ["never-set"]);
  store.clear("absent");
  store.clear();

  assert.equal(store.writeCount(), 0);
  assert.equal(pi.entries.length, 0);
});

test("namespaces stay isolated from each other", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  store.set("tts", "enabled", true);
  store.set("stt", "enabled", false);

  assert.deepEqual(store.get("tts"), { enabled: true });
  assert.deepEqual(store.get("stt"), { enabled: false });

  store.clear("tts");
  assert.deepEqual(store.get("stt"), { enabled: false }, "clearing one namespace leaves others intact");
});

test("get/all hand back copies, so callers cannot mutate stored state", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  store.merge("tts", { enabled: true, nested: { a: 1 } });

  const snap = store.get("tts");
  snap.enabled = false;
  assert.deepEqual(store.get("tts").enabled, true);

  const all = store.all();
  all.tts.nested.a = 99;
  assert.equal(store.all().tts.nested.a, 1);
});

test("non-persistable values are rejected and reported instead of corrupting the snapshot", () => {
  const warnings = [];
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0, onWarn: (m) => warnings.push(m) });

  store.merge("realtime", { voice: "alloy", socket: new Map() });

  assert.deepEqual(store.get("realtime"), { voice: "alloy" });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /socket/);
  assert.deepEqual(pi.entries[0].data.namespaces.realtime, { voice: "alloy" });
});

test("a failing appendEntry never breaks the command that triggered it", () => {
  const store = createSessionRuntimeSettings(
    {
      appendEntry() {
        throw new Error("session is read-only");
      },
    },
    { flushMs: 0 }
  );

  assert.doesNotThrow(() => store.set("tts", "enabled", true));
  assert.deepEqual(store.get("tts"), { enabled: true }, "in-memory state still applies");
});

test("a store with no appendEntry (ephemeral session) still works in memory", () => {
  const store = createSessionRuntimeSettings({}, { flushMs: 0 });
  assert.doesNotThrow(() => store.set("tts", "enabled", true));
  assert.deepEqual(store.get("tts"), { enabled: true });
});

test("restore is idempotent and re-reads rather than stacking state", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  store.set("tts", "enabled", true);

  const revived = createSessionRuntimeSettings(makePi(), { flushMs: 0 });
  revived.restore(ctxWith(pi.entries));
  revived.restore(ctxWith(pi.entries));
  assert.deepEqual(revived.get("tts"), { enabled: true });

  // A later snapshot replaces, never merges into, the restored state.
  pi.appendEntry(RUNTIME_SETTINGS_CUSTOM_TYPE, { namespaces: { tts: { enabled: false } } });
  revived.restore(ctxWith(pi.entries));
  assert.deepEqual(revived.get("tts"), { enabled: false });
});

test("restore tolerates a missing or throwing sessionManager", () => {
  const store = createSessionRuntimeSettings(makePi(), { flushMs: 0 });
  assert.doesNotThrow(() => store.restore(undefined));
  assert.doesNotThrow(() => store.restore({}));
  assert.doesNotThrow(() =>
    store.restore({
      sessionManager: {
        getEntries() {
          throw new Error("session unavailable");
        },
      },
    })
  );
  assert.deepEqual(store.all(), {});
});

test("a fresh session sees no overrides, so settings.json still wins there", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });
  store.set("tts", "enabled", true);

  // A NEW session has its own (empty) entry list — the snapshot is not global.
  const fresh = createSessionRuntimeSettings(makePi(), { flushMs: 0 });
  fresh.restore(ctxWith([]));

  const configBase = { enabled: false };
  assert.deepEqual(fresh.resolve("tts", configBase), { enabled: false });
});

// --- Realtime replay path (bd-4dd60f) ---
//
// `/rt k=v` restore does not re-derive settings: it feeds the remembered raw
// values back through the exact registry functions the live command uses, so
// restore cannot drift from apply.

import {
  buildRealtimeValueParams,
  normalizeRealtimeValueParams,
  applyRealtimeValueParams,
} from "../extensions/lib/realtime-settings.js";

const COERCERS = {
  bool: (x) => String(x).trim().toLowerCase() === "true",
  speed: (x) => Number(x),
  thresh: (x) => Number(x),
};

test("remembered /rt values replay through the live registry apply path", () => {
  const pi = makePi();
  const store = createSessionRuntimeSettings(pi, { flushMs: 0 });

  // What the command records after applyRealtimeValueParams reports what stuck.
  store.merge("realtime", { voice: "alloy", speed: 1.4, chime: false });

  const revived = createSessionRuntimeSettings(makePi(), { flushMs: 0 });
  const saved = revived.restore(ctxWith(pi.entries));

  const replay = normalizeRealtimeValueParams(buildRealtimeValueParams(saved.realtime), COERCERS);

  const calls = [];
  const controls = {
    setVoice: (v) => calls.push(["voice", v]),
    setSpeed: (v) => calls.push(["speed", v]),
    setChime: (v) => calls.push(["chime", v]),
  };

  const applied = applyRealtimeValueParams(replay, controls, {});
  assert.deepEqual(applied.sort(), ["chime", "speed", "voice"]);
  assert.deepEqual(
    calls.sort((a, b) => a[0].localeCompare(b[0])),
    [["chime", false], ["speed", 1.4], ["voice", "alloy"]]
  );
});

test("an empty realtime snapshot replays nothing", () => {
  const store = createSessionRuntimeSettings(makePi(), { flushMs: 0 });
  store.restore(ctxWith([]));

  const replay = normalizeRealtimeValueParams(buildRealtimeValueParams(store.get("realtime")), COERCERS);
  const calls = [];
  const applied = applyRealtimeValueParams(replay, { setVoice: (v) => calls.push(v) }, {});

  assert.deepEqual(applied, []);
  assert.deepEqual(calls, []);
});

test("realtime aliases normalize to canonical params before being remembered", () => {
  // `/rt vad_threshold=0.4` and `/rt thresh=0.4` must restore identically.
  const viaAlias = buildRealtimeValueParams({ vad_threshold: "0.4" });
  const viaParam = buildRealtimeValueParams({ thresh: "0.4" });
  assert.deepEqual(viaAlias, viaParam);
  assert.deepEqual(normalizeRealtimeValueParams(viaAlias, COERCERS), { thresh: 0.4 });
});
