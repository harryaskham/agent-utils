import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REALTIME_VALUE_SETTINGS,
  realtimeValueParamFor,
  buildRealtimeValueParams,
  normalizeRealtimeValueParams,
  PERSISTED_REALTIME_FIELDS,
  persistRealtimeSetting,
  readPersistedRealtimeSettings,
  PERSISTED_CASCADE_FIELDS,
  PERSISTED_STT_FIELDS,
  persistCascadeSetting,
  readPersistedCascadeSettings,
  persistSttSetting,
  readPersistedSttSettings,
} from "../extensions/lib/realtime-settings.js";
import { makeInitialConfig } from "../extensions/lib/realtime-config.js";

test("every alias (and the param itself) resolves to its param, with no cross-param collisions", () => {
  const seen = new Map();
  for (const s of REALTIME_VALUE_SETTINGS) {
    assert.equal(realtimeValueParamFor(s.param), s.param, `param ${s.param} self-resolves`);
    for (const k of [s.param, ...s.keys]) {
      assert.equal(realtimeValueParamFor(k), s.param, `${k} -> ${s.param}`);
      assert.ok(!seen.has(k) || seen.get(k) === s.param, `key ${k} not shared across params`);
      seen.set(k, s.param);
    }
  }
  assert.equal(realtimeValueParamFor("not-a-key"), null);
});

test("buildRealtimeValueParams round-trips every declared key to its param and omits unsupplied", () => {
  for (const s of REALTIME_VALUE_SETTINGS) {
    for (const k of [s.param, ...s.keys]) {
      const built = buildRealtimeValueParams({ [k]: "X" });
      assert.equal(built[s.param], "X", `${k} fills ${s.param}`);
      assert.equal(Object.keys(built).length, 1, `${k} fills only ${s.param}`);
    }
  }
  assert.deepEqual(buildRealtimeValueParams({}), {});
});

test("buildRealtimeValueParams prefers the param name over aliases", () => {
  const built = buildRealtimeValueParams({ model: "canon", deployment: "alias-only-if-no-model" });
  assert.equal(built.model, "canon");
  // azure_deployment is the deployment alias -> azureDeployment, distinct param
  assert.equal(built.azureDeployment, "alias-only-if-no-model");
});

test("normalize applies the declared coercer per param and skips null/undefined", () => {
  const coercers = { bool: (x) => x === "true", speed: () => 1.4, thresh: () => 0.85 };
  const out = normalizeRealtimeValueParams(
    { voice: " Sage ", model: "  M ", summary: "true", chime: "false", speed: "1.4", thresh: "0.85", azureApiVersion: null },
    coercers,
  );
  assert.equal(out.voice, "sage"); // lowerTrim
  assert.equal(out.model, "M"); // trim (case-preserving)
  assert.equal(out.summary, true); // bool
  assert.equal(out.chime, false);
  assert.equal(out.speed, 1.4);
  assert.equal(out.thresh, 0.85);
  assert.equal(out.azureApiVersion, null); // skipped
});

test("baseUrl coerce is raw (preserves case/path), directAzure is boolean", () => {
  const out = normalizeRealtimeValueParams(
    { baseUrl: "http://Helsinki:4000/V1", directAzure: "true" },
    { bool: (x) => x === "true" },
  );
  assert.equal(out.baseUrl, "http://Helsinki:4000/V1");
  assert.equal(out.directAzure, true);
});

test("every non-special setting declares setter + snapshotField; specials are handled", () => {
  for (const s of REALTIME_VALUE_SETTINGS) {
    if (s.special) continue;
    assert.ok(s.setter, `${s.param} has a setter`);
    assert.ok(s.snapshotField, `${s.param} has a snapshotField`);
  }
});

test("applyRealtimeValueParams dispatches each param to its setter; energy special; fork skipped", async () => {
  const { applyRealtimeValueParams } = await import("../extensions/lib/realtime-settings.js");
  const calls = [];
  const controls = new Proxy({}, { get: (_t, name) => (v) => calls.push([name, v]) });
  let energy = null;
  const applied = applyRealtimeValueParams(
    { model: "M", voice: "sage", directAzure: false, fork: true, energy: 0.1, summary: true },
    controls, null, { applyLocalVadEnergy: (v) => { energy = v; } },
  );
  const byName = Object.fromEntries(calls);
  assert.equal(byName.setModel, "M");
  assert.equal(byName.setVoice, "sage");
  assert.equal(byName.setDirectAzure, false); // defined-not-undefined applies
  assert.equal(byName.setSummaryContext, true);
  assert.equal(energy, 0.1); // energy special
  assert.ok(!("setFork" in byName)); // fork handled by caller, not dispatched
  assert.ok(applied.includes("model") && applied.includes("energy") && !applied.includes("fork"));
});

