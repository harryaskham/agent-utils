import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseLinkCommandArgs, parseLinkCommandFilters, parseOverviewCommandArgs } from "../extensions/app-automation/link-command.js";
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
  aggregateSnapshotLinkSummaries,
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
import { buildWorkBriefingIndex, renderWorkBriefingIndex } from "../extensions/app-automation/briefing.js";
import { buildMsDevAppHostPowerShell, buildMsDevCdpPowerShell, renderMsDevCdpRefresh, runMsDevCdpRefresh } from "../extensions/app-automation/msdev-cdp.js";
import { microsoftExtractorScript } from "../extensions/app-automation/microsoft.js";
import { checkGwsStatus, checkRemoteGwsStatus, parseOrgTodoTimelyItems, renderPersonalAutomationStatus } from "../extensions/app-automation/personal.js";
import { buildSafeRunManifest, runStatusFromResults } from "../extensions/app-automation/run-manifest.js";
import { readLatestMsDevRefreshSummary, renderDoctorReport } from "../extensions/app-automation/doctor.js";
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
  assert.equal(snapshot.notifications[0].source, "#general");
  assert.equal(snapshot.notifications[1].source, "Harry mentioned you");
  const desktopSnapshot = buildSlackNotificationSnapshot({ items: [{ text: "Slack desktop reports 1 new item", source: "Slack Desktop" }] });
  assert.equal(desktopSnapshot.notifications[0].source, "Slack Desktop");
  assert.equal(desktopSnapshot.notifications[0].unreadCount, 1);
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
  const outlookMail = buildActionPlan({ app: "outlook", action: "notifications.snapshot", params: { session: "agent" } });
  const outlookCalendar = buildActionPlan({ app: "outlook", action: "calendar.snapshot", params: { session: "agent" } });
  const teamsNotifications = buildActionPlan({ app: "teams", action: "notifications.snapshot", params: { session: "agent" } });
  assert.equal(outlookMail.execution.executable, true);
  assert.equal(outlookCalendar.execution.executable, true);
  assert.equal(teamsNotifications.execution.executable, true);
  assert.equal(buildActionPlan({ app: "outlook", action: "calendar.open", params: { session: "agent" } }).execution.executable, true);
  assert.deepEqual(buildActionPlan({ app: "teams", action: "open", params: { session: "agent" } }).execution.stepCommands[0].args, ["-s=agent", "open", "https://teams.microsoft.com/v2/"]);
  assert.deepEqual(outlookMail.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  assert.deepEqual(outlookCalendar.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  assert.deepEqual(teamsNotifications.execution.stepCommands.map((step) => step.kind), ["browser.open", "dom.extract", "generic.notifications.snapshot"]);
  assert.ok(outlookMail.steps[1].includePatterns.includes("sender"));
  assert.ok(outlookMail.steps[1].includePatterns.includes("subject"));
  assert.ok(outlookCalendar.steps[1].includePatterns.includes("organizer"));
  assert.ok(outlookCalendar.steps[1].includePatterns.includes("join"));
  const microsoftExtractor = microsoftExtractorScript({ app: "teams", kind: "calendar.snapshot", includePatterns: ["unread"] });
  assert.match(microsoftExtractor, /includePatterns/);
  assert.match(microsoftExtractor, /hrefs/);
  assert.match(microsoftExtractor, /sourceFor/);
  assert.match(microsoftExtractor, /fromFor/);
  assert.match(microsoftExtractor, /Teams Calendar/);
  assert.match(microsoftExtractor, /Outlook Mail/);
  assert.match(microsoftExtractor, /timeFor/);
  assert.match(microsoftExtractor, /datetime/);
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
      title: "Calendar - Work",
      items: [
        { text: "Team standup join", calendar: "Work", organizer: "Ada", start: "09:00", hrefs: ["https://meet.google.com/abc-defg-hij?authuser=0#secret"] },
        { text: "Ops meeting", source: "Teams", from: "Ops", time: "10:00", url: "https://teams.microsoft.com/l/meetup-join/abc?token=secret" },
        { text: "Planning meeting", href: "https://outlook.office.com/calendar/item/123?token=secret#frag" },
        { text: "ignored javascript", href: "javascript:alert(1)" },
      ],
    },
    includePatterns: ["join", "meeting"],
  });
  assert.equal(snapshot.count, 3);
  assert.equal(snapshot.items[0].url, "https://meet.google.com/abc-defg-hij");
  assert.deepEqual({ source: snapshot.items[0].source, from: snapshot.items[0].from, time: snapshot.items[0].time }, { source: "Work", from: "Ada", time: "09:00" });
  assert.equal(snapshot.items[1].url, "https://teams.microsoft.com/l/meetup-join/abc");
  assert.deepEqual({ source: snapshot.items[1].source, from: snapshot.items[1].from, time: snapshot.items[1].time }, { source: "Teams", from: "Ops", time: "10:00" });
  assert.equal(snapshot.items[2].url, "https://outlook.office.com/calendar/item/123");
  assert.equal(snapshot.items[2].source, "Calendar - Work");
  assert.doesNotMatch(JSON.stringify(snapshot), /token=secret|authuser=0|#secret/);
  assert.match(renderGenericMarkdown(snapshot), /\[Team standup join\]\(https:\/\/meet\.google\.com\/abc-defg-hij\) — source: Work; from: Ada; time: 09:00/);
  const hostFallbackSnapshot = buildGenericSnapshot({
    app: "outlook",
    kind: "calendar.snapshot",
    input: {
      url: "https://outlook.office.com/calendar/?token=secret#frag",
      items: [{ text: "Planning join", href: "https://outlook.office.com/calendar/item/456?token=secret#frag" }],
    },
    includePatterns: ["planning"],
  });
  assert.equal(hostFallbackSnapshot.items[0].source, "outlook.office.com");
  assert.doesNotMatch(JSON.stringify(hostFallbackSnapshot), /token=secret|#frag/);
  const calendarExtractor = calendarExtractorScript({ includePatterns: ["standup"] });
  assert.match(calendarExtractor, /timeFor/);
  assert.match(calendarExtractor, /data-start-time/);
  assert.match(calendarExtractor, /datetime/);
});

test("/tendril-app overview parser keeps links option out of app ids", () => {
  assert.deepEqual(parseOverviewCommandArgs(["links"], { appIds: ["slack", "calendar", "outlook"], defaultAppIds: ["slack", "calendar"] }), {
    includeLinks: true,
    apps: ["slack", "calendar"],
  });
  assert.deepEqual(parseOverviewCommandArgs(["slack", "links"], { appIds: ["slack", "calendar", "outlook"], defaultAppIds: ["slack", "calendar"] }), {
    includeLinks: true,
    apps: ["slack"],
  });
  assert.deepEqual(parseOverviewCommandArgs(["fresh", "kind:events", "source:calendar", "from=Harry", "time:today", "host:meet.google.com", "query:standup", "link-limit:5", "link-sort:newest", "stale-after:1440", "calendar"], { appIds: ["slack", "calendar", "outlook"], defaultAppIds: ["slack", "calendar"] }), {
    includeLinks: true,
    apps: ["calendar"],
    linkFreshness: "fresh",
    linkKind: "events",
    linkLimitPerApp: 5,
    linkQuery: "standup",
    linkSource: "calendar",
    linkFrom: "Harry",
    linkTime: "today",
    linkHost: "meet.google.com",
    linkSort: "newest",
    staleAfterMinutes: 1440,
  });
  assert.deepEqual(parseOverviewCommandArgs(["links", "slack", "standup", "planning"], { appIds: ["slack", "calendar", "outlook"], defaultAppIds: ["slack", "calendar"] }), {
    includeLinks: true,
    apps: ["slack"],
    linkQuery: "standup planning",
  });
  assert.deepEqual(parseOverviewCommandArgs(["standup", "planning"], { appIds: ["slack", "calendar", "outlook"], defaultAppIds: ["slack", "calendar"] }), {
    includeLinks: false,
    apps: ["slack", "calendar"],
  });
});

test("/tendril-app link filter parser accepts flexible token order", () => {
  assert.deepEqual(parseLinkCommandFilters(["kind:events.snapshot", "fresh", "standup"]), {
    freshness: "fresh",
    kind: "events.snapshot",
    query: "standup",
  });
  assert.deepEqual(parseLinkCommandFilters(["Ops", "freshness=stale", "sort:newest", "kind=notifications.snapshot", "source:#general", "from=Harry", "time:today", "host:slack.com", "Bot"]), {
    freshness: "stale",
    kind: "notifications.snapshot",
    source: "#general",
    from: "Harry",
    time: "today",
    host: "slack.com",
    sort: "newest",
    query: "Ops Bot",
  });
  assert.deepEqual(parseLinkCommandArgs(["fresh", "sort:time", "standup"], { appIds: ["slack", "calendar"] }), {
    app: undefined,
    freshness: "fresh",
    sort: "time",
    query: "standup",
  });
  assert.deepEqual(parseLinkCommandArgs(["slack", "kind:notifications.snapshot", "10"], { appIds: ["slack", "calendar"] }), {
    app: "slack",
    linkLimit: 10,
    kind: "notifications.snapshot",
    query: "",
  });
  assert.deepEqual(parseLinkCommandArgs(["limit:5", "fresh", "stale-after:1440", "standup", "2026"], { appIds: ["slack", "calendar"] }), {
    app: undefined,
    linkLimit: 5,
    freshness: "fresh",
    staleAfterMinutes: 1440,
    query: "standup 2026",
  });
});

