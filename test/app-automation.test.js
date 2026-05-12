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
  collectSnapshotLinks,
  digestSnapshotArtifacts,
  listSnapshotArtifacts,
  readSnapshotArtifact,
  planSnapshotCleanup,
  renderArtifactList,
  renderSnapshotCleanupPlan,
  renderSnapshotDigest,
  renderSnapshotLinks,
  renderSnapshotStaleness,
  renderSnapshotTargetStaleness,
  snapshotStalenessReport,
  snapshotTargetStalenessReport,
} from "../extensions/app-automation/artifacts.js";
import { calendarExtractorScript } from "../extensions/app-automation/calendar.js";
import { buildCanvasPastePlan, syncMarkdownCanvas } from "../extensions/app-automation/canvas.js";
import { buildEditorReplaceScript } from "../extensions/app-automation/editor.js";
import { buildGenericSnapshot, renderGenericMarkdown } from "../extensions/app-automation/generic-snapshot.js";
import { microsoftExtractorScript } from "../extensions/app-automation/microsoft.js";
import { buildSafeRunManifest, runStatusFromResults } from "../extensions/app-automation/run-manifest.js";
import {
  authMissingHint,
  buildAuthRequiredDiagnostic,
  buildBrowserOpenCommand,
  buildDomExtractCommand,
  playwrightSessionArgs,
} from "../extensions/app-automation/playwright-bridge.js";
import {
  buildSlackNotificationSnapshot,
  renderSlackNotificationMarkdown,
  slackExtractorScript,
} from "../extensions/app-automation/slack.js";

