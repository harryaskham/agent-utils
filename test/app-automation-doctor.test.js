// Direct tests for app-automation/doctor.js error/edge paths (bd-d5b05b):
// the manifest missing/invalid branches and the renderDoctorReport catalog-error
// / cliCheck / tendrilProbe branches. Regression net; no source changes.

import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import {
  readLatestMsDevRefreshSummary,
  renderDoctorReport,
} from "../extensions/app-automation/doctor.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "doctor-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("readLatestMsDevRefreshSummary reports a missing manifest", async () => {
  await withTempDir(async (root) => {
    const summary = await readLatestMsDevRefreshSummary(root);
    assert.equal(summary.status, "missing");
    assert.ok(summary.manifestPath.endsWith(path.join("bridge", "latest-ms-dev-cdp-refresh.json")));
  });
});

test("readLatestMsDevRefreshSummary reports an invalid (non-JSON) manifest", async () => {
  await withTempDir(async (root) => {
    await mkdir(path.join(root, "bridge"), { recursive: true });
    await writeFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "{not valid json", "utf8");
    const summary = await readLatestMsDevRefreshSummary(root);
    assert.equal(summary.status, "invalid");
    assert.ok(summary.error); // a compacted parse error is surfaced
  });
});

test("renderDoctorReport renders core lines and catalogErrors=0 with minimal input", () => {
  const rendered = renderDoctorReport({
    rootSummary: { root: "/state", exists: true },
    catalog: { apps: [{ id: "slack" }, { id: "outlook" }], external: {} },
    playwrightCli: "playwright-cli",
    tendrilBridge: { command: "tendril", remote: null, wslTunnel: false },
    actionDiagnostics: [],
  });
  assert.match(rendered, /playwrightCli=playwright-cli/);
  assert.match(rendered, /catalogApps=slack,outlook/);
  assert.match(rendered, /catalogErrors=0/);
  assert.match(rendered, /^actions:$/m);
});

test("renderDoctorReport surfaces catalog external errors", () => {
  const rendered = renderDoctorReport({
    rootSummary: { root: "/state", exists: true },
    catalog: {
      apps: [{ id: "slack" }],
      external: { errors: [{ source: "ext-a", error: "boom" }, { source: "ext-b", message: "bad" }] },
    },
    playwrightCli: "playwright-cli",
    tendrilBridge: { command: "tendril", remote: "host", wslTunnel: true },
    actionDiagnostics: [],
  });
  assert.match(rendered, /catalogErrors=2/);
  assert.match(rendered, /- ext-a: boom/);
  assert.match(rendered, /- ext-b: bad/);
  assert.match(rendered, /remote=host wslTunnel=true/);
});

test("renderDoctorReport renders cliCheck, tendrilProbe, and action diagnostics", () => {
  const rendered = renderDoctorReport({
    rootSummary: { root: "/state", exists: true },
    catalog: { apps: [{ id: "slack" }], external: {} },
    playwrightCli: "playwright-cli",
    tendrilBridge: { command: "tendril", remote: null, wslTunnel: false },
    tendrilProbe: { status: "ok", targets: 3 },
    cliCheck: { status: "ok", version: "1.2.3" },
    actionDiagnostics: [
      { app: "slack", action: "notifications.snapshot", executable: false, missingParams: ["session"] },
    ],
  });
  assert.match(rendered, /tendrilProbe=ok targets=3/);
  assert.match(rendered, /cliCheck=ok version=1\.2\.3/);
  assert.match(rendered, /- slack\.notifications\.snapshot: not-executable missing=session/);
});