test("snapshot artifact helpers list and read bounded readable files", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-artifacts-${Date.now()}`), { recursive: true });
  const slackDir = path.join(root, "snapshots", "slack");
  await mkdir(slackDir, { recursive: true });
  await writeFile(path.join(slackDir, "notifications.md"), "# Slack\n", "utf8");
  await writeFile(path.join(slackDir, "notifications.json"), JSON.stringify({ app: "slack", kind: "notifications.snapshot", status: "ok", capturedAt: "2026-05-12T00:00:00Z", counts: { items: 2 }, notifications: [{ text: "#general", channel: "#general", from: "Ops Bot", time: "00:10", url: "https://app.slack.com/client/T/C", urls: ["https://app.slack.com/client/T/C", "https://app.slack.com/client/T/D"] }] }), "utf8");
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
  const links = await collectSnapshotLinks({ root, app: "slack", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(links.links.length, 2);
  assert.deepEqual(links.freshnessCounts, { total: 2, fresh: 2, stale: 0, unknown: 0 });
  assert.equal(links.links[0].url, "https://app.slack.com/client/T/C");
  assert.equal(links.links[0].urlHost, "app.slack.com");
  assert.deepEqual(links.links[0].context, { source: "#general", from: "Ops Bot", time: "00:10" });
  assert.equal(links.scannedArtifactCount, 4);
  assert.match(renderSnapshotLinks(links), /links total=2 scanned=4 fresh=2 stale=0 unknown=0/);
  assert.match(renderSnapshotLinks(links), /#general: https:\/\/app\.slack\.com\/client\/T\/C/);
  assert.match(renderSnapshotLinks(links), /host=app\.slack\.com/);
  assert.match(renderSnapshotLinks(links), /context=source:"#general" from:"Ops Bot" time:"00:10"/);
  const contextFilteredLinks = await collectSnapshotLinks({ root, app: "slack", query: "Ops Bot", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(contextFilteredLinks.links.length, 2);
  assert.ok(contextFilteredLinks.links.every((link) => link.context.from === "Ops Bot"));
  const sourceFilteredLinks = await collectSnapshotLinks({ root, app: "slack", source: "general", from: "ops", time: "00:10", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(sourceFilteredLinks.links.length, 2);
  assert.equal(sourceFilteredLinks.source, "general");
  assert.equal(sourceFilteredLinks.from, "ops");
  assert.equal(sourceFilteredLinks.time, "00:10");
  assert.match(renderSnapshotLinks(sourceFilteredLinks), /source="general" from="ops" time="00:10"/);
  const hostFilteredLinks = await collectSnapshotLinks({ root, app: "slack", host: "slack.com", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(hostFilteredLinks.links.length, 2);
  assert.equal(hostFilteredLinks.host, "slack.com");
  assert.match(renderSnapshotLinks(hostFilteredLinks), /host="slack.com"/);
  assert.equal(links.links[0].snapshotAt, "2026-05-12T00:00:00Z");
  assert.equal(links.links[0].freshness, "fresh");
  assert.equal(links.links[0].ageMinutes, 30);
  assert.match(renderSnapshotLinks(links), /captured=2026-05-12T00:00:00Z/);
  assert.match(renderSnapshotLinks(links), /modified=/);
  assert.match(renderSnapshotLinks(links), /freshness=fresh age=30m/);
  const filteredLinks = await collectSnapshotLinks({ root, app: "slack", query: "/D", staleAfterMinutes: 10, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(filteredLinks.links.length, 1);
  assert.equal(filteredLinks.links[0].url, "https://app.slack.com/client/T/D");
  assert.equal(filteredLinks.links[0].freshness, "stale");
  const freshLinks = await collectSnapshotLinks({ root, app: "slack", freshness: "fresh", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(freshLinks.links.length, 2);
  const staleLinks = await collectSnapshotLinks({ root, app: "slack", freshness: "stale", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(staleLinks.links.length, 0);
  assert.deepEqual(staleLinks.freshnessCounts, { total: 0, fresh: 0, stale: 0, unknown: 0 });
  assert.match(renderSnapshotLinks(staleLinks), /No snapshot links matching freshness=stale found at \[state-root\]\/snapshots\/slack \(scanned 4 artifacts\)/);
  await writeFile(path.join(slackDir, "boolean-context.json"), JSON.stringify({ app: "slack", kind: "notifications.snapshot", status: "ok", capturedAt: "2026-05-12T00:00:00Z", notifications: [{ text: "DM 1 unread", channel: true, dm: true, url: "https://app.slack.com/client/T/E" }] }), "utf8");
  const booleanContextLinks = await collectSnapshotLinks({ root, app: "slack", query: "/E", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.deepEqual(booleanContextLinks.links[0].context, {});
  assert.doesNotMatch(renderSnapshotLinks(booleanContextLinks), /source:"true"|from:"true"|time:"true"/);
  const calendarDir = path.join(root, "snapshots", "calendar");
  await mkdir(calendarDir, { recursive: true });
  await writeFile(path.join(calendarDir, "events.json"), JSON.stringify({ app: "calendar", kind: "events.snapshot", status: "ok", capturedAt: "2026-05-12T00:05:00Z", items: [{ title: "Standup", url: "https://meet.google.com/standup" }] }), "utf8");
  const allLinks = await collectSnapshotLinks({ root, app: "all", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(allLinks.links.length, 4);
  assert.deepEqual(allLinks.freshnessCounts, { total: 4, fresh: 4, stale: 0, unknown: 0 });
  assert.deepEqual(allLinks.appCounts, { slack: 3, calendar: 1 });
  assert.deepEqual(allLinks.kindCounts, { "notifications.snapshot": 3, "events.snapshot": 1 });
  assert.deepEqual(allLinks.hostCounts, { "app.slack.com": 3, "meet.google.com": 1 });
  assert.deepEqual(allLinks.sourceCounts, { "#general": 2, unknown: 2 });
  assert.deepEqual(allLinks.fromCounts, { "Ops Bot": 2, unknown: 2 });
  assert.match(renderSnapshotLinks(allLinks), /apps=calendar=1,slack=3/);
  assert.match(renderSnapshotLinks(allLinks), /kinds=events\.snapshot=1,notifications\.snapshot=3/);
  assert.match(renderSnapshotLinks(allLinks), /hosts=app\.slack\.com=3,meet\.google\.com=1/);
  assert.match(renderSnapshotLinks(allLinks), /sources="#general"=2,"unknown"=2/);
  assert.match(renderSnapshotLinks(allLinks), /from="Ops Bot"=2,"unknown"=2/);
  const newestLinks = await collectSnapshotLinks({ root, app: "all", sort: "newest", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(newestLinks.sort, "newest");
  assert.equal(newestLinks.links[0].app, "calendar");
  assert.match(renderSnapshotLinks(newestLinks), /sort=newest/);
  const meetAliasLinks = await collectSnapshotLinks({ root, app: "all", host: "meet", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(meetAliasLinks.links.length, 1);
  assert.equal(meetAliasLinks.links[0].urlHost, "meet.google.com");
  assert.match(renderSnapshotLinks(meetAliasLinks), /host="meet"/);
  const hostSortedLinks = await collectSnapshotLinks({ root, app: "all", sort: "host", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(hostSortedLinks.sort, "host");
  assert.equal(hostSortedLinks.links[0].url, "https://app.slack.com/client/T/C");
  assert.match(renderSnapshotLinks(hostSortedLinks), /sort=host/);
  const sourceSortedLinks = await collectSnapshotLinks({ root, app: "all", sort: "source", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(sourceSortedLinks.sort, "source");
  assert.equal(sourceSortedLinks.links[0].url, "https://app.slack.com/client/T/C");
  assert.match(renderSnapshotLinks(sourceSortedLinks), /sort=source/);
  const fromSortedLinks = await collectSnapshotLinks({ root, app: "all", sort: "from", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(fromSortedLinks.sort, "from");
  assert.equal(fromSortedLinks.links[0].url, "https://app.slack.com/client/T/C");
  assert.match(renderSnapshotLinks(fromSortedLinks), /sort=from/);
  const timeSortedLinks = await collectSnapshotLinks({ root, app: "all", sort: "time", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(timeSortedLinks.sort, "time");
  assert.equal(timeSortedLinks.links[0].url, "https://app.slack.com/client/T/C");
  assert.match(renderSnapshotLinks(timeSortedLinks), /sort=time/);
  const stalestLimitedLinks = await collectSnapshotLinks({ root, app: "all", sort: "stalest", linkLimit: 1, staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(stalestLimitedLinks.truncated, true);
  assert.equal(stalestLimitedLinks.matchedCount, 4);
  assert.equal(stalestLimitedLinks.returnedCount, 1);
  assert.equal(stalestLimitedLinks.links[0].app, "slack");
  assert.match(renderSnapshotLinks(stalestLimitedLinks), /links total=1 matched=4/);
  assert.match(renderSnapshotLinks(stalestLimitedLinks), /truncated at 1 of 4 links/);
  const eventLinks = await collectSnapshotLinks({ root, app: "all", kind: "events.snapshot", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(eventLinks.links.length, 1);
  assert.equal(eventLinks.kind, "events.snapshot");
  assert.match(renderSnapshotLinks(eventLinks), /kinds=events\.snapshot=1/);
  const eventAliasLinks = await collectSnapshotLinks({ root, app: "all", kind: "events", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(eventAliasLinks.links.length, 1);
  assert.equal(eventAliasLinks.kind, "events.snapshot");
  const notificationAliasLinks = await collectSnapshotLinks({ root, app: "all", kind: "notifications", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(notificationAliasLinks.links.length, 3);
  const chatAliasLinks = await collectSnapshotLinks({ root, app: "all", kind: "chat", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(chatAliasLinks.kind, "notifications.snapshot");
  assert.equal(chatAliasLinks.links.length, 3);
  const meetingAliasLinks = await collectSnapshotLinks({ root, app: "all", kind: "meetings", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") });
  assert.equal(meetingAliasLinks.kind, "calendar.snapshot");
  assert.equal(meetingAliasLinks.links.length, 0);
  const aggregatedLinks = aggregateSnapshotLinkSummaries({
    root,
    snapshotRoot: path.join(root, "snapshots"),
    query: "standup",
    freshness: "fresh",
    kind: "events",
    sort: "newest",
    summaries: [
      await collectSnapshotLinks({ root, app: "slack", linkLimit: 1, staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") }),
      await collectSnapshotLinks({ root, app: "calendar", linkLimit: 1, staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") }),
    ],
  });
  assert.equal(aggregatedLinks.query, "standup");
  assert.equal(aggregatedLinks.freshness, "fresh");
  assert.equal(aggregatedLinks.kind, "events.snapshot");
  assert.equal(aggregatedLinks.sort, "newest");
  assert.equal(aggregatedLinks.links[0].app, "calendar");
  assert.equal(aggregatedLinks.matchedCount, 4);
  assert.equal(aggregatedLinks.returnedCount, 2);
  assert.deepEqual(aggregatedLinks.hostCounts, { "app.slack.com": 1, "meet.google.com": 1 });
  assert.deepEqual(aggregatedLinks.sourceCounts, { unknown: 2 });
  assert.deepEqual(aggregatedLinks.fromCounts, { unknown: 2 });
  assert.match(renderSnapshotLinks(aggregatedLinks), /links total=2 matched=4 scanned=6 fresh=2 stale=0 unknown=0 sort=newest freshness=fresh kind=events\.snapshot query="standup"/);
  assert.match(renderSnapshotLinks(aggregatedLinks), /hosts=app\.slack\.com=1,meet\.google\.com=1/);
  assert.match(renderSnapshotLinks(aggregatedLinks), /sources="unknown"=2/);
  assert.match(renderSnapshotLinks(aggregatedLinks), /from="unknown"=2/);
  assert.match(renderSnapshotLinks(aggregatedLinks), /truncated at 2 of 4 links/);
  const emptyAggregatedLinks = aggregateSnapshotLinkSummaries({
    root,
    snapshotRoot: path.join(root, "snapshots"),
    query: "missing",
    summaries: [
      await collectSnapshotLinks({ root, app: "slack", query: "missing", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") }),
      await collectSnapshotLinks({ root, app: "calendar", query: "missing", staleAfterMinutes: 60, now: new Date("2026-05-12T00:30:00Z") }),
    ],
  });
  assert.equal(emptyAggregatedLinks.scannedArtifactCount, 6);
  assert.equal(emptyAggregatedLinks.artifacts, undefined);
  assert.match(renderSnapshotLinks(emptyAggregatedLinks), /No snapshot links matching query="missing" found at \[state-root\]\/snapshots \(scanned 6 artifacts\)/);
  assert.ok(allLinks.links.some((link) => link.app === "calendar" && link.url === "https://meet.google.com/standup"));
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
  assert.equal(cleanup.candidateCount, 2);
  assert.match(renderSnapshotCleanupPlan(cleanup), /candidates=2/);
  assert.equal(cleanup.protectedArtifacts.some((artifact) => artifact.relativePath.endsWith("latest-run.json")), true);
  const artifact = await readSnapshotArtifact({ root, file: "snapshots/slack/notifications.md", maxBytes: 4 });
  assert.equal(artifact.content, "# Sl");
  assert.equal(artifact.truncated, true);
  await assert.rejects(() => readSnapshotArtifact({ root, file: "../outside.md" }), /inside/);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh writes bounded snapshots through ssh PowerShell bridge", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-cdp-${Date.now()}`), { recursive: true });
  const commands = [];
  const stdoutPayload = JSON.stringify({
    capturedAt: "2026-05-13T03:00:00Z",
    source: "ms-dev-chrome-cdp",
    cdpPort: 9224,
    results: [
      { app: "calendar", action: "events.snapshot", status: "ok", result: { title: "Google Calendar", url: "https://calendar.google.com/calendar/u/0/r", authRequired: false, items: [
        { text: "13, Wednesday, today | 13", source: "Google Calendar" },
        { text: "Team standup, 09:00 to 09:30, Wednesday, May 13, By Ada, Busy", source: "Google Calendar", from: "Ada" },
      ] } },
      { app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", url: "https://outlook.office.com/mail/?token=secret#frag", authRequired: false, items: [
        { text: "Delete | ? this message. (#)", source: "Outlook Mail" },
        { text: "Flag this message | Flag this message | ??", source: "Outlook Mail" },
        { text: "Tags | ? Quick steps ? ? Mark all as read", source: "Outlook Mail" },
        { text: "Inbox - 1,467 items (1,123 unread) | ? Inbox selected 1123 unread", source: "Outlook Mail" },
        { text: "Add-ins | ?Enhance Outlook with apps.Viva InsightsInsights. This version applies to Office 365 Enterprise E5", source: "Outlook Mail" },
        { text: "Important mail from Ada", source: "Outlook Mail", from: "Ada", hrefs: ["https://outlook.office.com/mail/id/1?auth=secret#frag"] },
      ] } },
      { app: "slack", action: "notifications.snapshot", status: "ok", result: { title: "Find your workspace | Slack", url: "https://app.slack.com/client", authRequired: true, items: [] } },
    ],
  });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["calendar", "outlook", "slack"],
    actions: ["events.snapshot", "notifications.snapshot"],
    exec: async (command, args) => {
      commands.push({ command, args });
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      if (command === "ssh") return { code: 0, stdout: stdoutPayload, stderr: "" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.equal(commands[0].command, "ssh");
  assert.deepEqual(commands[0].args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.equal(commands[0].args[5], "true");
  assert.equal(commands[1].command, "scp");
  assert.deepEqual(commands[1].args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.equal(commands[2].command, "ssh");
  assert.deepEqual(commands[2].args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.match(commands[2].args[5], /ExecutionPolicy Bypass/);
  assert.equal(summary.status, "ok");
  assert.match(renderMsDevCdpRefresh(summary), /calendar\.events\.snapshot: status=ok items=1/);
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.notifications\.snapshot: status=ok items=1/);
  assert.match(renderMsDevCdpRefresh(summary), /slack\.notifications\.snapshot: status=auth_required items=0 authRequired=true/);
  const slackSnapshot = JSON.parse(await readFile(path.join(root, "snapshots", "slack", "notifications.snapshot.json"), "utf8"));
  assert.equal(slackSnapshot.status, "auth_required");
  const calendarSnapshot = JSON.parse(await readFile(path.join(root, "snapshots", "calendar", "events.snapshot.json"), "utf8"));
  assert.equal(calendarSnapshot.items[0].text, "Team standup, 09:00 to 09:30, Wednesday, May 13, By Ada, Busy");
  const outlookSnapshot = JSON.parse(await readFile(path.join(root, "snapshots", "outlook", "notifications.snapshot.json"), "utf8"));
  assert.equal(outlookSnapshot.items[0].url, "https://outlook.office.com/mail/id/1");
  assert.doesNotMatch(JSON.stringify(outlookSnapshot), /token=secret|auth=secret|#frag/);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev apphost ensure script targets a dedicated browser profile", () => {
  const script = buildMsDevAppHostPowerShell({ cdpPort: 9333, browser: "edge", urls: ["https://outlook.office.com/mail/"] });
  assert.match(script, /remote-debugging-port=\$CdpPort/);
  assert.match(script, /agent-utils-work-apphost/);
  assert.match(script, /Microsoft\\Edge\\Application\\msedge\.exe/);
  assert.match(script, /https:\/\/outlook\.office\.com\/mail\//);
});

test("ms-dev CDP refresh can ensure a dedicated apphost before extraction", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-cdp-apphost-${Date.now()}`), { recursive: true });
  const commands = [];
  const stdoutPayload = JSON.stringify({
    capturedAt: "2026-05-13T03:00:00Z",
    source: "ms-dev-chrome-cdp",
    cdpPort: 9224,
    results: [
      { app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [{ text: "Unread Ada Lovelace Project update", source: "Outlook Mail" }] } },
    ],
  });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    preflightAttempts: 0,
    scriptTransfer: "inline",
    ensureAppHost: true,
    exec: async (command, args) => {
      commands.push({ command, args });
      if (command !== "ssh") return { code: 1, stdout: "", stderr: "unexpected" };
      const remoteCommand = args[5] || "";
      if (/EncodedCommand/.test(remoteCommand)) {
        return { code: 0, stdout: JSON.stringify({ status: "ready", started: true, cdpReady: true, cdpPort: 9224, browser: "edge" }), stderr: "" };
      }
      if (/ExecutionPolicy Bypass -File/.test(remoteCommand)) {
        return { code: 0, stdout: stdoutPayload, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(commands.some((entry) => /EncodedCommand/.test(entry.args[5] || "")), true);
  assert.equal(commands.some((entry) => /printf %s/.test(entry.args[5] || "")), true);
  assert.equal(commands.some((entry) => /base64 -d/.test(entry.args[5] || "")), true);
  assert.equal(commands.some((entry) => /ExecutionPolicy Bypass -File/.test(entry.args[5] || "")), true);
  assert.equal(summary.appHost.status, "ready");
  assert.equal(summary.status, "ok");
  assert.match(renderMsDevCdpRefresh(summary), /appHost status=ready started=true cdpReady=true browser=edge/);
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.notifications\.snapshot: status=ok items=1/);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh suppresses noisy inferred from metadata", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-outlook-from-${Date.now()}`), { recursive: true });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [
        { text: "Unread Silvia Candiani, Satya Nadella Microsoft Daily Digest Tue 22:52 New posts from Microsoft ? ? ? ? ?", source: "Outlook Mail", from: "Microsoft ? ? ? ? ?" },
        { text: "Unread Ada Lovelace Project update", source: "Outlook Mail", from: "Ada Lovelace" },
      ] } }] }), stderr: "" };
    },
  });
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.notifications\.snapshot: status=ok items=2/);
  const snapshot = JSON.parse(await readFile(path.join(root, "snapshots", "outlook", "notifications.snapshot.json"), "utf8"));
  assert.equal(snapshot.items[0].from, undefined);
  assert.equal(snapshot.items[1].from, "Ada Lovelace");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh suppresses Outlook aggregate mail-list chrome", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-outlook-aggregate-${Date.now()}`), { recursive: true });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [
        { text: "Unread Collapsed Meeting Raveena Khemani GA Burn Down Daily Sync 10:02 C2 cross squad meeting cadence No conversations selected | ? Raveena Khemani ? GA Burn Down Daily Sync 10:02 C2 cross squad meeting cadence", source: "Outlook Mail" },
        { text: "? Today ? ? Raveena Khemani ? GA Burn Down Daily Sync 10:02 C2 cross squad meeting cadence MAM Hub C3 MAM Opener Town Hall Recap 00:04 Thank you", source: "Outlook Mail" },
      ] } }] }), stderr: "" };
    },
  });
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.notifications\.snapshot: status=ok items=1/);
  const snapshot = JSON.parse(await readFile(path.join(root, "snapshots", "outlook", "notifications.snapshot.json"), "utf8"));
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].text, "Unread Collapsed Meeting Raveena Khemani GA Burn Down Daily Sync 10:02 C2 cross squad meeting cadence");
  assert.doesNotMatch(JSON.stringify(snapshot), /No conversations selected|Today \?/);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh dedupes nested Outlook notification rows", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-outlook-dedupe-${Date.now()}`), { recursive: true });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [
        { text: "Unread Lorant Domokos in Teams Lorant Domokos mentioned M App (Clawpilot) Tue 21:48 M App (Clawpilot) Here's what's new", source: "Outlook Mail" },
        { text: "Lorant Domokos mentioned M App (Clawpilot)", source: "Outlook Mail" },
        { text: "Unread Ada Lovelace Project update", source: "Outlook Mail" },
      ] } }] }), stderr: "" };
    },
  });
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.notifications\.snapshot: status=ok items=2/);
  const snapshot = JSON.parse(await readFile(path.join(root, "snapshots", "outlook", "notifications.snapshot.json"), "utf8"));
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.items.some((item) => item.text === "Lorant Domokos mentioned M App (Clawpilot)"), false);
  assert.ok(snapshot.items.some((item) => item.text.includes("Unread Lorant Domokos in Teams")));
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh normalizes Teams notification badge rows", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-teams-${Date.now()}`), { recursive: true });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["teams"],
    actions: ["notifications.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "teams", action: "notifications.snapshot", status: "ok", result: { title: "Microsoft Teams", items: [
        { text: "Chat (Ctrl+Shift+1) | 13 13 new notifications", source: "Teams" },
        { text: "Actions for new message | has context menu", source: "Teams" },
        { text: "13 R1 13 13 new notifications New missed calls Has context menu Message List has context menu has context menu", source: "Teams" },
        { text: "Chat (Ctrl+Shift+1)", source: "Teams" },
      ] } }] }), stderr: "" };
    },
  });
  assert.match(renderMsDevCdpRefresh(summary), /teams\.notifications\.snapshot: status=ok items=1/);
  const snapshot = JSON.parse(await readFile(path.join(root, "snapshots", "teams", "notifications.snapshot.json"), "utf8"));
  assert.equal(snapshot.items.length, 1);
  assert.equal(snapshot.items[0].text, "Teams reports 13 new notifications");
  assert.equal(snapshot.items[0].source, "Teams");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh preserves snapshots when all live rows are filtered as chrome", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-filtered-${Date.now()}`), { recursive: true });
  const calendarDir = path.join(root, "snapshots", "calendar");
  await mkdir(calendarDir, { recursive: true });
  await writeFile(path.join(calendarDir, "events.snapshot.json"), JSON.stringify({ app: "calendar", kind: "events.snapshot", status: "ok", capturedAt: "2026-05-13T02:00:00Z", count: 1, items: [{ text: "preserve event" }] }), "utf8");
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["calendar"],
    actions: ["events.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "calendar", action: "events.snapshot", status: "ok", result: { title: "Calendar", items: [{ text: "13, Wednesday, today | 13" }] } }] }), stderr: "" };
    },
  });
  assert.equal(summary.snapshots[0].status, "filtered_empty");
  assert.equal(summary.snapshots[0].skippedWrite, true);
  assert.match(renderMsDevCdpRefresh(summary), /ms-dev CDP refresh status=ok .* snapshots=1 snapshotStatuses=filtered_empty=1 skippedWrite=1/);
  assert.match(renderMsDevCdpRefresh(summary), /calendar\.events\.snapshot: status=filtered_empty items=0 skippedWrite=true/);
  const preserved = JSON.parse(await readFile(path.join(calendarDir, "events.snapshot.json"), "utf8"));
  assert.equal(preserved.items[0].text, "preserve event");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh preserves non-empty snapshots on raw-empty results", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-raw-empty-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "calendar.snapshot.json"), JSON.stringify({ app: "outlook", kind: "calendar.snapshot", status: "ok", capturedAt: "2026-05-13T02:00:00Z", count: 1, items: [{ text: "keep calendar event" }] }), "utf8");
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["calendar.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "calendar.snapshot", status: "ok", result: { title: "Outlook Calendar", items: [] } }] }), stderr: "" };
    },
  });
  assert.equal(summary.snapshots[0].status, "raw_empty");
  assert.equal(summary.snapshots[0].skippedWrite, true);
  assert.equal(summary.snapshots[0].preservedCount, 1);
  assert.match(renderMsDevCdpRefresh(summary), /ms-dev CDP refresh status=ok .* snapshots=1 snapshotStatuses=raw_empty=1 skippedWrite=1/);
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.calendar\.snapshot: status=raw_empty items=0 skippedWrite=true/);
  const preserved = JSON.parse(await readFile(path.join(outlookDir, "calendar.snapshot.json"), "utf8"));
  assert.equal(preserved.items[0].text, "keep calendar event");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh records bridge copy failures in latest manifest", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-copy-fail-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "notifications.snapshot.json"), JSON.stringify({ app: "outlook", kind: "notifications.snapshot", status: "ok", capturedAt: "2026-05-13T02:00:00Z", count: 1, items: [{ text: "keep mail" }] }), "utf8");
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    exec: async (command, args) => {
      if (command === "ssh" && args.at(-1) === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "scp") return { code: 255, stdout: "", stderr: "ssh: connect to host 100.66.53.117 port 22: Connection timed out" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.equal(summary.status, "copy_failed");
  assert.equal(summary.failed[0].status, "copy_failed");
  assert.equal(summary.failed[0].errorKind, "connect_timeout");
  assert.match(summary.failed[0].error, /connect to host \[ssh-target\] port 22/);
  assert.doesNotMatch(summary.failed[0].error, /ms-dev|100\.66\.53\.117/);
  assert.match(renderMsDevCdpRefresh(summary), /ms-dev CDP refresh status=copy_failed .* failed=1 failureErrorKinds=connect_timeout=1/);
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.notifications\.snapshot: status=copy_failed errorKind=connect_timeout/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.status, "copy_failed");
  assert.equal(manifest.failed[0].app, "outlook");
  assert.equal(manifest.failed[0].errorKind, "connect_timeout");
  assert.equal("stdout" in manifest, false);
  assert.equal("stderr" in manifest, false);
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, now: new Date(manifest.capturedAt) });
  assert.equal(index.totals.failedRefresh, 1);
  assert.deepEqual(index.totals.failedRefreshStatuses, { copy_failed: 1 });
  assert.deepEqual(index.totals.failedRefreshErrorKinds, { connect_timeout: 1 });
  assert.match(renderWorkBriefingIndex(index), /failedRefresh=1 failedRefreshStatuses=copy_failed=1 failedRefreshErrorKinds=connect_timeout=1/);
  assert.match(renderWorkBriefingIndex(index), /outlook\.notifications\.snapshot: status=ok freshness=stale age=\d+m items=1 latestRefresh=copy_failed\/0m\/connect_timeout/);
  const preserved = JSON.parse(await readFile(path.join(outlookDir, "notifications.snapshot.json"), "utf8"));
  assert.equal(preserved.items[0].text, "keep mail");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh fails fast when SSH preflight fails", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-preflight-fail-${Date.now()}`), { recursive: true });
  const commands = [];
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    sshConnectTimeoutSeconds: 3,
    timeoutMs: 60_000,
    exec: async (command, args, options) => {
      commands.push({ command, args, options });
      return { code: 255, stdout: "", stderr: "Connection timed out during banner exchange" };
    },
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "ssh");
  assert.equal(commands[0].args.at(-1), "true");
  assert.equal(commands[0].options.timeout, 25000);
  assert.equal(summary.status, "preflight_failed");
  assert.equal(summary.failed[0].status, "preflight_failed");
  assert.equal(summary.failed[0].errorKind, "connect_timeout");
  assert.match(renderMsDevCdpRefresh(summary), /failed=1 failureErrorKinds=connect_timeout=1/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.status, "preflight_failed");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, now: new Date(manifest.capturedAt) });
  assert.deepEqual(index.totals.failedRefreshStatuses, { preflight_failed: 1 });
  assert.match(renderWorkBriefingIndex(index), /failedRefresh=1 failedRefreshStatuses=preflight_failed=1/);
  assert.equal(manifest.config.preflightAttempts, 1);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh retries flapping SSH preflight before copy", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-preflight-retry-${Date.now()}`), { recursive: true });
  const commands = [];
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    preflightAttempts: 2,
    exec: async (command, args, options) => {
      commands.push({ command, args, options });
      if (command === "ssh" && args.at(-1) === "true" && commands.filter((entry) => entry.command === "ssh" && entry.args.at(-1) === "true").length === 1) {
        return { code: 255, stdout: "", stderr: "Connection timed out during banner exchange" };
      }
      if (command === "ssh" && args.at(-1) === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      if (command === "ssh") {
        return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [{ text: "Important mail", source: "Outlook Mail" }] } }] }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.deepEqual(commands.map((entry) => entry.command), ["ssh", "ssh", "scp", "ssh"]);
  assert.equal(commands[0].args.at(-1), "true");
  assert.equal(commands[1].args.at(-1), "true");
  assert.equal(summary.status, "ok");
  assert.equal(summary.snapshots[0].status, "ok");
  assert.match(renderMsDevCdpRefresh(summary), /preflightAttempts=2/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.config.preflightAttempts, 2);
  assert.equal(manifest.failed.length, 0);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh can skip SSH preflight and try copy/run directly", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-preflight-skip-${Date.now()}`), { recursive: true });
  const commands = [];
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    preflightAttempts: 0,
    exec: async (command, args) => {
      commands.push({ command, args });
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      if (command === "ssh") {
        return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [{ text: "Important mail", source: "Outlook Mail" }] } }] }), stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.deepEqual(commands.map((entry) => entry.command), ["scp", "ssh"]);
  assert.equal(commands.some((entry) => entry.command === "ssh" && entry.args.at(-1) === "true"), false);
  assert.equal(summary.status, "ok");
  assert.match(renderMsDevCdpRefresh(summary), /preflightAttempts=0/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.config.preflightAttempts, 0);
  assert.equal(manifest.snapshots[0].status, "ok");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh can run script inline without scp", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-inline-${Date.now()}`), { recursive: true });
  const commands = [];
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    preflightAttempts: 0,
    scriptTransfer: "inline",
    exec: async (command, args) => {
      commands.push({ command, args });
      if (command === "ssh") {
        const remote = args.at(-1);
        if (/ExecutionPolicy Bypass -File/.test(remote)) {
          return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "ok", result: { title: "Mail - Outlook", items: [{ text: "Important mail", source: "Outlook Mail" }] } }] }), stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "unexpected" };
    },
  });
  assert.equal(commands.some((entry) => entry.command === "scp"), false);
  assert.equal(commands.every((entry) => entry.command === "ssh"), true);
  assert.match(commands[0].args.at(-1), /: > '\/tmp\/agent-utils-msdev-cdp-refresh\.ps1\.b64'/);
  assert.ok(commands.some((entry) => /printf %s/.test(entry.args.at(-1)) && /\.ps1\.b64'/.test(entry.args.at(-1))));
  assert.ok(commands.some((entry) => /base64 -d/.test(entry.args.at(-1)) && /agent-utils-msdev-cdp-refresh\.ps1/.test(entry.args.at(-1))));
  assert.match(commands.at(-1).args.at(-1), /ExecutionPolicy Bypass -File/);
  assert.doesNotMatch(commands.at(-1).args.at(-1), /-EncodedCommand/);
  assert.equal(summary.status, "ok");
  assert.match(renderMsDevCdpRefresh(summary), /scriptTransfer=inline/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.config.preflightAttempts, 0);
  assert.equal(manifest.config.scriptTransfer, "inline");
  assert.equal(manifest.snapshots[0].status, "ok");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh classifies process-level command timeouts", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-run-timeout-${Date.now()}`), { recursive: true });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["calendar.snapshot"],
    timeoutMs: 1234,
    exec: async (command, args) => {
      if (command === "ssh" && args.at(-1) === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return {
        code: 1,
        stdout: "",
        stderr: "",
        message: "Command failed: scp -o BatchMode=yes /home/harry/.local/state/agent-utils/app-automation/bridge/ms-dev-cdp-refresh.ps1 test-user@ms-dev:/tmp/agent-utils-msdev-cdp-refresh.ps1",
        signal: "SIGTERM",
        killed: true,
        timedOut: true,
        timeoutMs: 1234,
      };
    },
  });
  assert.equal(summary.status, "run_failed");
  assert.equal(summary.failed[0].status, "run_failed");
  assert.equal(summary.failed[0].errorKind, "command_timeout");
  assert.match(summary.failed[0].error, /signal=SIGTERM/);
  assert.match(summary.failed[0].error, /killed=true/);
  assert.doesNotMatch(summary.failed[0].error, /scp -o|\/home\/harry|test-user@ms-dev|\/tmp\/agent-utils/);
  const rendered = renderMsDevCdpRefresh({ ...summary, manifestPath: "/home/harry/.local/state/agent-utils/app-automation/bridge/latest-ms-dev-cdp-refresh.json" });
  assert.match(rendered, /failureErrorKinds=command_timeout=1/);
  assert.match(rendered, /manifest=\[local-path\]/);
  assert.doesNotMatch(rendered, /\/home\/harry|test-user@ms-dev|scp -o/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.failed[0].errorKind, "command_timeout");
  assert.equal("stdout" in manifest, false);
  assert.equal("stderr" in manifest, false);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh preserves per-target failure stage diagnostics", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-stage-${Date.now()}`), { recursive: true });
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["calendar.snapshot"],
    exec: async (command, args) => {
      if (command === "ssh" && args.at(-1) === "true") return { code: 0, stdout: "", stderr: "" };
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "calendar.snapshot", status: "extract_failed", stage: "runtime_evaluate", error: "runtime_evaluate_timeout" }] }), stderr: "" };
    },
  });
  assert.equal(summary.status, "extract_failed");
  assert.equal(summary.failed[0].stage, "runtime_evaluate");
  assert.equal(summary.failed[0].error, "runtime_evaluate_timeout");
  assert.match(renderMsDevCdpRefresh(summary), /outlook\.calendar\.snapshot: status=extract_failed stage=runtime_evaluate error=runtime_evaluate_timeout/);
  const manifest = JSON.parse(await readFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), "utf8"));
  assert.equal(manifest.failed[0].stage, "runtime_evaluate");
  await rm(root, { recursive: true, force: true });
});

