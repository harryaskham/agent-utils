import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  APP_AUTOMATION_SPEC_VERSION,
  buildActionPlan,
  listAppConfigs,
  renderAppList,
  renderPlan,
  sanitizeId,
} from "../extensions/app-automation/catalog.js";

test("app automation catalog includes Slack, canvas, Outlook, and Teams", () => {
  const apps = listAppConfigs();
  assert.deepEqual(apps.map((app) => app.id), ["slack", "canvas", "outlook", "teams"]);
  assert.match(renderAppList(apps), /slack: Slack Web/);
  assert.match(renderAppList(apps), /canvas: Markdown canvas sync/);
});

test("Slack notification plan is deterministic, read-only, and snapshot-oriented", () => {
  const plan = buildActionPlan({ app: "slack", action: "notifications.snapshot" });
  assert.equal(plan.version, APP_AUTOMATION_SPEC_VERSION);
  assert.equal(plan.action.mode, "read");
  assert.equal(plan.action.driver, "playwright");
  assert.equal(plan.snapshotDir.endsWith("snapshots/slack"), true);
  assert.deepEqual(plan.action.missingParams, []);
  assert.deepEqual(plan.steps.map((step) => step.kind), ["browser.open", "dom.extract", "snapshot.write"]);
  assert.match(renderPlan(plan), /slack\.notifications\.snapshot/);
});

test("canvas sync plan reports required parameters before execution exists", () => {
  const plan = buildActionPlan({
    app: "canvas",
    action: "sync-markdown",
    params: { sourcePath: "notes.md" },
    env: { APP_AUTOMATION_STATE_ROOT: "~/custom-agent-utils-apps" },
  });
  assert.equal(plan.action.mode, "write");
  assert.equal(plan.action.driver, "playwright-or-tendril");
  assert.deepEqual(plan.action.missingParams, ["targetUrl", "targetSelector", "exportFormat"]);
  assert.deepEqual(plan.steps.map((step) => step.kind), [
    "file.read",
    "document.export",
    "browser.open",
    "editor.replace",
    "snapshot.write",
  ]);
});

test("extension is packaged and exposes list, plan, status tools plus /tendril-app", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../extensions/app-automation.js", import.meta.url), "utf8");

  assert.ok(packageJson.pi.extensions.includes("./extensions/app-automation.js"));
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_list`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_plan`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_status`/);
  assert.match(source, /registerCommand\("tendril-app"/);
});

test("sanitizeId normalizes user-facing app selectors", () => {
  assert.equal(sanitizeId("Slack Web!"), "slack-web");
  assert.equal(sanitizeId("  Teams/v2  "), "teams-v2");
});
