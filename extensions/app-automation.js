import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setInterval, clearInterval } from "node:timers";

import { Type } from "@sinclair/typebox";

import {
  collectSnapshotLinks,
  digestSnapshotArtifacts,
  listSnapshotArtifacts,
  readSnapshotArtifact,
  renderArtifactList,
  renderSnapshotCleanupPlan,
  renderSnapshotDigest,
  renderSnapshotLinks,
  renderSnapshotStaleness,
  renderSnapshotTargetStaleness,
  snapshotStalenessReport,
  snapshotTargetStalenessReport,
  planSnapshotCleanup,
} from "./app-automation/artifacts.js";
import {
  APP_AUTOMATION_SPEC_VERSION,
  buildActionPlan,
  loadCatalog,
  renderAppList,
  renderPlan,
  stateRoot,
} from "./app-automation/catalog.js";
import { calendarExtractorScript } from "./app-automation/calendar.js";
import { syncMarkdownCanvas } from "./app-automation/canvas.js";
import { prepareEditorReplace } from "./app-automation/editor.js";
import { buildGenericSnapshot, writeGenericSnapshot } from "./app-automation/generic-snapshot.js";
import { parseLinkCommandArgs } from "./app-automation/link-command.js";
import { microsoftExtractorScript } from "./app-automation/microsoft.js";
import { authMissingHint, buildAuthRequiredDiagnostic, prepareDomExtractStep, playwrightCliCommand, playwrightSessionArgs } from "./app-automation/playwright-bridge.js";
import { buildSafeRunManifest, runStatusFromResults, writeLatestRunManifest } from "./app-automation/run-manifest.js";
import {
  buildSlackNotificationSnapshot,
  renderSlackNotificationMarkdown,
  slackExtractorScript,
} from "./app-automation/slack.js";
import { buildTendrilCommand, tendrilCommandSummary } from "./tendril-command.js";

const TOOL_PREFIX = "app_automation";
const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;
const MIN_REFRESH_INTERVAL_SECONDS = 30;
const DEFAULT_REFRESH_BUNDLE = [
  { app: "slack", action: "notifications.snapshot" },
  { app: "calendar", action: "events.snapshot" },
  { app: "outlook", action: "notifications.snapshot" },
  { app: "outlook", action: "calendar.snapshot" },
  { app: "teams", action: "notifications.snapshot" },
  { app: "teams", action: "calendar.snapshot" },
];
const DEFAULT_OPEN_BUNDLE = [
  { app: "slack", action: "open" },
  { app: "calendar", action: "open" },
  { app: "outlook", action: "open" },
  { app: "outlook", action: "calendar.open" },
  { app: "teams", action: "open" },
  { app: "teams", action: "calendar.open" },
];
const DEFAULT_DOCTOR_ACTIONS = [
  { app: "slack", action: "open" },
  { app: "slack", action: "notifications.snapshot" },
  { app: "calendar", action: "open" },
  { app: "calendar", action: "events.snapshot" },
  { app: "outlook", action: "open" },
  { app: "outlook", action: "calendar.open" },
  { app: "outlook", action: "notifications.snapshot" },
  { app: "outlook", action: "calendar.snapshot" },
  { app: "teams", action: "open" },
  { app: "teams", action: "calendar.open" },
  { app: "teams", action: "notifications.snapshot" },
  { app: "teams", action: "calendar.snapshot" },
  { app: "canvas", action: "sync-markdown" },
];


async function pathSummary(root) {
  const exists = await stat(root).then(() => true, () => false);
  if (!exists) return { root, exists: false, entries: [] };
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return {
    root,
    exists: true,
    entries: entries.slice(0, 100).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    })),
  };
}