test("app automation doctor summarizes latest ms-dev refresh manifest", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-doctor-msdev-${Date.now()}`), { recursive: true });
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await writeFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), JSON.stringify({
    status: "copy_failed",
    capturedAt: "2026-05-13T03:00:00Z",
    config: { sshTargetConfigured: true, sshTarget: "test-user@ms-dev", cdpPort: 9224, sshConnectTimeoutSeconds: 5, preflightAttempts: 0, scriptTransfer: "inline" },
    snapshots: [],
    failed: [
      { app: "slack", action: "notifications.snapshot", status: "copy_failed", errorKind: "connect_timeout" },
      { app: "outlook", action: "notifications.snapshot", status: "copy_failed", errorKind: "connect_timeout" },
    ],
  }), "utf8");
  const summary = await readLatestMsDevRefreshSummary(root, { now: new Date("2026-05-13T03:05:00Z") });
  assert.equal(summary.status, "copy_failed");
  assert.equal(summary.ageMinutes, 5);
  assert.deepEqual(summary.failureStatuses, { copy_failed: 2 });
  assert.deepEqual(summary.failureErrorKinds, { connect_timeout: 2 });
  assert.equal(summary.sshTargetConfigured, true);
  assert.equal(summary.cdpPort, 9224);
  assert.equal(summary.sshConnectTimeoutSeconds, 5);
  assert.equal(summary.preflightAttempts, 0);
  assert.equal(summary.scriptTransfer, "inline");
  const rendered = renderDoctorReport({
    rootSummary: { root, exists: true },
    catalog: { apps: [{ id: "slack" }], external: {} },
    playwrightCli: "playwright-cli",
    tendrilBridge: { command: "tendril", remote: null, wslTunnel: false },
    actionDiagnostics: [],
    msDevCdpRefresh: summary,
  });
  assert.match(rendered, /app automation doctor stateRoot=\[state-root\] exists=true/);
  assert.match(rendered, /msDevCdpRefresh=copy_failed age=5m snapshots=0 failed=2 failureStatuses=copy_failed=2 failureErrorKinds=connect_timeout=2 sshTargetConfigured=true cdpPort=9224 connectTimeout=5s preflightAttempts=0 scriptTransfer=inline/);
  assert.doesNotMatch(rendered, /test-user@ms-dev/);
  assert.doesNotMatch(rendered, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh does not overwrite snapshots on extraction failure", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-fail-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "notifications.snapshot.json"), JSON.stringify({ app: "outlook", kind: "notifications.snapshot", status: "ok", capturedAt: "2026-05-13T02:00:00Z", count: 1, items: [{ text: "keep me" }] }), "utf8");
  const summary = await runMsDevCdpRefresh({
    root,
    sshTarget: "test-user@ms-dev",
    apps: ["outlook"],
    actions: ["notifications.snapshot"],
    exec: async (command) => {
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:00:00Z", source: "ms-dev-chrome-cdp", results: [{ app: "outlook", action: "notifications.snapshot", status: "extract_failed", error: "boom" }] }), stderr: "" };
    },
  });
  assert.equal(summary.status, "extract_failed");
  assert.match(renderMsDevCdpRefresh(summary), /failed=1/);
  const preserved = JSON.parse(await readFile(path.join(outlookDir, "notifications.snapshot.json"), "utf8"));
  assert.equal(preserved.items[0].text, "keep me");
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP refresh honors env configuration when params are omitted", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-msdev-env-${Date.now()}`), { recursive: true });
  const commands = [];
  const summary = await runMsDevCdpRefresh({
    root,
    env: { APP_AUTOMATION_MSDEV_SSH_TARGET: "env-user@ms-dev", APP_AUTOMATION_MSDEV_CDP_PORT: "9333", APP_AUTOMATION_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS: "7" },
    exec: async (command, args) => {
      commands.push({ command, args });
      if (command === "scp") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: JSON.stringify({ capturedAt: "2026-05-13T03:01:00Z", source: "ms-dev-chrome-cdp", cdpPort: 9333, results: [] }), stderr: "" };
    },
  });
  assert.equal(commands[0].command, "ssh");
  assert.equal(commands[0].args[3], "ConnectTimeout=7");
  assert.equal(commands[0].args[4], "env-user@ms-dev");
  assert.equal(commands[0].args[5], "true");
  assert.equal(commands[1].command, "scp");
  assert.equal(commands[1].args[3], "ConnectTimeout=7");
  assert.equal(commands[1].args[5].startsWith("env-user@ms-dev:"), true);
  assert.equal(commands[2].command, "ssh");
  assert.equal(commands[2].args[3], "ConnectTimeout=7");
  assert.equal(commands[2].args[4], "env-user@ms-dev");
  assert.equal(summary.cdpPort, 9333);
  await rm(root, { recursive: true, force: true });
});

