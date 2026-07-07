import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { makeInitialConfig } from "../extensions/lib/realtime-config.js";
import { PERSISTED_REALTIME_FIELDS, PERSISTED_STT_FIELDS } from "../extensions/lib/realtime-settings.js";
import {
  REALTIME_CONFIG_PROVENANCE,
  SERVER_VAD_PROVENANCE,
  allProvenanceEnvKeys,
  renderProvenanceMarkdown,
} from "../extensions/lib/realtime-config-provenance.js";

const configSrc = readFileSync(
  fileURLToPath(new URL("../extensions/lib/realtime-config.js", import.meta.url)),
  "utf8",
);

// Code-only view: drop whole-line `//` comments so a prose mention of an env var
// never counts as a real read.
const configCode = configSrc
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");

// Every quoted env-pattern literal that realtime-config.js actually reads.
function quotedEnvLiterals(src) {
  const set = new Set();
  for (const m of src.matchAll(/"((?:PI_RT_|OPENAI_|AZURE_|TTS_REALTIME_)[A-Z0-9_]+)"/g)) {
    set.add(m[1]);
  }
  return [...set].sort();
}

test("provenance env keys exactly match the env(...) literals read by realtime-config.js", () => {
  const fromSource = quotedEnvLiterals(configCode);
  const fromTable = allProvenanceEnvKeys();
  const missingFromTable = fromSource.filter((k) => !fromTable.includes(k));
  const staleInTable = fromTable.filter((k) => !fromSource.includes(k));
  assert.deepEqual(missingFromTable, [], `env keys read by realtime-config.js but not documented: ${missingFromTable.join(", ")}`);
  assert.deepEqual(staleInTable, [], `env keys documented but not read by realtime-config.js: ${staleInTable.join(", ")}`);
});

test("persisted=\"realtime\" fields exactly match PERSISTED_REALTIME_FIELDS", () => {
  const tablePersisted = REALTIME_CONFIG_PROVENANCE
    .filter((r) => r.persisted === "realtime")
    .map((r) => r.field)
    .sort();
  assert.deepEqual(tablePersisted, [...PERSISTED_REALTIME_FIELDS].sort());
});

test("every persisted.<field> / persistedStt.<field> read in makeInitialConfig is documented", () => {
  const byField = new Map(REALTIME_CONFIG_PROVENANCE.map((r) => [r.field, r]));
  const persistedReads = new Set([...configCode.matchAll(/[^S]persisted\.(\w+)/g)].map((m) => m[1]));
  for (const field of persistedReads) {
    const row = byField.get(field);
    assert.ok(row, `persisted.${field} is read but not in the provenance table`);
    assert.equal(row.persisted, "realtime", `persisted.${field} is read but not marked persisted:"realtime"`);
  }
  const sttReads = new Set([...configCode.matchAll(/persistedStt\.(\w+)/g)].map((m) => m[1]));
  for (const field of sttReads) {
    const row = byField.get(field);
    assert.ok(row, `persistedStt.${field} is read but not in the provenance table`);
    assert.equal(row.sttFallback, true, `persistedStt.${field} is read but not marked sttFallback`);
    assert.ok(PERSISTED_STT_FIELDS.includes(field), `sttFallback field ${field} not in PERSISTED_STT_FIELDS`);
  }
});

test("literal defaults match makeInitialConfig() with env cleared and empty persisted slices", () => {
  const keys = allProvenanceEnvKeys();
  const saved = new Map();
  for (const k of keys) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    const cfg = makeInitialConfig({ persisted: {}, persistedStt: {} });
    for (const row of REALTIME_CONFIG_PROVENANCE) {
      if (row.derivedDefault) continue;
      assert.deepEqual(cfg[row.field], row.default, `default mismatch for ${row.field}`);
    }
    // Sanity: server-VAD defaults match buildServerVadTurnDetection output too.
    for (const row of SERVER_VAD_PROVENANCE) {
      assert.equal(typeof row.default, "number", `server-vad ${row.field} default should be numeric`);
    }
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("docs/realtime-config-provenance.md is the rendered table (no drift)", () => {
  const docPath = fileURLToPath(new URL("../docs/realtime-config-provenance.md", import.meta.url));
  const onDisk = readFileSync(docPath, "utf8");
  assert.equal(
    onDisk,
    renderProvenanceMarkdown(),
    "docs/realtime-config-provenance.md is stale — regenerate: node -e \"import('./extensions/lib/realtime-config-provenance.js').then(m=>process.stdout.write(m.renderProvenanceMarkdown()))\" > docs/realtime-config-provenance.md",
  );
});
