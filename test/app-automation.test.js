import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_AUTOMATION_SPEC_VERSION,
  buildActionPlan,
  buildExecutionPlan,
  buildStepCommand,
  listAppConfigs,
  loadCatalog,
  normalizeAppConfig,
  renderAppList,
  renderPlan,
  sanitizeId,
} from "../extensions/app-automation/catalog.js";
import {
  digestSnapshotArtifacts,
  listSnapshotArtifacts,
  readSnapshotArtifact,
  renderArtifactList,
  renderSnapshotDigest,
} from "../extensions/app-automation/artifacts.js";
import { buildCanvasPastePlan, syncMarkdownCanvas } from "../extensions/app-automation/canvas.js";
import { buildEditorReplaceScript } from "../extensions/app-automation/editor.js";
import { buildGenericSnapshot, renderGenericMarkdown } from "../extensions/app-automation/generic-snapshot.js";
import { microsoftExtractorScript } from "../extensions/app-automation/microsoft.js";
import {
  authMissingHint,
  buildBrowserOpenCommand,
  buildDomExtractCommand,
  playwrightSessionArgs,
} from "../extensions/app-automation/playwright-bridge.js";
import {
  buildSlackNotificationSnapshot,
  renderSlackNotificationMarkdown,
  slackExtractorScript,
} from "../extensions/app-automation/slack.js";

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
  assert.deepEqual(plan.steps.map((step) => step.kind), ["browser.open", "dom.extract", "slack.notifications.snapshot"]);
  assert.equal(plan.execution.executable, true);
  assert.match(renderPlan(plan), /slack\.notifications\.snapshot/);
});

test("canvas sync plan requires sourcePath and is internally executable", () => {
  const missing = buildActionPlan({ app: "canvas", action: "sync-markdown" });
  assert.deepEqual(missing.action.missingParams, ["sourcePath"]);

  const plan = buildActionPlan({
    app: "canvas",
    action: "sync-markdown",
    params: { sourcePath: "notes.md" },
    env: { APP_AUTOMATION_STATE_ROOT: "~/custom-agent-utils-apps" },
  });
  assert.equal(plan.action.mode, "write");
  assert.equal(plan.action.driver, "playwright-or-tendril");
  assert.deepEqual(plan.action.missingParams, []);
  assert.deepEqual(plan.steps.map((step) => step.kind), ["canvas.sync-markdown", "browser.open", "editor.replace"]);
  assert.equal(plan.execution.executable, true);
  assert.equal(plan.execution.stepCommands[1].internal, "optional.skip");
});

test("external JSON app configs load and override built-ins by id", async () => {
  const dir = await mkdir(path.join(os.tmpdir(), `app-automation-${Date.now()}`), { recursive: true });
  await writeFile(path.join(dir, "slack.json"), JSON.stringify({
    id: "slack",
    label: "Custom Slack",
    url: "https://example.invalid/slack",
    actions: [{ id: "ping", mode: "read", driver: "playwright", plan: [{ kind: "cli.exec", command: "playwright-cli", args: ["--version"] }] }],
  }), "utf8");

  const catalog = await loadCatalog({ env: { APP_AUTOMATION_CONFIG_DIR: dir } });
  const slack = catalog.apps.find((app) => app.id === "slack");
  assert.equal(slack.label, "Custom Slack");
  assert.equal(slack.source.endsWith("slack.json"), true);
  assert.equal(catalog.external.errors.length, 0);
});

test("normalization rejects malformed dynamic actions", () => {
  assert.throws(() => normalizeAppConfig({ id: "bad", actions: [{}] }), /requires id/);
});

test("Playwright bridge builds deterministic browser and DOM extraction commands", () => {
  assert.deepEqual(playwrightSessionArgs({ session: "agent" }), ["-s=agent"]);
  assert.deepEqual(buildBrowserOpenCommand({ url: "https://example.invalid" }, { session: "agent" }), {
    executable: true,
    command: "playwright-cli",
    args: ["-s=agent", "open", "https://example.invalid"],
  });
  assert.deepEqual(buildDomExtractCommand({}, {}), {
    executable: false,
    reason: "dom.extract requires a scriptFile, extractorPath, or generated script",
  });
  assert.equal(buildDomExtractCommand({ scriptFile: "extract.js" }, { extractionOutputPath: "out.json" }).executable, true);
  assert.equal(buildDomExtractCommand({ script: "inline", output: "out.json" }, {}).executable, true);
  assert.equal(authMissingHint({ stderr: "Please sign in to continue" }), true);
});

