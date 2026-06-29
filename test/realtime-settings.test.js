import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REALTIME_VALUE_SETTINGS,
  realtimeValueParamFor,
  buildRealtimeValueParams,
  normalizeRealtimeValueParams,
} from "../extensions/lib/realtime-settings.js";

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