test("ms-dev CDP PowerShell script filters common work-app navigation chrome", () => {
  const script = buildMsDevCdpPowerShell({ cdpPort: 9224 });
  assert.match(script, /ribbon/);
  assert.match(script, /move \[&\] delete/);
  assert.match(script, /my calendars/);
  assert.match(script, /switch to calendar/);
  assert.match(script, /enhance outlook with apps/);
  assert.match(script, /viva insights/);
});

test("ms-dev CDP PowerShell script includes Slack desktop unread fallback", () => {
  const script = buildMsDevCdpPowerShell({ cdpPort: 9224 });
  assert.match(script, /Get-SlackDesktopObservation/);
  assert.match(script, /Slack desktop reports/);
  assert.match(script, /\(\\d\{1,4\}\)\\s\+new\\s\+items\?/);
  assert.match(script, /slack-desktop-window/);
});

test("ms-dev CDP PowerShell script includes FIFO tab cleanup for created targets", () => {
  const script = buildMsDevCdpPowerShell({ cdpPort: 9224, tabGcKeepTicks: 2 });
  assert.match(script, /\$TabGcEnabled = \$true/);
  assert.match(script, /\$TabGcKeepTicks = 2/);
  assert.match(script, /ms-dev-cdp-tab-runs\.json/);
  assert.match(script, /Invoke-TabGc/);
  assert.match(script, /Close-CdpTarget/);
  assert.match(script, /Select-Object -Last \$TabGcKeepTicks/);
  assert.match(script, /\$createdTargets \+= \[pscustomobject\]@\{ id=\$target\.id; app=\$targetSpec\.app/);
  assert.match(script, /tabGc=\$tabGc/);
});

test("ms-dev CDP PowerShell script uses configured port and no raw secrets", () => {
  const script = buildMsDevCdpPowerShell({ cdpPort: 9333, targets: [{ app: "outlook", action: "notifications.snapshot", url: "https://outlook.office.com/mail/?token=secret#frag" }] });
  assert.match(script, /\$CdpPort = 9333/);
  assert.match(script, /ExecutionPolicy|Invoke-CdpJson/);
  assert.match(script, /replace\(\/\\s\+\/g/);
  assert.match(script, /text\.match\(\/\\b/);
  assert.match(script, /parsed\.search = ''/);
  assert.match(script, /const containers = \['\[role="row"\]'/);
  assert.match(script, /hrefs\.length < 8/);
  assert.match(script, /maxAnchors = 12/);
  assert.match(script, /textLength > 2500/);
  assert.doesNotMatch(script, /const containers = \[[^\n]+data-testid/);
  assert.doesNotMatch(script, /const containers = \[[^\n]+data-tid/);
  assert.match(script, /TimeoutSec 4/);
  assert.match(script, /Start-Sleep -Seconds 3/);
  assert.match(script, /stage='new_target'/);
  assert.match(script, /stage='runtime_evaluate'/);
});

test("work briefing suppresses Outlook aggregate mail-list chrome from preserved snapshots", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-outlook-aggregate-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "notifications.snapshot.json"), JSON.stringify({
    app: "outlook",
    kind: "notifications.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T01:00:00Z",
    count: 2,
    items: [
      { text: "Unread Collapsed Meeting Raveena Khemani GA Burn Down Daily Sync 10:02 C2 cross squad meeting cadence No conversations selected | ? Raveena Khemani ? GA Burn Down Daily Sync 10:02", source: "Outlook Mail" },
      { text: "? Today ? ? Raveena Khemani ? GA Burn Down Daily Sync 10:02 C2 cross squad meeting cadence MAM Hub C3 MAM Opener Town Hall Recap 00:04", source: "Outlook Mail" },
    ],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, sampleLimit: 5, now: new Date("2026-05-13T02:00:00Z") });
  const rendered = renderWorkBriefingIndex(index);
  const entry = index.entries.find((item) => item.app === "outlook" && item.action === "notifications.snapshot");
  assert.equal(entry.itemCount, 1);
  assert.equal(entry.rawItemCount, 2);
  assert.equal(entry.hiddenChromeCount, 1);
  assert.match(rendered, /GA Burn Down Daily Sync/);
  assert.doesNotMatch(rendered, /No conversations selected|\? Today \?/);
  await rm(root, { recursive: true, force: true });
});

test("work briefing suppresses Outlook Add-ins chrome samples from stale snapshots", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-addins-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "notifications.snapshot.json"), JSON.stringify({
    app: "outlook",
    kind: "notifications.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T01:00:00Z",
    count: 2,
    items: [
      { text: "Add-ins | ?Enhance Outlook with apps.Viva InsightsInsights. This version applies to Office 365 Enterprise E5", source: "Outlook Mail" },
      { text: "Unread mail from Ada", source: "Outlook Mail", from: "Ada" },
    ],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, sampleLimit: 2, now: new Date("2026-05-13T02:00:00Z") });
  const rendered = renderWorkBriefingIndex(index);
  assert.equal(index.totals.items, 1);
  assert.match(rendered, /outlook\.notifications\.snapshot: status=ok freshness=stale age=60m items=1 rawItems=2 hiddenChrome=1/);
  assert.doesNotMatch(rendered, /Add-ins|Viva Insights/);
  assert.match(rendered, /Unread mail from Ada/);
  await rm(root, { recursive: true, force: true });
});

test("work briefing suppresses Teams context-menu chrome while preserving badge counts", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-teams-chrome-${Date.now()}`), { recursive: true });
  const teamsDir = path.join(root, "snapshots", "teams");
  await mkdir(teamsDir, { recursive: true });
  await writeFile(path.join(teamsDir, "notifications.snapshot.json"), JSON.stringify({
    app: "teams",
    kind: "notifications.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T02:00:00Z",
    count: 3,
    items: [
      { text: "Teams reports 13 new notifications", source: "Teams" },
      { text: "Actions for new message | has context menu", source: "Teams" },
      { text: "13 R1 13 13 new notifications New missed calls Has context menu Message List has context menu has context menu", source: "Teams" },
    ],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["teams"], staleAfterMinutes: 15, sampleLimit: 5, now: new Date("2026-05-13T02:05:00Z") });
  const rendered = renderWorkBriefingIndex(index);
  const entry = index.entries.find((item) => item.app === "teams" && item.action === "notifications.snapshot");
  assert.equal(entry.itemCount, 1);
  assert.equal(entry.rawItemCount, 3);
  assert.equal(entry.hiddenChromeCount, 2);
  assert.match(rendered, /teams\.notifications\.snapshot: status=ok freshness=fresh age=5m items=1 rawItems=3 hiddenChrome=2/);
  assert.match(rendered, /Teams reports 13 new notifications/);
  assert.doesNotMatch(rendered, /Actions for new message|Message List has context menu/);
  await rm(root, { recursive: true, force: true });
});

test("work briefing index summarizes bounded app snapshot state", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  const slackDir = path.join(root, "snapshots", "slack");
  await mkdir(outlookDir, { recursive: true });
  await mkdir(slackDir, { recursive: true });
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await writeFile(path.join(outlookDir, "notifications.snapshot.json"), JSON.stringify({
    app: "outlook",
    kind: "notifications.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T02:00:00Z",
    count: 2,
    items: [
      { text: "Important mail from Ada", source: "Outlook Mail", from: "Ada", time: "09:00", url: "https://outlook.office.com/mail/id/1" },
      { text: "Flagged mail from Ops", source: "Outlook Mail", from: "Ops" },
    ],
  }), "utf8");
  await writeFile(path.join(slackDir, "notifications.snapshot.json"), JSON.stringify({
    app: "slack",
    kind: "notifications.snapshot",
    status: "auth_required",
    authRequired: true,
    capturedAt: "2026-05-13T01:30:00Z",
    count: 0,
    items: [],
  }), "utf8");
  await writeFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), JSON.stringify({
    capturedAt: "2026-05-13T02:04:00Z",
    source: "ms-dev-chrome-cdp",
    snapshots: [],
    failed: [{ app: "outlook", action: "calendar.snapshot", status: "extract_failed", error: "timeout" }],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook", "slack"], staleAfterMinutes: 15, sampleLimit: 1, now: new Date("2026-05-13T02:05:00Z") });
  assert.equal(index.totals.actions, 3);
  assert.equal(index.totals.fresh, 1);
  assert.equal(index.totals.stale, 1);
  assert.equal(index.totals.authRequired, 1);
  assert.equal(index.entries.find((entry) => entry.app === "outlook").samples.length, 1);
  assert.match(renderWorkBriefingIndex(index), /index=\[state-root\]\/indexes\/work-briefing\.json/);
  assert.doesNotMatch(renderWorkBriefingIndex(index), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(renderWorkBriefingIndex(index), /outlook\.notifications\.snapshot: status=ok freshness=fresh age=5m items=2/);
  assert.match(renderWorkBriefingIndex(index), /slack\.notifications\.snapshot: status=auth_required freshness=stale age=35m items=0 authRequired=true/);
  assert.match(renderWorkBriefingIndex(index), /outlook\.calendar\.snapshot: status=missing freshness=unknown items=0 latestRefresh=extract_failed\/1m/);
  assert.equal(index.entries.find((entry) => entry.action === "calendar.snapshot").latestRefresh.status, "extract_failed");
  const persisted = JSON.parse(await readFile(path.join(root, "indexes", "work-briefing.json"), "utf8"));
  assert.equal(persisted.totals.items, 2);
  assert.equal(persisted.totals.missing, 1);
  await rm(root, { recursive: true, force: true });
});

test("work briefing does not treat clock times as today's calendar date", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-time-date-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "calendar.snapshot.json"), JSON.stringify({
    app: "outlook",
    kind: "calendar.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T02:00:00Z",
    count: 3,
    items: [
      { text: "Monday all hands, all day event, Monday, May 11, 2026, By Ada" },
      { text: "Monday sync, 13:00 to 13:30, Monday, May 11, 2026, By Ada" },
      { text: "Wednesday standup, 09:00 to 09:30, Wednesday, May 13, 2026, By Ada" },
    ],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, sampleLimit: 2, now: new Date("2026-05-13T02:05:00Z") });
  const entry = index.entries.find((item) => item.action === "calendar.snapshot");
  assert.equal(entry.samples[0].text, "Wednesday standup, 09:00 to 09:30, Wednesday, May 13, 2026, By Ada");
  assert.equal(entry.samples.length, 1);
  await rm(root, { recursive: true, force: true });
});

test("work briefing prioritizes today's calendar rows in samples", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-today-${Date.now()}`), { recursive: true });
  const outlookDir = path.join(root, "snapshots", "outlook");
  await mkdir(outlookDir, { recursive: true });
  await writeFile(path.join(outlookDir, "calendar.snapshot.json"), JSON.stringify({
    app: "outlook",
    kind: "calendar.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T02:00:00Z",
    count: 3,
    items: [
      { text: "Monday planning, 10:00 to 10:30, Monday, May 11, 2026, By Ada" },
      { text: "Wednesday standup, 09:00 to 09:30, Wednesday, May 13, 2026, By Ada" },
      { text: "Friday wrap, 16:00 to 16:30, Friday, May 15, 2026, By Ada" },
    ],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, sampleLimit: 1, now: new Date("2026-05-13T02:05:00Z") });
  const entry = index.entries.find((item) => item.action === "calendar.snapshot");
  assert.equal(entry.samples[0].text, "Wednesday standup, 09:00 to 09:30, Wednesday, May 13, 2026, By Ada");
  await rm(root, { recursive: true, force: true });
});