test("execution planning allowlists deterministic cli and tendril commands", () => {
  const ok = buildStepCommand({ kind: "cli.exec", command: "pandoc", args: ["$params.source"] }, { source: "notes.md" });
  assert.deepEqual(ok, { executable: true, command: "pandoc", args: ["notes.md"] });
  assert.equal(buildStepCommand({ kind: "cli.exec", command: "bash", args: ["-lc", "echo nope"] }).executable, false);
  assert.equal(buildStepCommand({ kind: "tendril.run", target: "Slack", dsl: "send(\"hi\")" }).command, "tendril");
});

test("execution plan allows high-level browser.open when bridge command can be built", () => {
  const plan = buildActionPlan({
    app: "slack",
    action: "open",
    params: { session: "agent" },
  });
  const execution = buildExecutionPlan(plan);
  assert.equal(execution.executable, true);
  assert.deepEqual(execution.stepCommands[0].args, ["-s=agent", "open", "https://app.slack.com/client"]);
});

test("execution plan wires Slack notification snapshot through browser, DOM extraction, and normalizer", () => {
  const plan = buildActionPlan({ app: "slack", action: "notifications.snapshot", params: { session: "agent" } });
  const execution = buildExecutionPlan(plan);
  assert.equal(execution.executable, true);
  assert.deepEqual(execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "slack.notifications.snapshot"]);
  assert.deepEqual(execution.stepCommands[1].args, ["-s=agent", "evaluate", "--script-file", "slackExtractorScript", "--output", "slack-extraction.json"]);
});

test("canvas sync can build live browser open and editor replace plan", () => {
  const plan = buildActionPlan({
    app: "canvas",
    action: "sync-markdown",
    params: { sourcePath: "notes.md", targetUrl: "https://example.invalid", targetSelector: "[contenteditable]", session: "agent" },
  });
  assert.equal(plan.execution.executable, true);
  assert.deepEqual(plan.execution.stepCommands.map((step) => step.kind), ["canvas.sync-markdown", "browser.open", "editor.replace"]);
  assert.deepEqual(plan.execution.stepCommands[1].args, ["-s=agent", "open", "https://example.invalid"]);
  assert.equal(plan.execution.stepCommands[2].internal, "editor.replace");
  assert.match(buildEditorReplaceScript({ selector: "[contenteditable]", text: "hello" }), /querySelector/);
});

test("canvas sync writes Markdown, HTML, paste text, and sync metadata", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `canvas-sync-${Date.now()}`), { recursive: true });
  const sourcePath = path.join(root, "notes.md");
  const snapshotDir = path.join(root, "snapshots");
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(sourcePath, "# Hello\n\nCanvas body", "utf8");
  const metadata = await syncMarkdownCanvas({ sourcePath, targetUrl: "https://example.invalid", targetSelector: "[contenteditable]" }, {
    snapshotDir,
    cwd: root,
    now: new Date("2026-05-12T00:00:00Z"),
  });
  assert.equal(metadata.status, "ready_for_browser_sync");
  assert.equal(buildCanvasPastePlan({}).executable, false);
  assert.match(await readFile(metadata.outputs.html, "utf8"), /Canvas body/);
  assert.match(await readFile(metadata.outputs.sync, "utf8"), /ready_for_browser_sync/);
  await rm(root, { recursive: true, force: true });
});

test("Slack notification snapshot parses unread and mention lines", () => {
  const snapshot = buildSlackNotificationSnapshot({
    source: "fixture",
    url: "https://app.slack.com/client/T/C",
    title: "Slack",
    items: [
      { text: "#general 3 unread", ariaLabel: "", dataQa: "channel_sidebar_channel" },
      { text: "Harry mentioned you", ariaLabel: "1 mention", dataQa: "channel_sidebar_dm" },
      { text: "quiet channel", ariaLabel: "", dataQa: "channel_sidebar_channel" },
    ],
  }, { now: new Date("2026-05-12T00:00:00Z") });
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.counts.items, 2);
  assert.equal(snapshot.counts.mentions, 1);
  assert.match(renderSlackNotificationMarkdown(snapshot), /#general/);
  assert.match(slackExtractorScript(), /querySelectorAll/);
});

