import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  agentBaseDir,
  agentSettingsPath,
  realtimeDevLinkDir,
  validateAgentUtilsCheckout,
  installRealtimeDevLink,
  removeRealtimeDevLink,
  realtimeDevLinkStatus,
  readDefaultModelSettings,
  restoreDefaultModelSettings,
} from "../extensions/lib/realtime-devlink.js";

// Run fn with PI_CODING_AGENT_DIR pointed at a fresh temp dir (restored after),
// plus the temp paths for assertions and cleanup.
function withAgentDir(fn) {
  const orig = process.env.PI_CODING_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "rt-agent-"));
  try {
    process.env.PI_CODING_AGENT_DIR = dir;
    return fn(dir);
  } finally {
    if (orig === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = orig;
    rmSync(dir, { recursive: true, force: true });
  }
}

// Build a minimal valid agent-utils checkout in a temp dir.
function makeCheckout({ name = "agent-utils", withExtension = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rt-checkout-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name }));
  if (withExtension) {
    mkdirSync(join(root, "extensions"), { recursive: true });
    writeFileSync(join(root, "extensions", "realtime-agent.js"), "// stub\n");
  }
  return root;
}

test("agentBaseDir honors PI_CODING_AGENT_DIR and derives child paths", () => {
  withAgentDir((dir) => {
    assert.equal(agentBaseDir(), dir);
    assert.equal(agentSettingsPath(), join(dir, "settings.json"));
    assert.equal(realtimeDevLinkDir(), join(dir, "extensions", "agent-utils-realtime-dev"));
  });
  // unset -> homedir default.
  const orig = process.env.PI_CODING_AGENT_DIR;
  try {
    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(agentBaseDir(), join(homedir(), ".pi", "agent"));
  } finally {
    if (orig !== undefined) process.env.PI_CODING_AGENT_DIR = orig;
  }
});

test("validateAgentUtilsCheckout enforces package.json, extension, and name", () => {
  const noPkg = mkdtempSync(join(tmpdir(), "rt-nopkg-"));
  const wrongName = makeCheckout({ name: "something-else" });
  const noExt = makeCheckout({ withExtension: false });
  const good = makeCheckout();
  try {
    assert.throws(() => validateAgentUtilsCheckout(noPkg), /No package\.json found/);
    assert.throws(() => validateAgentUtilsCheckout(noExt), /No realtime extension found/);
    assert.throws(() => validateAgentUtilsCheckout(wrongName), /Expected package\.json name "agent-utils"/);
    const result = validateAgentUtilsCheckout(good);
    assert.equal(result.root, resolve(good));
    assert.equal(result.realtimeExtension, join(resolve(good), "extensions", "realtime-agent.js"));
  } finally {
    for (const d of [noPkg, wrongName, noExt, good]) rmSync(d, { recursive: true, force: true });
  }
});

test("install/status/remove dev-link round-trips against a temp checkout", () => {
  withAgentDir(() => {
    const checkout = makeCheckout();
    try {
      // initially not linked.
      assert.deepEqual(realtimeDevLinkStatus().linked, false);
      assert.deepEqual(removeRealtimeDevLink().existed, false);

      const installed = installRealtimeDevLink(checkout);
      assert.equal(installed.linkDir, realtimeDevLinkDir());
      assert.ok(existsSync(join(installed.linkDir, "package.json")));
      const extLink = join(installed.linkDir, "extensions");
      assert.ok(lstatSync(extLink).isSymbolicLink());

      const status = realtimeDevLinkStatus();
      assert.equal(status.linked, true);
      assert.equal(status.target, join(resolve(checkout), "extensions"));
      assert.equal(status.extension, join(extLink, "realtime-agent.js"));

      const removed = removeRealtimeDevLink();
      assert.equal(removed.existed, true);
      assert.equal(realtimeDevLinkStatus().linked, false);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});

test("readDefaultModelSettings returns null when missing and reads provider/model", () => {
  withAgentDir((dir) => {
    assert.equal(readDefaultModelSettings(), null);
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o", other: "keep" }),
    );
    const snap = readDefaultModelSettings();
    assert.equal(snap.provider, "openai");
    assert.equal(snap.model, "gpt-4o");
    assert.equal(snap.path, join(dir, "settings.json"));
  });
});

test("restoreDefaultModelSettings merges snapshot fields and preserves other keys", () => {
  withAgentDir((dir) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ defaultProvider: "x", defaultModel: "y", other: "keep" }));
    restoreDefaultModelSettings({ path, provider: "openai-realtime", model: "gpt-realtime-2" });
    const json = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(json.defaultProvider, "openai-realtime");
    assert.equal(json.defaultModel, "gpt-realtime-2");
    assert.equal(json.other, "keep", "unrelated keys preserved");
    // no path -> no-op, no throw.
    assert.doesNotThrow(() => restoreDefaultModelSettings(undefined));
  });
});
