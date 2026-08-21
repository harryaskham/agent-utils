import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveAgentUtilsSpecialForms,
  runBoolCommand,
  runEnvEq,
} from "../extensions/lib/settings-special-forms.js";
import { readAgentSettings } from "../extensions/pi-graphics/agent-io.js";

test("literal Agent Utils values remain their original types", () => {
  const settings = {
    agentUtils: {
      globalShellExpansion: { enabled: true },
      narrate: { enabled: true, speed: 2, prefix: "plain" },
      list: [false, 3, "x"],
    },
  };
  const resolved = resolveAgentUtilsSpecialForms(settings, { env: {} });
  assert.deepEqual(resolved, settings);
  assert.notEqual(resolved, settings, "enabled resolution returns a non-mutating clone");
});

test("special forms stay literal while global Agent Utils resolution is disabled", () => {
  const form = { $envPresent: "FLAG" };
  const settings = { agentUtils: { globalShellExpansion: { enabled: false }, narrate: { enabled: form } } };
  assert.equal(resolveAgentUtilsSpecialForms(settings, { env: { FLAG: "1" } }), settings);
  assert.deepEqual(settings.agentUtils.narrate.enabled, form);
});

test("environment boolean forms resolve recursively in objects and arrays", () => {
  const settings = {
    untouchedThirdParty: { enabled: { $envPresent: "FLAG" } },
    agentUtils: {
      globalShellExpansion: { enabled: true },
      a: { $envPresent: "PRESENT" },
      b: { $envAbsent: "MISSING" },
      nested: [{ $envBool: "ON" }, { $envBool: "OFF" }, { $envBool: "EMPTY", default: true }],
    },
  };
  const resolved = resolveAgentUtilsSpecialForms(settings, { env: { PRESENT: "", ON: "yes", OFF: "0", EMPTY: "" } });
  assert.equal(resolved.agentUtils.a, true, "presence includes an explicitly empty environment value");
  assert.equal(resolved.agentUtils.b, true);
  assert.deepEqual(resolved.agentUtils.nested, [true, false, true]);
  assert.deepEqual(resolved.untouchedThirdParty, settings.untouchedThirdParty, "nothing outside agentUtils is evaluated");
});

test("$envEq supports environment expansion and explicit command substitution", () => {
  const env = { ...process.env, XYZ: "some-val", NUMBER: "123" };
  assert.deepEqual(runEnvEq(["${XYZ}", "some-val"], { env }), { value: true, ok: true, code: "exit-status" });
  assert.deepEqual(runEnvEq(["${NUMBER}", "$(echo 123)"], { env }), { value: true, ok: true, code: "exit-status" });
  assert.equal(runEnvEq(["x", "$(echo y)"], { env }).value, false);
  const resolved = resolveAgentUtilsSpecialForms({
    agentUtils: { globalShellExpansion: { enabled: true }, narrate: { enabled: { $envEq: ["${NUMBER}", "$(printf 123)"] } } },
  }, { env });
  assert.equal(resolved.agentUtils.narrate.enabled, true);
});

test("$boolCommand recognizes stdout booleans then falls back to exit status", () => {
  const fake = (stdout, status = 0) => () => ({ stdout, status });
  assert.equal(runBoolCommand("ignored", { spawnSyncImpl: fake("true\n", 7) }).value, true);
  assert.equal(runBoolCommand("ignored", { spawnSyncImpl: fake("0\n", 0) }).value, false);
  assert.equal(runBoolCommand("ignored", { spawnSyncImpl: fake("other", 0) }).value, true);
  assert.equal(runBoolCommand("ignored", { spawnSyncImpl: fake("other", 2) }).value, false);
});

test("malformed, failed, and timed-out special forms fail closed with path diagnostics", () => {
  const diagnostics = [];
  const settings = {
    agentUtils: {
      globalShellExpansion: { enabled: true },
      mixed: { $envPresent: "A", other: true },
      unknown: { $wat: "A" },
      badDefault: { $envBool: "MISSING", default: "yes" },
      timeout: { $boolCommand: "sleep forever" },
    },
  };
  const resolved = resolveAgentUtilsSpecialForms(settings, {
    env: {},
    spawnSyncImpl: () => ({ error: { code: "ETIMEDOUT" } }),
    onDiagnostic: (detail) => diagnostics.push(detail),
  });
  assert.equal(resolved.agentUtils.mixed, false);
  assert.equal(resolved.agentUtils.unknown, false);
  assert.equal(resolved.agentUtils.badDefault, false);
  assert.equal(resolved.agentUtils.timeout, false);
  assert.ok(diagnostics.some((entry) => entry.path === "agentUtils.timeout" && entry.code === "timeout"));
});

test("readAgentSettings resolves only the owned subtree without rewriting the file", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-utils-special-settings-"));
  const path = join(dir, "settings.json");
  const source = JSON.stringify({
    core: { enabled: { $envPresent: "FLAG" } },
    agentUtils: {
      globalShellExpansion: { enabled: true },
      narrate: { enabled: { $envPresent: "FLAG" } },
    },
  }, null, 2) + "\n";
  writeFileSync(path, source);
  try {
    const resolved = readAgentSettings(path, { env: { FLAG: "1" }, silent: true });
    assert.equal(resolved.agentUtils.narrate.enabled, true);
    assert.deepEqual(resolved.core.enabled, { $envPresent: "FLAG" });
    assert.equal(readFileSync(path, "utf8"), source);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