test("Outlook and Teams expose concrete notification and calendar snapshot actions", () => {
  const outlook = listAppConfigs().find((app) => app.id === "outlook");
  const teams = listAppConfigs().find((app) => app.id === "teams");
  assert.deepEqual(outlook.actions.map((action) => action.id), ["notifications.snapshot", "calendar.snapshot"]);
  assert.deepEqual(teams.actions.map((action) => action.id), ["notifications.snapshot", "calendar.snapshot"]);
  const outlookCalendar = buildActionPlan({ app: "outlook", action: "calendar.snapshot", params: { session: "agent" } });
  const teamsNotifications = buildActionPlan({ app: "teams", action: "notifications.snapshot", params: { session: "agent" } });
  assert.equal(outlookCalendar.execution.executable, true);
  assert.equal(teamsNotifications.execution.executable, true);
  assert.deepEqual(outlookCalendar.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  assert.deepEqual(teamsNotifications.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  assert.match(microsoftExtractorScript({ app: "teams", includePatterns: ["unread"] }), /includePatterns/);
});

test("generic notification snapshots filter supplied extraction text", () => {
  const snapshot = buildGenericSnapshot({
    app: "teams",
    kind: "notifications.snapshot",
    input: "quiet\n3 unread in Ops\nteam lunch",
    includePatterns: ["unread", "mention"],
  });
  assert.equal(snapshot.count, 1);
  assert.match(renderGenericMarkdown(snapshot), /3 unread in Ops/);
});

test("snapshot artifact helpers list and read bounded readable files", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-artifacts-${Date.now()}`), { recursive: true });
  const slackDir = path.join(root, "snapshots", "slack");
  await mkdir(slackDir, { recursive: true });
  await writeFile(path.join(slackDir, "notifications.md"), "# Slack\n", "utf8");
  await writeFile(path.join(slackDir, "notifications.json"), JSON.stringify({ app: "slack", kind: "notifications.snapshot", status: "ok", counts: { items: 2 } }), "utf8");
  await writeFile(path.join(slackDir, "extractor.js"), "secret-ish helper should not be listed", "utf8");

  const summary = await listSnapshotArtifacts({ root, app: "slack" });
  assert.equal(summary.artifacts.length, 2);
  assert.match(summary.artifacts.map((artifact) => artifact.relativePath).join("\n"), /snapshots\/slack\/notifications\.md/);
  assert.match(renderArtifactList(summary), /notifications\.md/);
  const digest = await digestSnapshotArtifacts({ root, app: "slack" });
  assert.match(renderSnapshotDigest(digest), /counts=items=2/);
  const artifact = await readSnapshotArtifact({ root, file: "snapshots/slack/notifications.md", maxBytes: 4 });
  assert.equal(artifact.content, "# Sl");
  assert.equal(artifact.truncated, true);
  await assert.rejects(() => readSnapshotArtifact({ root, file: "../outside.md" }), /inside/);
  await rm(root, { recursive: true, force: true });
});

test("extension is packaged and exposes list, overview, plan, run, refresh, bundle, snapshot, status tools plus /tendril-app", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../extensions/app-automation.js", import.meta.url), "utf8");

  assert.ok(packageJson.pi.extensions.includes("./extensions/app-automation.js"));
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_list`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_overview`/);
  assert.match(source, /renderWorkAppOverview/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_plan`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_run`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_start`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_bundle_start`/);
  assert.match(source, /DEFAULT_REFRESH_BUNDLE/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_status`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_stop`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshots_list`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshots_digest`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshot_read`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_status`/);
  assert.match(source, /setInterval/);
  assert.match(source, /session_shutdown/);
  assert.match(source, /registerCommand\("tendril-app"/);
});

test("sanitizeId normalizes user-facing app selectors", () => {
  assert.equal(sanitizeId("Slack Web!"), "slack-web");
  assert.equal(sanitizeId("  Teams/v2  "), "teams-v2");
});