test("work briefing shows raw-empty skipped-write refresh attempts", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-raw-empty-${Date.now()}`), { recursive: true });
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await mkdir(path.join(root, "snapshots", "outlook"), { recursive: true });
  await writeFile(path.join(root, "snapshots", "outlook", "calendar.snapshot.json"), JSON.stringify({
    app: "outlook",
    kind: "calendar.snapshot",
    status: "ok",
    capturedAt: "2026-05-13T01:30:00Z",
    count: 1,
    items: [{ text: "preserved event" }],
  }), "utf8");
  await writeFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), JSON.stringify({
    capturedAt: "2026-05-13T02:04:00Z",
    source: "ms-dev-chrome-cdp",
    snapshots: [{ app: "outlook", action: "calendar.snapshot", status: "raw_empty", skippedWrite: true, preservedCount: 1, reason: "empty rows" }],
    failed: [],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["outlook"], staleAfterMinutes: 15, now: new Date("2026-05-13T02:05:00Z") });
  assert.equal(index.totals.preservedStale, 1);
  assert.equal(index.totals.effectiveStale, 0);
  assert.match(renderWorkBriefingIndex(index), /outlook\.calendar\.snapshot: status=ok freshness=stale age=35m items=1 latestRefresh=raw_empty\/1m\/skippedWrite/);
  await rm(root, { recursive: true, force: true });
});

test("work briefing shows filtered-empty skipped-write refresh attempts", async () => {
  const root = await mkdir(path.join(os.tmpdir(), `app-briefing-filtered-${Date.now()}`), { recursive: true });
  await mkdir(path.join(root, "bridge"), { recursive: true });
  await mkdir(path.join(root, "snapshots", "calendar"), { recursive: true });
  await writeFile(path.join(root, "snapshots", "calendar", "events.snapshot.json"), JSON.stringify({
    app: "calendar",
    kind: "events.snapshot",
    status: "empty",
    capturedAt: "2026-05-13T01:30:00Z",
    count: 0,
    items: [],
  }), "utf8");
  await writeFile(path.join(root, "bridge", "latest-ms-dev-cdp-refresh.json"), JSON.stringify({
    capturedAt: "2026-05-13T02:04:00Z",
    source: "ms-dev-chrome-cdp",
    snapshots: [{ app: "calendar", action: "events.snapshot", status: "filtered_empty", skippedWrite: true, rawCount: 1, reason: "all rows filtered" }],
    failed: [],
  }), "utf8");
  const index = await buildWorkBriefingIndex({ root, apps: ["calendar"], staleAfterMinutes: 15, now: new Date("2026-05-13T02:05:00Z") });
  assert.equal(index.totals.preservedStale, 1);
  assert.equal(index.totals.effectiveStale, 0);
  assert.equal(index.totals.filteredEmptyRefresh, 1);
  assert.match(renderWorkBriefingIndex(index), /stale=1 preservedStale=1 effectiveStale=0 filteredEmptyRefresh=1/);
  assert.match(renderWorkBriefingIndex(index), /calendar\.events\.snapshot: status=empty freshness=stale age=35m items=0 latestRefresh=filtered_empty\/1m\/skippedWrite/);
  assert.equal(index.entries[0].latestRefresh.rawCount, 1);
  await rm(root, { recursive: true, force: true });
});

test("personal automation status checks gws auth without exposing raw account secrets", async () => {
  const gws = await checkGwsStatus({
    exec: async () => ({
      code: 0,
      stdout: 'Using keyring backend: file\n{"auth_method":"oauth2","user":"harryaskham@gmail.com","token_valid":true,"has_refresh_token":true,"scopes":["https://www.googleapis.com/auth/calendar","https://www.googleapis.com/auth/gmail.modify"]}',
      stderr: "",
    }),
  });
  assert.equal(gws.status, "ok");
  assert.equal(gws.authenticated, true);
  assert.equal(gws.user, "h***@gmail.com");
  assert.equal(gws.userDomain, "gmail.com");
  assert.deepEqual(gws.scopes, { gmail: true, calendar: true, tasks: false, drive: false });
  const rendered = renderPersonalAutomationStatus({ gws, todo: { exists: true, displayPath: "~/org/todo.org", timelyCount: 0, timelyItems: [] } });
  assert.match(rendered, /personalAutomation gws=ok authenticated=true userDomain=gmail\.com scopes=gmail,calendar/);
  assert.doesNotMatch(rendered, /harryaskham@gmail\.com/);
});

test("personal automation status can check gws auth on ms-dev over ssh", async () => {
  const commands = [];
  const gws = await checkRemoteGwsStatus({
    sshTarget: "ms-dev",
    exec: async (command, args) => {
      commands.push({ command, args });
      return { code: 0, stdout: '{"auth_method":"oauth2","user":"harryaskham@gmail.com","token_valid":true,"scopes":["https://www.googleapis.com/auth/calendar"]}', stderr: "" };
    },
  });
  assert.equal(commands[0].command, "ssh");
  assert.equal(commands[0].args[3], "ConnectTimeout=10");
  assert.equal(commands[0].args[4], "ms-dev");
  assert.equal(commands[0].args[5], "'gws' auth status");
  assert.equal(gws.host, "ms-dev");
  assert.equal(gws.authenticated, true);
  assert.match(renderPersonalAutomationStatus({ gws: { status: "ok" }, msDevGws: gws }), /msDevGws=ok authenticated=true userDomain=gmail\.com scopes=calendar/);
});

test("personal org todo parser returns timely open items only", () => {
  const items = parseOrgTodoTimelyItems(`* TODO due tomorrow\nDEADLINE: <2026-05-18 Mon 09:00>\n* DONE old done\nSCHEDULED: <2026-05-18 Mon>\n* NEXT future item\nSCHEDULED: <2026-05-24 Sun>\n* TODO too far\nDEADLINE: <2026-06-30 Tue>`, { now: new Date("2026-05-17T12:00:00Z"), horizonDays: 7, lookbackDays: 1 });
  assert.deepEqual(items.map((item) => item.title), ["due tomorrow", "future item"]);
  assert.equal(items[0].todoState, "TODO");
  assert.equal(items[1].todoState, "NEXT");
});

test("extension is packaged and exposes list, doctor, overview, plan, run, open bundle, refresh, bundle, one-shot, snapshot, status tools plus /tendril-app", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../extensions/app-automation.js", import.meta.url), "utf8");
  const doctorSource = await readFile(new URL("../extensions/app-automation/doctor.js", import.meta.url), "utf8");
  const combinedSource = `${source}\n${doctorSource}`;

  assert.ok(packageJson.pi.extensions.includes("./extensions/app-automation.js"));
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_list`/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_doctor`/);
  assert.match(source, /DEFAULT_DOCTOR_ACTIONS/);
  assert.match(source, /renderDoctorReport/);
  assert.match(source, /tendrilCommandSummary/);
  assert.match(combinedSource, /tendrilBridge command=/);
  assert.match(source, /probeTendrilBridge/);
  assert.match(combinedSource, /tendrilProbe=/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_overview`/);
  assert.match(source, /renderWorkAppOverview/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_personal_status`/);
  assert.match(source, /checkGwsStatus/);
  assert.match(source, /checkRemoteGwsStatus/);
  assert.match(source, /checkPersonalTodoStatus/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_msdev_cdp_refresh`/);
  assert.match(source, /sshConnectTimeoutSeconds/);
  assert.match(source, /preflightAttempts/);
  assert.match(source, /scriptTransfer/);
  assert.match(source, /tabGc/);
  assert.match(source, /tabGcKeepTicks/);
  assert.match(source, /APP_AUTOMATION_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS/);
  assert.match(combinedSource, /APP_AUTOMATION_MSDEV_PREFLIGHT_ATTEMPTS/);
  assert.match(combinedSource, /APP_AUTOMATION_MSDEV_SCRIPT_TRANSFER/);
  assert.match(source, /runMsDevCdpRefresh/);
  assert.match(source, /name: `\$\{TOOL_PREFIX\}_work_briefing`/);
  assert.match(source, /buildWorkBriefingIndex/);
  assert.match(source, /renderWorkBriefingIndex/);
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
  assert.match(source, /words\[0\] === "briefing"/);
  assert.match(source, /words\[0\] === "links"/);
  assert.match(source, /collectSnapshotLinks/);
  assert.match(source, /all/);
  assert.match(source, /query: Type\.Optional/);
  assert.match(source, /source: Type\.Optional/);
  assert.match(source, /from: Type\.Optional/);
  assert.match(source, /time: Type\.Optional/);
  assert.match(source, /host: Type\.Optional/);
  assert.match(source, /kind: Type\.Optional/);
  assert.match(source, /aliases like events\/notifications\/calendar\/mail\/chat\/mentions\/meetings/);
  assert.match(source, /parseLinkCommandArgs/);
  assert.match(source, /parseOverviewCommandArgs/);
  assert.match(source, /linkFreshness/);
  assert.match(source, /linkKind/);
  assert.match(source, /linkQuery/);
  assert.match(source, /linkSource/);
  assert.match(source, /linkFrom/);
  assert.match(source, /linkTime/);
  assert.match(source, /linkHost/);
  assert.match(source, /linkSort/);
  assert.match(source, /freshness: Type\.Optional/);
  assert.match(source, /sort: Type\.Optional/);
  assert.match(source, /staleAfterMinutes: Type\.Optional/);
  assert.match(source, /snapshotStalenessReport/);
  assert.match(source, /words\[0\] === "staleness"/);
  assert.match(source, /words\[0\] === "bundle"/);
  assert.match(source, /words\[0\] === "open-bundle"/);
  assert.match(source, /words\[0\] === "refresh-staleness"/);
  assert.match(source, /words\[0\] === "stale-refresh"/);
  assert.match(source, /renderDefaultOpenBundle/);
  assert.match(source, /renderDefaultRefreshBundle/);
  assert.match(source, /renderDefaultStaleRefresh/);
  assert.match(source, /tendril-app-overview/);
  assert.match(source, /tendril-app-bundle/);
  assert.match(source, /tendril-app-refresh-staleness/);
  assert.match(source, /shortcutCommands/);
});

test("sanitizeId normalizes user-facing app selectors", () => {
  assert.equal(sanitizeId("Slack Web!"), "slack-web");
  assert.equal(sanitizeId("  Teams/v2  "), "teams-v2");
});