function textResult(text, details = {}) {
  return { content: [{ type: "text", text }], details };
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

async function runPlan(pi, plan, { signal, timeoutMs = 30_000 } = {}) {
  if (!plan.execution.executable) {
    return {
      status: "not_executable",
      reason: plan.execution.missingParams.length
        ? `missing parameters: ${plan.execution.missingParams.join(", ")}`
        : "one or more steps do not have an executable runner yet",
      blockedSteps: plan.execution.blockedSteps,
      results: [],
    };
  }

  const results = [];
  await mkdir(plan.snapshotDir, { recursive: true });
  for (const step of plan.execution.stepCommands) {
    if (step.internal === "slack.notifications.snapshot") {
      let input = plan.params.extraction || plan.params.sourceJson || plan.params.sourceText || results.find((result) => result.extraction)?.extraction || {};
      if (typeof input === "string" && input.trim().startsWith("{")) {
        input = JSON.parse(input);
      }
      const snapshot = buildSlackNotificationSnapshot(input);
      const jsonPath = path.join(plan.snapshotDir, "notifications.json");
      const markdownPath = path.join(plan.snapshotDir, "notifications.md");
      const extractorPath = path.join(plan.snapshotDir, "extractor.js");
      await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await writeFile(markdownPath, renderSlackNotificationMarkdown(snapshot), "utf8");
      await writeFile(extractorPath, `${slackExtractorScript()}\n`, "utf8");
      results.push({
        index: step.index,
        kind: step.kind,
        status: "ok",
        snapshotStatus: snapshot.status,
        jsonPath,
        markdownPath,
        extractorPath,
        counts: snapshot.counts,
      });
      continue;
    }
    if (step.internal === "canvas.sync-markdown") {
      const metadata = await syncMarkdownCanvas(plan.params, { snapshotDir: plan.snapshotDir });
      results.push({
        index: step.index,
        kind: step.kind,
        status: "ok",
        syncStatus: metadata.status,
        outputs: metadata.outputs,
        pastePlan: metadata.pastePlan,
      });
      continue;
    }
    if (step.internal === "generic.notifications.snapshot") {
      const stepSpec = plan.steps[step.index] || {};
      const input = plan.params.extraction || plan.params.sourceJson || plan.params.sourceText || plan.params.items || results.find((result) => result.extraction)?.extraction || {};
      const snapshot = buildGenericSnapshot({
        app: stepSpec.app || plan.app.id,
        kind: plan.action.id,
        input,
        includePatterns: stepSpec.includePatterns || [],
      });
      const outputs = await writeGenericSnapshot(plan.snapshotDir, snapshot);
      results.push({
        index: step.index,
        kind: step.kind,
        status: "ok",
        snapshotStatus: snapshot.status,
        outputs,
        count: snapshot.count,
      });
      continue;
    }
    if (step.internal === "editor.replace") {
      const sourceStep = plan.steps[step.index] || {};
      const prepared = await prepareEditorReplace({ step: sourceStep, params: plan.params, snapshotDir: plan.snapshotDir });
      if (!prepared.executable) {
        results.push({ index: step.index, kind: step.kind, status: "not_executable", reason: prepared.reason });
        break;
      }
      step.command = "playwright-cli";
      step.args = [...playwrightSessionArgs(plan.params), "evaluate", "--script-file", prepared.scriptPath, "--output", prepared.outputPath];
      step.scriptPath = prepared.scriptPath;
      step.outputPath = prepared.outputPath;
    }
    if (step.internal === "optional.skip") {
      results.push({ index: step.index, kind: step.kind, status: "skipped", reason: step.reason });
      continue;
    }
    if (step.internal === "wait") {
      results.push({ index: step.index, kind: step.kind, status: "ok", skipped: true });
      continue;
    }
    if (step.internal === "snapshot.write") {
      const payload = {
        version: 1,
        writtenAt: new Date().toISOString(),
        app: plan.app,
        action: plan.action,
        params: plan.params,
        priorResults: results,
      };
      const filename = `${timestampForFilename()}-${plan.action.id.replace(/[^a-zA-Z0-9._-]+/g, "-")}.json`;
      const outputPath = `${plan.snapshotDir}/${filename}`;
      await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      await writeFile(`${plan.snapshotDir}/latest-run.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      results.push({ index: step.index, kind: step.kind, status: "ok", outputPath });
      continue;
    }
    if (step.kind === "dom.extract") {
      const sourceStep = plan.steps[step.index] || {};
      const prepared = await prepareDomExtractStep(sourceStep, plan.params, {
        snapshotDir: plan.snapshotDir,
        actionId: plan.action.id,
        scripts: {
          slackExtractorScript: slackExtractorScript(),
          calendarExtractorScript: calendarExtractorScript({
            app: sourceStep.app || plan.app.id,
            kind: plan.action.id,
            includePatterns: sourceStep.includePatterns || [],
          }),
          microsoftExtractorScript: microsoftExtractorScript({
            app: sourceStep.app || plan.app.id,
            kind: plan.action.id,
            includePatterns: sourceStep.includePatterns || [],
          }),
        },
      });
      if (prepared.paths.scriptPath || prepared.paths.outputPath) {
        step.scriptPath = prepared.paths.scriptPath || step.scriptPath;
        step.outputPath = prepared.paths.outputPath || step.outputPath;
        step.args = [];
        if (plan.params.session || plan.params.playwrightSession) step.args.push(`-s=${String(plan.params.session || plan.params.playwrightSession)}`);
        step.args.push("evaluate", "--script-file", step.scriptPath, "--output", step.outputPath);
      }
    }
    const result = await pi.exec(step.command, step.args, { signal, timeout: timeoutMs });
    const authRequired = result.code !== 0 && authMissingHint(result);
    const runResult = {
      index: step.index,
      kind: step.kind,
      command: step.command,
      args: step.args,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.code === 0 ? "ok" : "error",
      authRequired,
    };
    if (authRequired) {
      const diagnostic = buildAuthRequiredDiagnostic({ app: plan.app.id, action: plan.action.id, step, result });
      const authPath = path.join(plan.snapshotDir, "auth-required.json");
      await writeFile(authPath, `${JSON.stringify(diagnostic, null, 2)}\n`, "utf8");
      runResult.authRequiredPath = authPath;
    }
    results.push(runResult);
    if (step.kind === "dom.extract" && result.code === 0) {
      try {
        const extractionText = await readFile(step.outputPath, "utf8");
        results.at(-1).extraction = JSON.parse(extractionText);
      } catch (error) {
        results.at(-1).extractionError = error.message;
      }
    }
    if (result.code !== 0) break;
  }
  const run = {
    status: runStatusFromResults(results),
    results,
  };
  const manifest = buildSafeRunManifest({ plan, run });
  run.latestRunPath = await writeLatestRunManifest(plan.snapshotDir, manifest);
  return run;
}

async function resolveCatalog(params = {}) {
  return loadCatalog({ includeExternal: params.includeExternal !== false });
}

function refreshAuthSummary(run = {}) {
  const results = Array.isArray(run.results) ? run.results : [];
  const authRequired = results.filter((result) => result?.authRequired);
  const paths = [...new Set(authRequired.map((result) => result.authRequiredPath).filter(Boolean))];
  return { authRequiredCount: authRequired.length, authRequiredPaths: paths };
}

function refreshPublicEntry(entry) {
  const authSummary = refreshAuthSummary(entry.lastRun);
  return {
    id: entry.id,
    app: entry.app,
    action: entry.action,
    intervalSeconds: entry.intervalSeconds,
    running: entry.running,
    inFlight: entry.inFlight,
    runCount: entry.runCount,
    errorCount: entry.errorCount,
    consecutiveErrorCount: entry.consecutiveErrorCount,
    lastRunAt: entry.lastRunAt,
    lastSuccessAt: entry.lastSuccessAt,
    lastStatus: entry.lastStatus,
    lastError: entry.lastError,
    authRequiredCount: authSummary.authRequiredCount,
    authRequiredPaths: authSummary.authRequiredPaths,
  };
}

function renderWorkAppOverview({ apps, refreshers, snapshotDigests, snapshotLinks, snapshotStaleness, refreshStaleness, root }) {
  const lines = [`app automation overview stateRoot=${root}`];
  lines.push(`apps: ${apps.map((app) => `${app.id}(${app.actions?.length || 0} actions)`).join(", ") || "none"}`);
  lines.push(refreshers.length
    ? `refreshers: ${refreshers.map((entry) => `${entry.id}:${entry.lastStatus}/runs=${entry.runCount}`).join(", ")}`
    : "refreshers: none");
  if (snapshotStaleness) {
    lines.push("staleness:");
    lines.push(...renderSnapshotStaleness(snapshotStaleness).split("\n").map((line) => `  ${line}`));
  }
  if (refreshStaleness) {
    lines.push("refresh action staleness:");
    lines.push(...renderSnapshotTargetStaleness(refreshStaleness).split("\n").map((line) => `  ${line}`));
  }
  for (const digest of snapshotDigests) {
    const rendered = renderSnapshotDigest(digest).split("\n").slice(0, 5).join("\n  ");
    lines.push(`${digest.app || "snapshots"}: ${rendered}`);
  }
  if (snapshotLinks) {
    lines.push("links:");
    lines.push(...renderSnapshotLinks(snapshotLinks).split("\n").map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

function renderDefaultRefreshBundle() {
  return [
    "default app automation refresh bundle:",
    ...DEFAULT_REFRESH_BUNDLE.map((target) => `- ${target.app}.${target.action}`),
    "Use app_automation_refresh_bundle_start to arm these refreshers, app_automation_refresh_bundle_run_once to refresh once, or /tendril-app overview to inspect current state.",
  ].join("\n");
}

function renderDefaultOpenBundle() {
  return [
    "default app automation open bundle:",
    ...DEFAULT_OPEN_BUNDLE.map((target) => `- ${target.app}.${target.action}`),
    "Use app_automation_open_bundle_run_once to warm these browser sessions before snapshot extraction.",
  ].join("\n");
}

function renderDefaultStaleRefresh() {
  return [
    "default app automation stale-refresh flow:",
    "1. app_automation_refresh_staleness reports per-action Slack/Calendar/Outlook/Teams bundle freshness.",
    "2. app_automation_refresh_stale_run_once checks each standard Slack/Calendar/Outlook/Teams action output and runs only stale or missing snapshot actions.",
    "Use dryRun=true first to preview stale-refresh decisions before browser automation.",
  ].join("\n");
}

async function buildRefreshBundleStaleness({ catalog, params = {} } = {}) {
  const wantedApps = new Set((params.apps || []).map((value) => String(value)));
  const wantedActions = new Set((params.actions || []).map((value) => String(value)));
  const targets = DEFAULT_REFRESH_BUNDLE.filter((target) => (
    (!wantedApps.size || wantedApps.has(target.app))
    && (!wantedActions.size || wantedActions.has(target.action))
  ));
  const stalenessTargets = targets.map((target) => {
    const appConfig = catalog.apps.find((app) => app.id === target.app);
    const actionConfig = appConfig?.actions.find((action) => action.id === target.action);
    return { ...target, outputs: actionConfig?.outputs || [] };
  });
  return snapshotTargetStalenessReport({ root: stateRoot(), targets: stalenessTargets, staleAfterMinutes: params.staleAfterMinutes || 60 });
}

function renderDoctorReport({ rootSummary, catalog, playwrightCli, tendrilBridge, tendrilProbe, actionDiagnostics, cliCheck }) {
  const lines = [
    `app automation doctor stateRoot=${rootSummary.root} exists=${rootSummary.exists}`,
    `playwrightCli=${playwrightCli}`,
    `tendrilBridge command=${tendrilBridge.command} remote=${tendrilBridge.remote || "none"} wslTunnel=${tendrilBridge.wslTunnel}`,
    tendrilProbe ? `tendrilProbe=${tendrilProbe.status}${tendrilProbe.targets != null ? ` targets=${tendrilProbe.targets}` : ""}${tendrilProbe.error ? ` error=${tendrilProbe.error}` : ""}` : null,
    `catalogApps=${catalog.apps.map((app) => app.id).join(",")}`,
  ].filter(Boolean);
  if (catalog.external?.errors?.length) {
    lines.push(`catalogErrors=${catalog.external.errors.length}`);
    lines.push(...catalog.external.errors.slice(0, 5).map((error) => `- ${error.source || "external"}: ${error.error || error.message || String(error)}`));
  } else {
    lines.push("catalogErrors=0");
  }
  if (cliCheck) lines.push(`cliCheck=${cliCheck.status}${cliCheck.version ? ` version=${cliCheck.version}` : ""}${cliCheck.error ? ` error=${cliCheck.error}` : ""}`);
  lines.push("actions:");
  lines.push(...actionDiagnostics.map((entry) => `- ${entry.app}.${entry.action}: ${entry.executable ? "executable" : "not-executable"}${entry.missingParams?.length ? ` missing=${entry.missingParams.join(",")}` : ""}${entry.blockedSteps?.length ? ` blocked=${entry.blockedSteps.map((step) => step.kind).join(",")}` : ""}`));
  return lines.join("\n");
}

function parseTendrilJsonEnvelope(stdout) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error("tendril list returned no JSON output");
  try { return JSON.parse(trimmed); }
  catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`tendril list returned invalid JSON: ${error.message}`);
  }
}

async function probeTendrilBridge(pi, { signal, timeoutMs = 5000 } = {}) {
  const tendril = buildTendrilCommand(["list", "--json"]);
  try {
    const result = await pi.exec(tendril.command, tendril.args, { signal, timeout: timeoutMs });
    const envelope = parseTendrilJsonEnvelope(result.stdout);
    if (result.code !== 0 || envelope.status === "error") {
      const message = envelope.error?.message || result.stderr || `tendril exited with code ${result.code}`;
      return { status: "error", error: String(message).slice(0, 300) };
    }
    return { status: envelope.status || "ok", targets: envelope.data?.targets?.length || 0 };
  } catch (error) {
    return { status: "error", error: String(error.message || error).slice(0, 300) };
  }
}

function nextRefreshId(state, app, action) {
  state.refreshSeq = (state.refreshSeq || 0) + 1;
  return `${app}-${action.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${state.refreshSeq}`;
}

export default function appAutomationExtension(pi) {
  const refreshState = { refreshers: new Map(), refreshSeq: 0 };

  async function runRefresh(entry, signal) {
    if (entry.inFlight || !entry.running) return;
    entry.inFlight = true;
    entry.lastRunAt = new Date().toISOString();
    try {
      const catalog = await resolveCatalog(entry);
      const plan = buildActionPlan({ app: entry.app, action: entry.action, params: entry.params || {}, catalog: catalog.apps });
      const run = await runPlan(pi, plan, { signal, timeoutMs: entry.timeoutMs });
      entry.runCount += 1;
      entry.lastStatus = run.status;
      entry.lastError = run.reason || (run.status === "error" ? "refresh run returned error" : null);
      if (run.status === "ok") {
        entry.lastSuccessAt = entry.lastRunAt;
        entry.consecutiveErrorCount = 0;
      } else {
        entry.errorCount += 1;
        entry.consecutiveErrorCount += 1;
      }
      entry.lastRun = run;
    } catch (error) {
      entry.errorCount += 1;
      entry.consecutiveErrorCount += 1;
      entry.lastStatus = "error";
      entry.lastError = error.message;
    } finally {
      entry.inFlight = false;
    }
  }

  function stopRefresh(id) {
    const entry = refreshState.refreshers.get(id);
    if (!entry) return false;
    if (entry.timer) clearInterval(entry.timer);
    entry.running = false;
    refreshState.refreshers.delete(id);
    return true;
  }

  pi.on("session_shutdown", async () => {
    for (const id of Array.from(refreshState.refreshers.keys())) stopRefresh(id);
  });
  pi.registerTool({
    name: `${TOOL_PREFIX}_list`,
    label: "App Automation List",
    description: "List blessed API-less web app automation configs and their available high-level actions.",
    promptSnippet: "Discover blessed app automation configs for Slack, Calendar, Outlook, Teams, and canvas workflows before using raw Playwright/Tendril.",
    parameters: Type.Object({
      includeActions: Type.Optional(Type.Boolean({ description: "Include action summaries. Defaults to true." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      const catalog = await resolveCatalog(params);
      const apps = catalog.apps.map((app) => ({ ...app, actions: params.includeActions === false ? undefined : app.actions }))
        .map((app) => params.includeActions === false
          ? { id: app.id, label: app.label, url: app.url, category: app.category, auth: app.auth, source: app.source }
          : app);
      return textResult(renderAppList(apps), {
        apps,
        external: catalog.external,
        stateRoot: stateRoot(),
        specVersion: APP_AUTOMATION_SPEC_VERSION,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_doctor`,
    label: "App Automation Doctor",
    description: "Diagnose app automation catalog, state root, Playwright CLI configuration, and standard work-app action executability.",
    promptSnippet: "Use this before live Slack, Outlook, Teams, calendar, or canvas automation when setup or auth state is unclear.",
    parameters: Type.Object({
      checkCli: Type.Optional(Type.Boolean({ description: "Run the configured Playwright CLI with --version. Defaults to false." })),
      probeTendrilBridge: Type.Optional(Type.Boolean({ description: "Run tendril list --json through the configured Tendril bridge. Defaults to false." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Timeout for optional CLI and Tendril bridge checks. Defaults to 5000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const rootSummary = await pathSummary(stateRoot());
      const actionDiagnostics = DEFAULT_DOCTOR_ACTIONS.map((target) => {
        try {
          const plan = buildActionPlan({ app: target.app, action: target.action, catalog: catalog.apps });
          return {
            app: target.app,
            action: target.action,
            executable: plan.execution.executable,
            missingParams: plan.execution.missingParams,
            blockedSteps: plan.execution.blockedSteps,
          };
        } catch (error) {
          return { app: target.app, action: target.action, executable: false, error: error.message };
        }
      });
      let cliCheck = null;
      const playwrightCli = playwrightCliCommand();
      if (params.checkCli) {
        const result = await pi.exec(playwrightCli, ["--version"], { signal, timeout: params.timeoutMs || 5000 });
        cliCheck = result.code === 0
          ? { status: "ok", version: String(result.stdout || "").trim().split(/\r?\n/)[0] || "unknown" }
          : { status: "error", error: String(result.stderr || result.stdout || `exit ${result.code}`).slice(0, 300) };
      }
      const tendrilBridge = tendrilCommandSummary();
      const tendrilProbe = params.probeTendrilBridge ? await probeTendrilBridge(pi, { signal, timeoutMs: params.timeoutMs || 5000 }) : null;
      return textResult(renderDoctorReport({ rootSummary, catalog, playwrightCli, tendrilBridge, tendrilProbe, actionDiagnostics, cliCheck }), {
        state: rootSummary,
        playwrightCli,
        tendrilBridge,
        tendrilProbe,
        cliCheck,
        actionDiagnostics,
        external: catalog.external,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_overview`,
    label: "App Automation Overview",
    description: "Summarize configured work apps, active refreshers, and latest snapshot digests for Slack, Outlook, Teams, calendar, and canvas workflows.",
    promptSnippet: "Use this first when orienting on current Slack, Outlook, Teams, calendar, or canvas app automation state.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to include. Defaults to slack, outlook, teams, canvas." }))),
      includeSnapshots: Type.Optional(Type.Boolean({ description: "Include snapshot digest summaries. Defaults to true." })),
      includeStaleness: Type.Optional(Type.Boolean({ description: "Include fresh/stale/missing snapshot status. Defaults to true." })),
      includeRefreshStaleness: Type.Optional(Type.Boolean({ description: "Include per-action standard refresh bundle staleness. Defaults to true." })),
      includeLinks: Type.Optional(Type.Boolean({ description: "Include compact snapshot link rows. Defaults to false." })),
      staleAfterMinutes: Type.Optional(Type.Number({ description: "Age threshold for stale snapshots. Defaults to 60 minutes." })),
      snapshotLimitPerApp: Type.Optional(Type.Number({ description: "Readable snapshot artifacts to summarize per app. Defaults to 3." })),
      linkLimitPerApp: Type.Optional(Type.Number({ description: "Snapshot links to include per app when includeLinks is true. Defaults to 3." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      const catalog = await resolveCatalog(params);
      const wantedIds = params.apps?.length ? params.apps.map((app) => String(app)) : ["slack", "calendar", "outlook", "teams", "canvas"];
      const apps = wantedIds
        .map((id) => catalog.apps.find((app) => app.id === id))
        .filter(Boolean)
        .map((app) => ({ id: app.id, label: app.label, category: app.category, actions: app.actions.map((action) => action.id) }));
      const root = stateRoot();
      const refreshers = Array.from(refreshState.refreshers.values())
        .filter((entry) => wantedIds.includes(entry.app))
        .map(refreshPublicEntry);
      const snapshotDigests = [];
      if (params.includeSnapshots !== false) {
        for (const app of apps) {
          const digest = await digestSnapshotArtifacts({ root, app: app.id, limit: params.snapshotLimitPerApp || 3 });
          snapshotDigests.push({ ...digest, app: app.id });
        }
      }
      const snapshotStaleness = params.includeStaleness === false ? null : await snapshotStalenessReport({
        root,
        apps: apps.map((app) => app.id),
        staleAfterMinutes: params.staleAfterMinutes || 60,
      });
      const refreshStaleness = params.includeRefreshStaleness === false ? null : await buildRefreshBundleStaleness({ catalog, params: { ...params, apps: wantedIds.filter((id) => id !== "canvas") } });
      let snapshotLinks = null;
      if (params.includeLinks) {
        const links = [];
        let truncated = false;
        for (const app of apps) {
          const summary = await collectSnapshotLinks({ root, app: app.id, linkLimit: params.linkLimitPerApp || 3, staleAfterMinutes: params.staleAfterMinutes || 60 });
          links.push(...summary.links);
          truncated = truncated || summary.truncated;
        }
        snapshotLinks = { root, snapshotRoot: path.join(root, "snapshots"), exists: true, links, truncated };
      }
      return textResult(renderWorkAppOverview({ apps, refreshers, snapshotDigests, snapshotLinks, snapshotStaleness, refreshStaleness, root }), {
        apps,
        refreshers,
        snapshotDigests,
        snapshotLinks,
        snapshotStaleness,
        refreshStaleness,
        external: catalog.external,
        stateRoot: root,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_plan`,
    label: "App Automation Plan",
    description: "Return the deterministic blessed action plan for an app/action without executing browser automation.",
    promptSnippet: "Plan a blessed Slack/canvas/Outlook/Teams app action before executing lower-level Playwright or Tendril steps.",
    parameters: Type.Object({
      app: Type.String({ description: "Blessed app id, for example slack, canvas, outlook, or teams." }),
      action: Type.String({ description: "Action id, for example open, notifications.snapshot, or sync-markdown." }),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "Action parameters used for validation and future execution.",
      })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      const catalog = await resolveCatalog(params);
      const plan = buildActionPlan({ app: params.app, action: params.action, params: params.params || {}, catalog: catalog.apps });
      return textResult(renderPlan(plan), { plan, external: catalog.external });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_run`,
    label: "App Automation Run",
    description: "Run or dry-run a deterministic app automation action. Execution only allows safe configured runners; high-level browser actions remain planned until app-specific drivers land.",
    promptSnippet: "Use this to dry-run or execute blessed app automation plans instead of hand-writing shell commands.",
    parameters: Type.Object({
      app: Type.String({ description: "Blessed or configured app id." }),
      action: Type.String({ description: "Action id to run." }),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), {
        description: "Action parameters.",
      })),
      execute: Type.Optional(Type.Boolean({ description: "Actually execute executable steps. Defaults to false (dry-run)." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-command timeout in milliseconds. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const plan = buildActionPlan({ app: params.app, action: params.action, params: params.params || {}, catalog: catalog.apps });
      if (!params.execute) {
        return textResult(`dry-run: ${renderPlan(plan)}\nexecutable=${plan.execution.executable}`, {
          plan,
          dryRun: true,
          external: catalog.external,
        });
      }
      const run = await runPlan(pi, plan, { signal, timeoutMs: params.timeoutMs });
      return textResult(
        `run ${plan.app.id}.${plan.action.id}: ${run.status}${run.reason ? ` — ${run.reason}` : ""}`,
        { plan, run, external: catalog.external },
      );
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_start`,
    label: "App Automation Refresh Start",
    description: "Start a Pi-session-local periodic app automation run. Runs are non-overlapping and stopped on session shutdown.",
    parameters: Type.Object({
      app: Type.String({ description: "App id to refresh." }),
      action: Type.String({ description: "Action id to refresh." }),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Action parameters." })),
      intervalSeconds: Type.Optional(Type.Number({ description: "Refresh interval. Defaults to 300 seconds; minimum 30 seconds." })),
      runImmediately: Type.Optional(Type.Boolean({ description: "Run once immediately after starting. Defaults to true." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-refresh command timeout in milliseconds. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const plan = buildActionPlan({ app: params.app, action: params.action, params: params.params || {}, catalog: catalog.apps });
      if (!plan.execution.executable) {
        return textResult(`refresh not started: ${plan.execution.missingParams.length ? `missing ${plan.execution.missingParams.join(", ")}` : "plan is not executable"}`, {
          plan,
          blockedSteps: plan.execution.blockedSteps,
        });
      }
      const intervalSeconds = Math.max(
        MIN_REFRESH_INTERVAL_SECONDS,
        Number.parseInt(String(params.intervalSeconds || DEFAULT_REFRESH_INTERVAL_SECONDS), 10) || DEFAULT_REFRESH_INTERVAL_SECONDS,
      );
      const id = nextRefreshId(refreshState, plan.app.id, plan.action.id);
      const entry = {
        id,
        app: plan.app.id,
        action: plan.action.id,
        params: params.params || {},
        includeExternal: params.includeExternal !== false,
        timeoutMs: params.timeoutMs,
        intervalSeconds,
        running: true,
        inFlight: false,
        runCount: 0,
        errorCount: 0,
        lastRunAt: null,
        lastStatus: "pending",
        lastError: null,
        lastRun: null,
      };
      entry.timer = setInterval(() => { void runRefresh(entry, signal); }, intervalSeconds * 1000);
      refreshState.refreshers.set(id, entry);
      if (params.runImmediately !== false) await runRefresh(entry, signal);
      return textResult(`started app automation refresh ${id}: ${entry.app}.${entry.action} every ${intervalSeconds}s`, {
        refresh: refreshPublicEntry(entry),
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_open_bundle_run_once`,
    label: "App Automation Open Bundle Run Once",
    description: "Open the standard Slack, Calendar, Outlook, and Teams browser surfaces once without snapshot extraction or periodic timers.",
    promptSnippet: "Use this to warm or verify authenticated Slack, Calendar, Outlook mail/calendar, and Teams browser sessions before live snapshot automation.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to include from the default open bundle." }))),
      actions: Type.Optional(Type.Array(Type.String({ description: "Optional open action ids to include from the default open bundle." }))),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Shared action parameters such as session/playwrightSession." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Return planned open bundle actions without executing browser automation. Defaults to false." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-action command timeout in milliseconds. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const wantedApps = new Set((params.apps || []).map((value) => String(value)));
      const wantedActions = new Set((params.actions || []).map((value) => String(value)));
      const targets = DEFAULT_OPEN_BUNDLE.filter((target) => (
        (!wantedApps.size || wantedApps.has(target.app))
        && (!wantedActions.size || wantedActions.has(target.action))
      ));
      const runs = [];
      const skipped = [];
      for (const target of targets) {
        const plan = buildActionPlan({ app: target.app, action: target.action, params: params.params || {}, catalog: catalog.apps });
        if (!plan.execution.executable) {
          skipped.push({ app: target.app, action: target.action, reason: plan.execution.missingParams.length ? `missing ${plan.execution.missingParams.join(",")}` : "plan is not executable", blockedSteps: plan.execution.blockedSteps });
          continue;
        }
        if (params.dryRun) {
          runs.push({ app: target.app, action: target.action, status: "dry_run", executable: true, steps: plan.execution.stepCommands.map((step) => ({ kind: step.kind, internal: step.internal, command: step.command, args: step.args })) });
          continue;
        }
        const run = await runPlan(pi, plan, { signal, timeoutMs: params.timeoutMs });
        runs.push({ app: target.app, action: target.action, status: run.status, latestRunPath: run.latestRunPath, results: run.results });
      }
      const failed = runs.filter((run) => !["ok", "dry_run"].includes(run.status)).length;
      return textResult(`${params.dryRun ? "dry-run planned" : "opened"} ${runs.length} app automation surfaces once${failed ? `; ${failed} failed` : ""}${skipped.length ? `; skipped ${skipped.length}` : ""}`, {
        dryRun: Boolean(params.dryRun),
        runs,
        skipped,
        defaultBundle: DEFAULT_OPEN_BUNDLE,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_bundle_run_once`,
    label: "App Automation Refresh Bundle Run Once",
    description: "Run the standard Slack, Calendar, Outlook, and Teams snapshot refresh bundle once without starting periodic timers.",
    promptSnippet: "Use this when you need an explicit refresh-now pass for Slack, Calendar, Outlook mail/calendar, and Teams notification/calendar snapshots without arming timers.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to include from the default bundle." }))),
      actions: Type.Optional(Type.Array(Type.String({ description: "Optional action ids to include from the default bundle." }))),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Shared action parameters such as session/playwrightSession." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Return planned refresh bundle actions without executing browser automation. Defaults to false." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-action command timeout in milliseconds. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const wantedApps = new Set((params.apps || []).map((value) => String(value)));
      const wantedActions = new Set((params.actions || []).map((value) => String(value)));
      const targets = DEFAULT_REFRESH_BUNDLE.filter((target) => (
        (!wantedApps.size || wantedApps.has(target.app))
        && (!wantedActions.size || wantedActions.has(target.action))
      ));
      const runs = [];
      const skipped = [];
      for (const target of targets) {
        const plan = buildActionPlan({ app: target.app, action: target.action, params: params.params || {}, catalog: catalog.apps });
        if (!plan.execution.executable) {
          skipped.push({ app: target.app, action: target.action, reason: plan.execution.missingParams.length ? `missing ${plan.execution.missingParams.join(",")}` : "plan is not executable", blockedSteps: plan.execution.blockedSteps });
          continue;
        }
        if (params.dryRun) {
          runs.push({ app: target.app, action: target.action, status: "dry_run", executable: true, steps: plan.execution.stepCommands.map((step) => ({ kind: step.kind, internal: step.internal, command: step.command, args: step.args })) });
          continue;
        }
        const run = await runPlan(pi, plan, { signal, timeoutMs: params.timeoutMs });
        runs.push({ app: target.app, action: target.action, status: run.status, latestRunPath: run.latestRunPath, results: run.results });
      }
      const failed = runs.filter((run) => !["ok", "dry_run"].includes(run.status)).length;
      return textResult(`${params.dryRun ? "dry-run planned" : "ran"} ${runs.length} app automation bundle actions once${failed ? `; ${failed} failed` : ""}${skipped.length ? `; skipped ${skipped.length}` : ""}`, {
        dryRun: Boolean(params.dryRun),
        runs,
        skipped,
        defaultBundle: DEFAULT_REFRESH_BUNDLE,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_staleness`,
    label: "App Automation Refresh Staleness",
    description: "Report per-action freshness for the standard Slack, Calendar, Outlook, and Teams snapshot refresh bundle without executing browser automation.",
    promptSnippet: "Use this to preview exactly which standard refresh bundle actions are fresh, stale, or missing before running stale refresh.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to check. Defaults to the standard refresh bundle apps." }))),
      actions: Type.Optional(Type.Array(Type.String({ description: "Optional action ids to include from the default refresh bundle." }))),
      staleAfterMinutes: Type.Optional(Type.Number({ description: "Age threshold for stale snapshots. Defaults to 60 minutes." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      const catalog = await resolveCatalog(params);
      const staleness = await buildRefreshBundleStaleness({ catalog, params });
      const counts = staleness.entries.reduce((acc, entry) => {
        acc[entry.status] = (acc[entry.status] || 0) + 1;
        return acc;
      }, {});
      return textResult(renderSnapshotTargetStaleness(staleness), {
        staleness,
        counts,
        defaultBundle: DEFAULT_REFRESH_BUNDLE,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_stale_run_once`,
    label: "App Automation Refresh Stale Run Once",
    description: "Run standard Slack, Calendar, Outlook, and Teams snapshot refresh actions once only for apps whose snapshots are stale or missing.",
    promptSnippet: "Use this when you want to refresh only stale or missing work-app snapshots instead of running the full bundle.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to check. Defaults to the standard refresh bundle apps." }))),
      actions: Type.Optional(Type.Array(Type.String({ description: "Optional action ids to include from the default refresh bundle." }))),
      staleAfterMinutes: Type.Optional(Type.Number({ description: "Age threshold for stale snapshots. Defaults to 60 minutes." })),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Shared action parameters such as session/playwrightSession." })),
      dryRun: Type.Optional(Type.Boolean({ description: "Return stale refresh decisions without executing browser automation. Defaults to false." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-action command timeout in milliseconds. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const wantedApps = new Set((params.apps || []).map((value) => String(value)));
      const wantedActions = new Set((params.actions || []).map((value) => String(value)));
      const candidateTargets = DEFAULT_REFRESH_BUNDLE.filter((target) => (
        (!wantedApps.size || wantedApps.has(target.app))
        && (!wantedActions.size || wantedActions.has(target.action))
      ));
      const staleness = await buildRefreshBundleStaleness({ catalog, params });
      const staleKeys = new Set(staleness.entries.filter((entry) => entry.status !== "fresh").map((entry) => entry.key));
      const targets = candidateTargets.filter((target) => staleKeys.has(`${target.app}:${target.action}`));
      const runs = [];
      const skipped = staleness.entries
        .filter((entry) => entry.status === "fresh")
        .map((entry) => ({ app: entry.app, action: entry.action, reason: "fresh", latestArtifact: entry.latestArtifact, ageMinutes: entry.ageMinutes }));
      for (const target of targets) {
        const plan = buildActionPlan({ app: target.app, action: target.action, params: params.params || {}, catalog: catalog.apps });
        if (!plan.execution.executable) {
          skipped.push({ app: target.app, action: target.action, reason: plan.execution.missingParams.length ? `missing ${plan.execution.missingParams.join(",")}` : "plan is not executable", blockedSteps: plan.execution.blockedSteps });
          continue;
        }
        if (params.dryRun) {
          runs.push({ app: target.app, action: target.action, status: "dry_run", executable: true, staleStatus: staleness.entries.find((entry) => entry.key === `${target.app}:${target.action}`)?.status, steps: plan.execution.stepCommands.map((step) => ({ kind: step.kind, internal: step.internal, command: step.command, args: step.args })) });
          continue;
        }
        const run = await runPlan(pi, plan, { signal, timeoutMs: params.timeoutMs });
        runs.push({ app: target.app, action: target.action, status: run.status, latestRunPath: run.latestRunPath, results: run.results });
      }
      const failed = runs.filter((run) => !["ok", "dry_run"].includes(run.status)).length;
      return textResult(`${params.dryRun ? "dry-run planned" : "ran"} ${runs.length} stale app automation refresh actions${failed ? `; ${failed} failed` : ""}${skipped.length ? `; skipped ${skipped.length}` : ""}`, {
        dryRun: Boolean(params.dryRun),
        runs,
        skipped,
        staleness,
        stalenessText: renderSnapshotTargetStaleness(staleness),
        defaultBundle: DEFAULT_REFRESH_BUNDLE,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_bundle_start`,
    label: "App Automation Refresh Bundle Start",
    description: "Start a standard bundle of Slack, Calendar, Outlook, and Teams snapshot refreshers from the blessed catalog.",
    promptSnippet: "Use this to keep Slack, Calendar, Outlook mail/calendar, and Teams notification/calendar snapshots current without starting each refresher individually.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to include from the default bundle." }))),
      actions: Type.Optional(Type.Array(Type.String({ description: "Optional action ids to include from the default bundle." }))),
      params: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Shared action parameters such as session/playwrightSession." })),
      intervalSeconds: Type.Optional(Type.Number({ description: "Refresh interval for each started action. Defaults to 300 seconds; minimum 30 seconds." })),
      runImmediately: Type.Optional(Type.Boolean({ description: "Run each refresher immediately after starting. Defaults to false for bundle starts." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Per-refresh command timeout in milliseconds. Defaults to 30000." })),
    }),
    async execute(_toolCallId, params, signal) {
      const catalog = await resolveCatalog(params);
      const wantedApps = new Set((params.apps || []).map((value) => String(value)));
      const wantedActions = new Set((params.actions || []).map((value) => String(value)));
      const targets = DEFAULT_REFRESH_BUNDLE.filter((target) => (
        (!wantedApps.size || wantedApps.has(target.app))
        && (!wantedActions.size || wantedActions.has(target.action))
      ));
      const intervalSeconds = Math.max(
        MIN_REFRESH_INTERVAL_SECONDS,
        Number.parseInt(String(params.intervalSeconds || DEFAULT_REFRESH_INTERVAL_SECONDS), 10) || DEFAULT_REFRESH_INTERVAL_SECONDS,
      );
      const started = [];
      const skipped = [];
      for (const target of targets) {
        const plan = buildActionPlan({ app: target.app, action: target.action, params: params.params || {}, catalog: catalog.apps });
        if (!plan.execution.executable) {
          skipped.push({ app: target.app, action: target.action, reason: plan.execution.missingParams.length ? `missing ${plan.execution.missingParams.join(",")}` : "plan is not executable", blockedSteps: plan.execution.blockedSteps });
          continue;
        }
        const id = nextRefreshId(refreshState, plan.app.id, plan.action.id);
        const entry = {
          id,
          app: plan.app.id,
          action: plan.action.id,
          params: params.params || {},
          includeExternal: params.includeExternal !== false,
          timeoutMs: params.timeoutMs,
          intervalSeconds,
          running: true,
          inFlight: false,
          runCount: 0,
          errorCount: 0,
          consecutiveErrorCount: 0,
          lastRunAt: null,
          lastSuccessAt: null,
          lastStatus: "pending",
          lastError: null,
          lastRun: null,
        };
        entry.timer = setInterval(() => { void runRefresh(entry, signal); }, intervalSeconds * 1000);
        refreshState.refreshers.set(id, entry);
        if (params.runImmediately === true) await runRefresh(entry, signal);
        started.push(refreshPublicEntry(entry));
      }
      return textResult(`started ${started.length} app automation refreshers${skipped.length ? `; skipped ${skipped.length}` : ""}`, {
        started,
        skipped,
        defaultBundle: DEFAULT_REFRESH_BUNDLE,
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_status`,
    label: "App Automation Refresh Status",
    description: "List active app automation periodic refreshers and their last run status.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Optional refresher id to inspect." })),
    }),
    async execute(_toolCallId, params) {
      const entries = params.id
        ? [refreshState.refreshers.get(params.id)].filter(Boolean)
        : Array.from(refreshState.refreshers.values());
      const publicEntries = entries.map(refreshPublicEntry);
      const text = publicEntries.length
        ? publicEntries.map((entry) => {
          const details = [
            `lastSuccess=${entry.lastSuccessAt || "never"}`,
            entry.authRequiredCount ? `authRequired=${entry.authRequiredCount}` : null,
            entry.authRequiredPaths?.length ? `authPaths=${entry.authRequiredPaths.join(",")}` : null,
            entry.lastError ? `lastError=${String(entry.lastError).slice(0, 120)}` : null,
          ].filter(Boolean).join(" ");
          return `${entry.id}: ${entry.app}.${entry.action} every ${entry.intervalSeconds}s status=${entry.lastStatus} runs=${entry.runCount} errors=${entry.errorCount} consecutiveErrors=${entry.consecutiveErrorCount} ${details}`;
        }).join("\n")
        : "No active app automation refreshers.";
      return textResult(text, { refreshers: publicEntries });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_refresh_stop`,
    label: "App Automation Refresh Stop",
    description: "Stop one or all active app automation periodic refreshers.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Refresher id to stop. Omit when all=true." })),
      all: Type.Optional(Type.Boolean({ description: "Stop all refreshers." })),
    }),
    async execute(_toolCallId, params) {
      const ids = params.all ? Array.from(refreshState.refreshers.keys()) : [params.id].filter(Boolean);
      const stopped = ids.filter((id) => stopRefresh(id));
      return textResult(stopped.length ? `stopped ${stopped.join(", ")}` : "No matching app automation refreshers stopped.", {
        stopped,
        remaining: Array.from(refreshState.refreshers.values()).map(refreshPublicEntry),
      });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_snapshots_list`,
    label: "App Automation Snapshots List",
    description: "List persisted readable snapshot artifacts under the app automation state root.",
    promptSnippet: "Use this before ad-hoc filesystem reads when checking Slack, Outlook, Teams, calendar, or canvas app automation snapshots.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: "Optional app id, for example slack, outlook, teams, or canvas." })),
      limit: Type.Optional(Type.Number({ description: "Maximum artifacts to return. Defaults to 100." })),
    }),
    async execute(_toolCallId, params) {
      const root = stateRoot();
      const summary = await listSnapshotArtifacts({ root, app: params.app, limit: params.limit });
      return textResult(renderArtifactList(summary), { snapshots: summary });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_snapshots_digest`,
    label: "App Automation Snapshots Digest",
    description: "Summarize recent persisted app automation snapshot artifacts for quick agent context.",
    promptSnippet: "Use this for a compact latest-state digest across Slack, Outlook, Teams, calendar, and canvas snapshots.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: "Optional app id, for example slack, outlook, teams, or canvas." })),
      limit: Type.Optional(Type.Number({ description: "Maximum artifacts to digest. Defaults to 20." })),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to inspect per artifact. Defaults to 16000." })),
    }),
    async execute(_toolCallId, params) {
      const root = stateRoot();
      const digest = await digestSnapshotArtifacts({ root, app: params.app, limit: params.limit, maxBytes: params.maxBytes });
      return textResult(renderSnapshotDigest(digest), { digest });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_snapshot_links`,
    label: "App Automation Snapshot Links",
    description: "List safe links preserved in Slack, Outlook, Teams, calendar, or canvas JSON snapshots.",
    promptSnippet: "Use this to find actionable Slack message, Outlook/Teams meeting, or Calendar links from canonical snapshots without ad-hoc filesystem reads.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: "Optional app id, for example slack, outlook, teams, calendar, or all." })),
      artifactLimit: Type.Optional(Type.Number({ description: "Maximum JSON artifacts to scan. Defaults to 100." })),
      linkLimit: Type.Optional(Type.Number({ description: "Maximum links to return. Defaults to 100." })),
      query: Type.Optional(Type.String({ description: "Optional case-insensitive filter over app, kind, artifact path, label, URL, and source context." })),
      kind: Type.Optional(Type.String({ description: "Optional snapshot kind/action filter, for example notifications.snapshot, events.snapshot, or aliases like notifications/events/calendar." })),
      freshness: Type.Optional(Type.String({ description: "Optional link freshness filter: fresh, stale, or unknown." })),
      sort: Type.Optional(Type.String({ description: "Optional link sort: newest, oldest, freshest, stalest, app, or kind." })),
      staleAfterMinutes: Type.Optional(Type.Number({ description: "Age threshold for per-link freshness. Defaults to 60 minutes." })),
    }),
    async execute(_toolCallId, params) {
      const summary = await collectSnapshotLinks({ root: stateRoot(), app: params.app, query: params.query, freshness: params.freshness, kind: params.kind, sort: params.sort, artifactLimit: params.artifactLimit || 100, linkLimit: params.linkLimit || 100, staleAfterMinutes: params.staleAfterMinutes || 60 });
      return textResult(renderSnapshotLinks(summary), { links: summary });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_snapshots_staleness`,
    label: "App Automation Snapshots Staleness",
    description: "Report whether Slack, Outlook, Teams, calendar, and canvas snapshot artifacts are fresh, stale, or missing.",
    promptSnippet: "Use this to decide whether to run open/refresh bundles before relying on work-app snapshots.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to check. Defaults to slack, outlook, teams, canvas." }))),
      staleAfterMinutes: Type.Optional(Type.Number({ description: "Age threshold for stale snapshots. Defaults to 60 minutes." })),
    }),
    async execute(_toolCallId, params) {
      const root = stateRoot();
      const report = await snapshotStalenessReport({
        root,
        apps: params.apps?.length ? params.apps : ["slack", "calendar", "outlook", "teams", "canvas"],
        staleAfterMinutes: params.staleAfterMinutes || 60,
      });
      return textResult(renderSnapshotStaleness(report), { staleness: report });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_snapshots_cleanup_plan`,
    label: "App Automation Snapshots Cleanup Plan",
    description: "Dry-run cleanup planning for old readable app automation snapshot artifacts without deleting files.",
    promptSnippet: "Use this to inspect old Slack, Outlook, Teams, calendar, or canvas snapshot artifacts before any manual cleanup.",
    parameters: Type.Object({
      app: Type.Optional(Type.String({ description: "Optional app id, for example slack, outlook, teams, or canvas. Omit to scan all apps." })),
      keepLatest: Type.Optional(Type.Number({ description: "Readable artifacts to keep before marking older ones as cleanup candidates. Defaults to 20." })),
    }),
    async execute(_toolCallId, params) {
      const root = stateRoot();
      const plan = await planSnapshotCleanup({ root, app: params.app, keepLatest: params.keepLatest || 20 });
      return textResult(renderSnapshotCleanupPlan(plan), { cleanup: plan, dryRun: true });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_snapshot_read`,
    label: "App Automation Snapshot Read",
    description: "Read a persisted app automation snapshot artifact from the state root with path containment and size limits.",
    promptSnippet: "Use this to read canonical Slack, Outlook, Teams, calendar, or canvas snapshot JSON/Markdown artifacts.",
    parameters: Type.Object({
      file: Type.String({ description: "Artifact path relative to the app automation state root, for example snapshots/slack/notifications.md." }),
      maxBytes: Type.Optional(Type.Number({ description: "Maximum bytes to return. Defaults to 64000." })),
    }),
    async execute(_toolCallId, params) {
      const root = stateRoot();
      const artifact = await readSnapshotArtifact({ root, file: params.file, maxBytes: params.maxBytes });
      return textResult(artifact.content, { artifact });
    },
  });

  pi.registerTool({
    name: `${TOOL_PREFIX}_status`,
    label: "App Automation Status",
    description: "Inspect the app automation state root and persisted snapshot directories.",
    parameters: Type.Object({
      create: Type.Optional(Type.Boolean({ description: "Create the state root if missing. Defaults to false." })),
    }),
    async execute(_toolCallId, params) {
      const root = stateRoot();
      if (params.create) await mkdir(root, { recursive: true });
      const summary = await pathSummary(root);
      const catalog = await resolveCatalog(params);
      const apps = catalog.apps.map((app) => ({ id: app.id, label: app.label, source: app.source || "built-in" }));
      return textResult(
        `app-automation stateRoot=${root} exists=${summary.exists} apps=${apps.map((app) => app.id).join(",")}`,
        { state: summary, apps, external: catalog.external, specVersion: APP_AUTOMATION_SPEC_VERSION },
      );
    },
  });

  pi.registerCommand("tendril-app", {
    description: "List, doctor, overview, links, staleness, refresh-staleness, or plan blessed API-less app automation actions. Usage: /tendril-app [doctor [probe]|overview|links [[app|all] [fresh|stale|unknown|freshness:<state>] [kind:<kind>] [sort:<order>] [limit:<n>] [query]]|staleness|refresh-staleness|bundle|open-bundle|stale-refresh|app action]",
    handler: async (args, ctx) => {
      const words = String(args || "").trim().split(/\s+/).filter(Boolean);
      const catalog = await resolveCatalog();
      if (words[0] === "doctor") {
        const rootSummary = await pathSummary(stateRoot());
        const actionDiagnostics = DEFAULT_DOCTOR_ACTIONS.map((target) => {
          try {
            const plan = buildActionPlan({ app: target.app, action: target.action, catalog: catalog.apps });
            return {
              app: target.app,
              action: target.action,
              executable: plan.execution.executable,
              missingParams: plan.execution.missingParams,
              blockedSteps: plan.execution.blockedSteps,
            };
          } catch (error) {
            return { app: target.app, action: target.action, executable: false, error: error.message };
          }
        });
        const tendrilProbe = words.includes("probe") || words.includes("--probe") ? await probeTendrilBridge(pi, { timeoutMs: 5000 }) : null;
        ctx.ui.notify(renderDoctorReport({ rootSummary, catalog, playwrightCli: playwrightCliCommand(), tendrilBridge: tendrilCommandSummary(), tendrilProbe, actionDiagnostics }), "info");
        return;
      }
      if (words[0] === "overview") {
        const wantedIds = words.slice(1).length ? words.slice(1) : ["slack", "calendar", "outlook", "teams", "canvas"];
        const apps = wantedIds
          .map((id) => catalog.apps.find((app) => app.id === id))
          .filter(Boolean)
          .map((app) => ({ id: app.id, label: app.label, category: app.category, actions: app.actions.map((action) => action.id) }));
        const root = stateRoot();
        const snapshotDigests = [];
        for (const app of apps) {
          snapshotDigests.push({ ...(await digestSnapshotArtifacts({ root, app: app.id, limit: 3 })), app: app.id });
        }
        const refreshers = Array.from(refreshState.refreshers.values())
          .filter((entry) => wantedIds.includes(entry.app))
          .map(refreshPublicEntry);
        const snapshotStaleness = await snapshotStalenessReport({ root, apps: apps.map((app) => app.id), staleAfterMinutes: 60 });
        const refreshStaleness = await buildRefreshBundleStaleness({ catalog, params: { apps: wantedIds.filter((id) => id !== "canvas"), staleAfterMinutes: 60 } });
        let snapshotLinks = null;
        if (words.includes("links") || words.includes("--links")) {
          const links = [];
          let truncated = false;
          for (const app of apps) {
            const summary = await collectSnapshotLinks({ root, app: app.id, linkLimit: 3, staleAfterMinutes: 60 });
            links.push(...summary.links);
            truncated = truncated || summary.truncated;
          }
          snapshotLinks = { root, snapshotRoot: path.join(root, "snapshots"), exists: true, links, truncated };
        }
        ctx.ui.notify(renderWorkAppOverview({ apps, refreshers, snapshotDigests, snapshotLinks, snapshotStaleness, refreshStaleness, root }), "info");
        return;
      }
      if (words[0] === "links") {
        const filters = parseLinkCommandArgs(words.slice(1), { appIds: catalog.apps.map((app) => app.id) });
        const summary = await collectSnapshotLinks({ root: stateRoot(), app: filters.app, query: filters.query, freshness: filters.freshness, kind: filters.kind, sort: filters.sort, linkLimit: filters.linkLimit || 100, staleAfterMinutes: 60 });
        ctx.ui.notify(renderSnapshotLinks(summary), "info");
        return;
      }
      if (words[0] === "staleness") {
        const wantedIds = words.slice(1).length ? words.slice(1) : ["slack", "calendar", "outlook", "teams", "canvas"];
        const report = await snapshotStalenessReport({ root: stateRoot(), apps: wantedIds, staleAfterMinutes: 60 });
        ctx.ui.notify(renderSnapshotStaleness(report), "info");
        return;
      }
      if (words[0] === "refresh-staleness") {
        const report = await buildRefreshBundleStaleness({ catalog, params: { apps: words.slice(1), staleAfterMinutes: 60 } });
        ctx.ui.notify(renderSnapshotTargetStaleness(report), "info");
        return;
      }
      if (words[0] === "bundle") {
        ctx.ui.notify(renderDefaultRefreshBundle(), "info");
        return;
      }
      if (words[0] === "open-bundle") {
        ctx.ui.notify(renderDefaultOpenBundle(), "info");
        return;
      }
      if (words[0] === "stale-refresh") {
        ctx.ui.notify(renderDefaultStaleRefresh(), "info");
        return;
      }
      if (words.length >= 2) {
        const plan = buildActionPlan({ app: words[0], action: words[1], catalog: catalog.apps });
        ctx.ui.notify(renderPlan(plan), "info");
        return;
      }
      if (words.length === 1) {
        const app = catalog.apps.find((entry) => entry.id === words[0]);
        ctx.ui.notify(app ? renderAppList([app]) : `Unknown app: ${words[0]}`, app ? "info" : "warning");
        return;
      }
      ctx.ui.notify(`${renderAppList(catalog.apps)}\n\n${renderDefaultOpenBundle()}\n\n${renderDefaultRefreshBundle()}\n\n${renderDefaultStaleRefresh()}`, "info");
    },
  });
}