test("app automation catalog includes Slack, canvas, calendar, Outlook, and Teams", () => {
  const apps = listAppConfigs();
  assert.deepEqual(apps.map((app) => app.id), ["slack", "canvas", "calendar", "outlook", "teams"]);
  assert.match(renderAppList(apps), /slack: Slack Web/);
  assert.match(renderAppList(apps), /canvas: Markdown canvas sync/);
  assert.match(renderAppList(apps), /calendar: Calendar Web/);
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

test("run status treats optional skipped steps as non-failures", () => {
  assert.equal(runStatusFromResults([{ status: "ok" }, { status: "skipped" }]), "ok");
  assert.equal(runStatusFromResults([{ status: "ok" }, { status: "error" }]), "error");
});

test("safe run manifests omit command output while preserving useful status", () => {
  const manifest = buildSafeRunManifest({
    plan: { app: { id: "slack" }, action: { id: "notifications.snapshot" } },
    run: {
      status: "error",
      results: [{ index: 0, kind: "browser.open", status: "error", code: 1, stdout: "secret", stderr: "token=abc", authRequired: true, authRequiredPath: "/state/auth-required.json" }],
    },
    now: new Date("2026-05-12T00:00:00Z"),
  });
  assert.equal(manifest.app, "slack");
  assert.equal(manifest.results[0].authRequired, true);
  assert.equal(manifest.results[0].authRequiredPath, "/state/auth-required.json");
  assert.equal("stdout" in manifest.results[0], false);
  assert.equal("stderr" in manifest.results[0], false);
});

test("auth-required diagnostics redact sessions and secrets", () => {
  const diagnostic = buildAuthRequiredDiagnostic({
    app: "slack",
    action: "notifications.snapshot",
    step: { index: 0, kind: "browser.open", command: "playwright-cli", args: ["-s=harry", "open", "https://user:pass@app.slack.com/client/T/C?token=secret#frag"] },
    result: { stdout: "visit https://outlook.office.com/mail/?auth=secret#session", stderr: "login required token=abc123 Bearer abc.def https://teams.microsoft.com/v2/?tenant=secret#frag" },
    now: new Date("2026-05-12T00:00:00Z"),
  });
  assert.equal(diagnostic.status, "auth_required");
  assert.deepEqual(diagnostic.step.args, ["-s=[redacted-session]", "open", "https://app.slack.com/client/T/C"]);
  assert.match(diagnostic.stderr, /token=\[redacted\]/);
  assert.match(diagnostic.stderr, /Bearer \[redacted\]/);
  assert.match(diagnostic.stderr, /https:\/\/teams\.microsoft\.com\/v2\//);
  assert.match(diagnostic.stdout, /https:\/\/outlook\.office\.com\/mail\//);
  assert.doesNotMatch(JSON.stringify(diagnostic), /user:pass|auth=secret|tenant=secret|#frag|#session/);
});

test("execution planning allowlists deterministic cli and tendril commands", () => {
  const ok = buildStepCommand({ kind: "cli.exec", command: "pandoc", args: ["$params.source"] }, { source: "notes.md" });
  assert.deepEqual(ok, { executable: true, command: "pandoc", args: ["notes.md"] });
  assert.equal(buildStepCommand({ kind: "cli.exec", command: "bash", args: ["-lc", "echo nope"] }).executable, false);
  assert.equal(buildStepCommand({ kind: "tendril.run", target: "Slack", dsl: "send(\"hi\")" }).command, "tendril");
  assert.deepEqual(buildStepCommand(
    { kind: "tendril.run", target: "Slack", dsl: "send(\"hi\")" },
    {},
    { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev", AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" },
  ).args, ["--remote", "ms-dev", "--wsl-tunnel", "run", "--window", "Slack", "send(\"hi\")"]);
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
      { text: "#general 3 unread", ariaLabel: "", dataQa: "channel_sidebar_channel", hrefs: ["https://app.slack.com/client/T/C?token=secret#frag"] },
      { text: "Harry mentioned you", ariaLabel: "1 mention", dataQa: "channel_sidebar_dm", href: "https://app.slack.com/client/T/D" },
      { text: "quiet channel", ariaLabel: "", dataQa: "channel_sidebar_channel", href: "javascript:alert(1)" },
    ],
  }, { now: new Date("2026-05-12T00:00:00Z") });
  assert.equal(snapshot.status, "ok");
  assert.equal(snapshot.counts.items, 2);
  assert.equal(snapshot.counts.mentions, 1);
  assert.equal(snapshot.notifications[0].url, "https://app.slack.com/client/T/C");
  assert.doesNotMatch(JSON.stringify(snapshot), /token=secret|#frag|javascript/);
  assert.match(renderSlackNotificationMarkdown(snapshot), /\[#general/);
  assert.match(renderSlackNotificationMarkdown(snapshot), /https:\/\/app\.slack\.com\/client\/T\/C/);
  const extractor = slackExtractorScript();
  assert.match(extractor, /querySelectorAll/);
  assert.match(extractor, /hrefs/);
});

test("calendar app exposes open and events snapshot actions", () => {
  const calendar = listAppConfigs().find((app) => app.id === "calendar");
  assert.deepEqual(calendar.actions.map((action) => action.id), ["open", "events.snapshot"]);
  const openPlan = buildActionPlan({ app: "calendar", action: "open", params: { session: "agent" } });
  const snapshotPlan = buildActionPlan({ app: "calendar", action: "events.snapshot", params: { session: "agent" } });
  assert.equal(openPlan.execution.executable, true);
  assert.equal(snapshotPlan.execution.executable, true);
  assert.deepEqual(snapshotPlan.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  const extractor = calendarExtractorScript({ includePatterns: ["meeting"] });
  assert.match(extractor, /includePatterns/);
  assert.match(extractor, /hrefs/);
});

test("Outlook and Teams expose concrete notification and calendar snapshot actions", () => {
  const outlook = listAppConfigs().find((app) => app.id === "outlook");
  const teams = listAppConfigs().find((app) => app.id === "teams");
  assert.deepEqual(outlook.actions.map((action) => action.id), ["open", "calendar.open", "notifications.snapshot", "calendar.snapshot"]);
  assert.deepEqual(teams.actions.map((action) => action.id), ["open", "calendar.open", "notifications.snapshot", "calendar.snapshot"]);
  const outlookCalendar = buildActionPlan({ app: "outlook", action: "calendar.snapshot", params: { session: "agent" } });
  const teamsNotifications = buildActionPlan({ app: "teams", action: "notifications.snapshot", params: { session: "agent" } });
  assert.equal(outlookCalendar.execution.executable, true);
  assert.equal(teamsNotifications.execution.executable, true);
  assert.equal(buildActionPlan({ app: "outlook", action: "calendar.open", params: { session: "agent" } }).execution.executable, true);
  assert.deepEqual(buildActionPlan({ app: "teams", action: "open", params: { session: "agent" } }).execution.stepCommands[0].args, ["-s=agent", "open", "https://teams.microsoft.com/v2/"]);
  assert.deepEqual(outlookCalendar.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  assert.deepEqual(teamsNotifications.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  const microsoftExtractor = microsoftExtractorScript({ app: "teams", includePatterns: ["unread"] });
  assert.match(microsoftExtractor, /includePatterns/);
  assert.match(microsoftExtractor, /hrefs/);
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

test("generic app snapshots preserve redacted meeting and message links", () => {
  const snapshot = buildGenericSnapshot({
    app: "calendar",
    kind: "events.snapshot",
    input: {
      items: [
        { text: "Team standup join", hrefs: ["https://meet.google.com/abc-defg-hij?authuser=0#secret"] },
        { text: "Ops meeting", url: "https://teams.microsoft.com/l/meetup-join/abc?token=secret" },
        { text: "ignored javascript", href: "javascript:alert(1)" },
      ],
    },
    includePatterns: ["join", "meeting"],
  });
  assert.equal(snapshot.count, 2);
  assert.equal(snapshot.items[0].url, "https://meet.google.com/abc-defg-hij");
  assert.equal(snapshot.items[1].url, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.doesNotMatch(JSON.stringify(snapshot), /token=secret|authuser=0|#secret/);
  assert.match(renderGenericMarkdown(snapshot), /\[Team standup join\]\(https:\/\/meet\.google\.com\/abc-defg-hij\)/);
});

test("snapshot artifact helpers list and read bounded readable files", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-artifacts-${Date.now()}`), { recursive: true });
  const slackDir = path.join(root, "snapshots", "slack");
  await mkdir(slackDir, { recursive: true });
  await writeFile(path.join(slackDir, "notifications.md"), "# Slack\n", "utf8");
  await writeFile(path.join(slackDir, "notifications.json"), JSON.stringify({ app: "slack", kind: "notifications.snapshot", status: "ok", capturedAt: "2026-05-12T00:00:00Z", counts: { items: 2 }, notifications: [{ text: "#general", url: "https://app.slack.com/client/T/C", urls: ["https://app.slack.com/client/T/C", "https://app.slack.com/client/T/D"] }] }), "utf8");
  await writeFile(path.join(slackDir, "latest-run.json"), JSON.stringify({ app: "slack", action: "notifications.snapshot", status: "error", results: [{ status: "error", authRequired: true }, { status: "ok" }] }), "utf8");
  await writeFile(path.join(slackDir, "auth-required.json"), JSON.stringify({ app: "slack", action: "notifications.snapshot", status: "auth_required", detectedAt: "2026-05-12T00:00:00Z" }), "utf8");
  await writeFile(path.join(slackDir, "extractor.js"), "secret-ish helper should not be listed", "utf8");

  const summary = await listSnapshotArtifacts({ root, app: "slack" });
  assert.equal(summary.artifacts.length, 4);
  assert.match(summary.artifacts.map((artifact) => artifact.relativePath).join("\n"), /snapshots\/slack\/notifications\.md/);
  assert.match(renderArtifactList(summary), /notifications\.md/);
  const digest = await digestSnapshotArtifacts({ root, app: "slack" });
  const renderedDigest = renderSnapshotDigest(digest);
  assert.match(renderedDigest, /counts=items=2/);
  assert.match(renderedDigest, /links=2 linkItems=1/);
  const links = await collectSnapshotLinks({ root, app: "slack" });
  assert.equal(links.links.length, 2);
  assert.equal(links.links[0].url, "https://app.slack.com/client/T/C");
  assert.match(renderSnapshotLinks(links), /#general: https:\/\/app\.slack\.com\/client\/T\/C/);
  assert.equal(links.links[0].snapshotAt, "2026-05-12T00:00:00Z");
  assert.match(renderSnapshotLinks(links), /captured=2026-05-12T00:00:00Z/);
  assert.match(renderSnapshotLinks(links), /modified=/);
  const filteredLinks = await collectSnapshotLinks({ root, app: "slack", query: "/D" });
  assert.equal(filteredLinks.links.length, 1);
  assert.equal(filteredLinks.links[0].url, "https://app.slack.com/client/T/D");
  assert.match(renderedDigest, /action=notifications\.snapshot status=error results=2 authRequired=1 resultStatuses=error=1,ok=1/);
  assert.match(renderedDigest, /status=auth_required/);
  const staleness = await snapshotStalenessReport({ root, apps: ["slack", "outlook"], staleAfterMinutes: 1, now: new Date(Date.now() + 5 * 60000) });
  assert.match(renderSnapshotStaleness(staleness), /slack: stale/);
  assert.match(renderSnapshotStaleness(staleness), /outlook: missing/);
  await mkdir(path.join(root, "snapshots", "outlook"), { recursive: true });
  await writeFile(path.join(root, "snapshots", "outlook", "notifications.snapshot.json"), JSON.stringify({ app: "outlook", kind: "notifications.snapshot", status: "ok" }), "utf8");
  await writeFile(path.join(root, "snapshots", "outlook", "calendar.snapshot.json"), JSON.stringify({ app: "outlook", kind: "calendar.snapshot", status: "ok" }), "utf8");
  const targetStaleness = await snapshotTargetStalenessReport({
    root,
    targets: [
      { app: "outlook", action: "notifications.snapshot", outputs: ["snapshots/outlook/notifications.snapshot.json", "snapshots/outlook/notifications.snapshot.md"] },
      { app: "outlook", action: "calendar.snapshot", outputs: ["snapshots/outlook/calendar.snapshot.json", "snapshots/outlook/calendar.snapshot.md"] },
    ],
    staleAfterMinutes: 60,
  });
  assert.equal(targetStaleness.entries.find((entry) => entry.action === "notifications.snapshot").status, "partial");
  assert.equal(targetStaleness.entries.find((entry) => entry.action === "calendar.snapshot").status, "partial");
  assert.deepEqual(targetStaleness.entries.find((entry) => entry.action === "calendar.snapshot").missingArtifacts, ["snapshots/outlook/calendar.snapshot.md"]);
  assert.match(renderSnapshotTargetStaleness(targetStaleness), /outlook\.calendar\.snapshot: partial/);
  const cleanup = await planSnapshotCleanup({ root, app: "slack", keepLatest: 1 });
  assert.equal(cleanup.candidateCount, 1);
  assert.match(renderSnapshotCleanupPlan(cleanup), /candidates=1/);
  assert.equal(cleanup.protectedArtifacts.some((artifact) => artifact.relativePath.endsWith("latest-run.json")), true);
  const artifact = await readSnapshotArtifact({ root, file: "snapshots/slack/notifications.md", maxBytes: 4 });
  assert.equal(artifact.content, "# Sl");
  assert.equal(artifact.truncated, true);
  await assert.rejects(() => readSnapshotArtifact({ root, file: "../outside.md" }), /inside/);
  await rm(root, { recursive: true, force: true });
});

test("extension is packaged and exposes list, doctor, overview, plan, run, open bundle, refresh, bundle, one-shot, snapshot, status tools plus /tendril-app", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../extensions/app-automation.js", import.meta.url), "utf8");

  assert.ok(packageJson.pi.extensions.includes("./extensions/app-automation.js"));
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_list`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_doctor`/);
  assert.match(source, /DEFAULT_DOCTOR_ACTIONS/);
  assert.match(source, /renderDoctorReport/);
  assert.match(source, /tendrilCommandSummary/);
  assert.match(source, /tendrilBridge command=/);
  assert.match(source, /probeTendrilBridge/);
  assert.match(source, /tendrilProbe=/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_overview`/);
  assert.match(source, /renderWorkAppOverview/);
  assert.match(source, /includeStaleness/);
  assert.match(source, /includeRefreshStaleness/);
  assert.match(source, /includeLinks/);
  assert.match(source, /snapshotLinks/);
  assert.match(source, /refresh action staleness/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_plan`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_run`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_open_bundle_run_once`/);
  assert.match(source, /DEFAULT_OPEN_BUNDLE/);
  assert.match(source, /calendarExtractorScript/);
  assert.match(source, /Return planned open bundle actions/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_start`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_bundle_start`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_bundle_run_once`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_staleness`/);
  assert.match(source, /renderSnapshotTargetStaleness/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_stale_run_once`/);
  assert.match(source, /Return planned refresh bundle actions/);
  assert.match(source, /DEFAULT_REFRESH_BUNDLE/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_status`/);
  assert.match(source, /consecutiveErrorCount/);
  assert.match(source, /lastSuccessAt/);
  assert.match(source, /consecutiveErrors=/);
  assert.match(source, /lastSuccess=/);
  assert.match(source, /authRequired=/);
  assert.match(source, /authPaths=/);
  assert.match(source, /lastError=/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_refresh_stop`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshots_list`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshots_digest`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshot_links`/);
  assert.match(source, /renderSnapshotLinks/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshots_staleness`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshots_cleanup_plan`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_snapshot_read`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_status`/);
  assert.match(source, /setInterval/);
  assert.match(source, /session_shutdown/);
  assert.match(source, /registerCommand\("tendril-app"/);
  assert.match(source, /words\[0\] === "doctor"/);
  assert.match(source, /words\[0\] === "overview"/);
  assert.match(source, /words\[0\] === "links"/);
  assert.match(source, /collectSnapshotLinks/);
  assert.match(source, /query: Type\.Optional/);
  assert.match(source, /snapshotStalenessReport/);
  assert.match(source, /words\[0\] === "staleness"/);
  assert.match(source, /words\[0\] === "bundle"/);
  assert.match(source, /words\[0\] === "open-bundle"/);
  assert.match(source, /words\[0\] === "refresh-staleness"/);
  assert.match(source, /words\[0\] === "stale-refresh"/);
  assert.match(source, /renderDefaultOpenBundle/);
  assert.match(source, /renderDefaultRefreshBundle/);
  assert.match(source, /renderDefaultStaleRefresh/);
});

test("sanitizeId normalizes user-facing app selectors", () => {
  assert.equal(sanitizeId("Slack Web!"), "slack-web");
  assert.equal(sanitizeId("  Teams/v2  "), "teams-v2");
});