// --- Persistence (bd-7217db) ---

test("persistRealtimeSetting round-trips via settings.json and reads back (0 + false safe)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-settings-"));
  const path = join(dir, "settings.json");
  try {
    assert.deepEqual(readPersistedRealtimeSettings(path), {}, "missing file -> {}");
    assert.equal(persistRealtimeSetting("voice", "cedar", path), true);
    assert.equal(persistRealtimeSetting("vadThreshold", 0, path), true); // 0 is a valid threshold
    assert.equal(persistRealtimeSetting("directAzure", false, path), true);
    const got = readPersistedRealtimeSettings(path);
    assert.equal(got.voice, "cedar");
    assert.equal(got.vadThreshold, 0);
    assert.equal(got.directAzure, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistRealtimeSetting never clobbers other settings.json slices + rejects unknown fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-settings-"));
  const path = join(dir, "settings.json");
  try {
    // Pre-existing pi-graphics slice + a top-level key must survive a realtime write.
    writeFileSync(path, JSON.stringify({ agentUtils: { graphics: { eink: true } }, theme: "nord" }, null, 2));
    assert.equal(persistRealtimeSetting("model", "gpt-realtime-2", path), true);
    const all = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(all.agentUtils.graphics.eink, true, "pi-graphics slice preserved");
    assert.equal(all.theme, "nord", "top-level key preserved");
    assert.equal(all.agentUtils.realtime.model, "gpt-realtime-2");
    // Unknown field rejected (not in PERSISTED_REALTIME_FIELDS).
    assert.equal(persistRealtimeSetting("notAField", "x", path), false);
    assert.ok(!PERSISTED_REALTIME_FIELDS.includes("notAField"));
    const after = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(after.agentUtils.realtime.notAField, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeInitialConfig precedence: env > persisted > default", () => {
  const keys = [
    "PI_RT_MODEL", "OPENAI_REALTIME_MODEL", "PI_RT_SPEED", "OPENAI_REALTIME_SPEED",
    "PI_RT_VAD_THRESHOLD", "PI_RT_AZURE_PROTOCOL", "PI_RT_DIRECT_AZURE", "PI_RT_PROVIDER",
  ];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    // persisted wins over default when no env.
    const c1 = makeInitialConfig({ persisted: { speed: 1.3, azureProtocol: "beta", vadThreshold: 0.42, directAzure: false } });
    assert.equal(c1.speed, 1.3);
    assert.equal(c1.azureProtocol, "beta");
    assert.equal(c1.vadThreshold, 0.42);
    assert.equal(c1.directAzure, false, "persisted directAzure=false overrides default-true");
    // env wins over persisted.
    process.env.PI_RT_SPEED = "0.8";
    process.env.PI_RT_AZURE_PROTOCOL = "v1";
    const c2 = makeInitialConfig({ persisted: { speed: 1.3, azureProtocol: "beta" } });
    assert.equal(c2.speed, 0.8, "env speed overrides persisted");
    assert.equal(c2.azureProtocol, "v1", "env protocol overrides persisted");
    delete process.env.PI_RT_SPEED;
    delete process.env.PI_RT_AZURE_PROTOCOL;
    // empty persisted -> defaults.
    const c3 = makeInitialConfig({ persisted: {} });
    assert.equal(c3.azureProtocol, "v1");
    assert.equal(c3.vadThreshold, 0.7);
    assert.equal(c3.directAzure, true, "default direct-azure (bd-8b6f12)");
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

// --- Durability: env wins at runtime but is NEVER written to settings.json (bd-b45224) ---

test("config resolution honors env at runtime but NEVER writes env values back to settings.json (bd-b45224)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-settings-"));
  const path = join(dir, "settings.json");
  const keys = ["PI_RT_SPEED", "PI_RT_DIRECT_AZURE", "PI_RT_MODEL", "OPENAI_REALTIME_MODEL", "PI_RT_PROVIDER"];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    // Operator's hand-edited durable settings.json.
    writeFileSync(path, JSON.stringify({ agentUtils: { realtime: { voice: "marin", speed: 1, directAzure: true } } }, null, 2) + "\n");
    const before = readFileSync(path, "utf8");
    // Env provides overrides for THIS run.
    process.env.PI_RT_SPEED = "1.2";
    process.env.PI_RT_DIRECT_AZURE = "0";
    const persisted = readPersistedRealtimeSettings(path);
    const cfg = makeInitialConfig({ persisted });
    // env wins for the running config...
    assert.equal(cfg.speed, 1.2, "env speed overrides persisted at runtime");
    assert.equal(cfg.directAzure, false, "env directAzure overrides persisted at runtime");
    assert.equal(cfg.voice, "marin", "persisted voice honored where no env override");
    // ...but the settings.json file is byte-for-byte unchanged: env is runtime-only.
    assert.equal(readFileSync(path, "utf8"), before, "config resolution never writes env values into settings.json");
    // ...and the persisted slice object was not mutated.
    assert.equal(persisted.speed, 1, "persisted slice not mutated by resolution");
    assert.equal(persisted.directAzure, true);
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Durable cascade + STT slices (bd-b45224) ---

test("persistCascadeSetting / persistSttSetting round-trip their own agentUtils slice, reject unknown fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-settings-"));
  const path = join(dir, "settings.json");
  try {
    assert.deepEqual(readPersistedCascadeSettings(path), {}, "missing -> {}");
    assert.deepEqual(readPersistedSttSettings(path), {}, "missing -> {}");
    assert.equal(persistCascadeSetting("voice", "embedding:default", path), true);
    assert.equal(persistCascadeSetting("speakerProfileId", "0daec43c", path), true);
    assert.equal(persistSttSetting("transcriptionModel", "whisper-1", path), true);
    assert.equal(persistSttSetting("vadThreshold", 0, path), true); // 0 is valid
    const cascade = readPersistedCascadeSettings(path);
    const stt = readPersistedSttSettings(path);
    assert.equal(cascade.voice, "embedding:default");
    assert.equal(cascade.speakerProfileId, "0daec43c");
    assert.equal(stt.transcriptionModel, "whisper-1");
    assert.equal(stt.vadThreshold, 0);
    // Unknown fields rejected.
    assert.equal(persistCascadeSetting("notAField", "x", path), false);
    assert.equal(persistSttSetting("notAField", "x", path), false);
    assert.ok(!PERSISTED_CASCADE_FIELDS.includes("notAField"));
    assert.ok(!PERSISTED_STT_FIELDS.includes("notAField"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cascade/stt/realtime slice writes never clobber each other or other settings.json slices", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-settings-"));
  const path = join(dir, "settings.json");
  try {
    writeFileSync(path, JSON.stringify({ agentUtils: { graphics: { eink: true } }, theme: "nord" }, null, 2));
    persistRealtimeSetting("voice", "marin", path);
    persistCascadeSetting("voice", "embedding:default", path);
    persistSttSetting("transcriptionModel", "whisper-1", path);
    const all = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(all.agentUtils.graphics.eink, true, "graphics slice preserved");
    assert.equal(all.theme, "nord", "top-level preserved");
    assert.equal(all.agentUtils.realtime.voice, "marin");
    assert.equal(all.agentUtils.cascade.voice, "embedding:default");
    assert.equal(all.agentUtils.stt.transcriptionModel, "whisper-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("makeInitialConfig falls back stt fields to the agentUtils.stt slice below realtime (bd-b45224)", () => {
  const keys = ["PI_RT_TRANSCRIPTION_MODEL", "OPENAI_REALTIME_TRANSCRIPTION_MODEL", "PI_RT_VAD_THRESHOLD"];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    // stt slice fills in when realtime slice + env are absent.
    const c1 = makeInitialConfig({ persisted: {}, persistedStt: { transcriptionModel: "whisper-1", vadThreshold: 0.55 } });
    assert.equal(c1.transcriptionModel, "whisper-1", "stt slice supplies transcriptionModel");
    assert.equal(c1.vadThreshold, 0.55, "stt slice supplies vadThreshold");
    // realtime slice wins over stt slice.
    const c2 = makeInitialConfig({ persisted: { transcriptionModel: "gpt-realtime-whisper" }, persistedStt: { transcriptionModel: "whisper-1" } });
    assert.equal(c2.transcriptionModel, "gpt-realtime-whisper", "realtime slice outranks stt slice");
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
