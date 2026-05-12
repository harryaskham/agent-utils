import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setInterval, clearInterval } from "node:timers";

import { Type } from "@sinclair/typebox";

import {
  digestSnapshotArtifacts,
  listSnapshotArtifacts,
  readSnapshotArtifact,
  renderArtifactList,
  renderSnapshotDigest,
} from "./app-automation/artifacts.js";
import {
  APP_AUTOMATION_SPEC_VERSION,
  buildActionPlan,
  loadCatalog,
  renderAppList,
  renderPlan,
  stateRoot,
} from "./app-automation/catalog.js";
import { syncMarkdownCanvas } from "./app-automation/canvas.js";
import { prepareEditorReplace } from "./app-automation/editor.js";
import { buildGenericSnapshot, writeGenericSnapshot } from "./app-automation/generic-snapshot.js";
import { microsoftExtractorScript } from "./app-automation/microsoft.js";
import { authMissingHint, prepareDomExtractStep, playwrightSessionArgs } from "./app-automation/playwright-bridge.js";
import {
  buildSlackNotificationSnapshot,
  renderSlackNotificationMarkdown,
  slackExtractorScript,
} from "./app-automation/slack.js";

const TOOL_PREFIX = "app_automation";
const DEFAULT_REFRESH_INTERVAL_SECONDS = 300;
const MIN_REFRESH_INTERVAL_SECONDS = 30;
const DEFAULT_REFRESH_BUNDLE = [
  { app: "slack", action: "notifications.snapshot" },
  { app: "outlook", action: "notifications.snapshot" },
  { app: "outlook", action: "calendar.snapshot" },
  { app: "teams", action: "notifications.snapshot" },
  { app: "teams", action: "calendar.snapshot" },
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
    results.push({
      index: step.index,
      kind: step.kind,
      command: step.command,
      args: step.args,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      status: result.code === 0 ? "ok" : "error",
      authRequired: result.code !== 0 && authMissingHint(result),
    });
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
  return {
    status: results.every((result) => result.status === "ok") ? "ok" : "error",
    results,
  };
}

async function resolveCatalog(params = {}) {
  return loadCatalog({ includeExternal: params.includeExternal !== false });
}

function refreshPublicEntry(entry) {
  return {
    id: entry.id,
    app: entry.app,
    action: entry.action,
    intervalSeconds: entry.intervalSeconds,
    running: entry.running,
    inFlight: entry.inFlight,
    runCount: entry.runCount,
    errorCount: entry.errorCount,
    lastRunAt: entry.lastRunAt,
    lastStatus: entry.lastStatus,
    lastError: entry.lastError,
  };
}

function renderWorkAppOverview({ apps, refreshers, snapshotDigests, root }) {
  const lines = [`app automation overview stateRoot=${root}`];
  lines.push(`apps: ${apps.map((app) => `${app.id}(${app.actions?.length || 0} actions)`).join(", ") || "none"}`);
  lines.push(refreshers.length
    ? `refreshers: ${refreshers.map((entry) => `${entry.id}:${entry.lastStatus}/runs=${entry.runCount}`).join(", ")}`
    : "refreshers: none");
  for (const digest of snapshotDigests) {
    const rendered = renderSnapshotDigest(digest).split("\n").slice(0, 5).join("\n  ");
    lines.push(`${digest.app || "snapshots"}: ${rendered}`);
  }
  return lines.join("\n");
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
      entry.lastRun = run;
    } catch (error) {
      entry.errorCount += 1;
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
    promptSnippet: "Discover blessed app automation configs for Slack, Outlook, Teams, and canvas workflows before using raw Playwright/Tendril.",
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
    name: `${TOOL_PREFIX}_overview`,
    label: "App Automation Overview",
    description: "Summarize configured work apps, active refreshers, and latest snapshot digests for Slack, Outlook, Teams, calendar, and canvas workflows.",
    promptSnippet: "Use this first when orienting on current Slack, Outlook, Teams, calendar, or canvas app automation state.",
    parameters: Type.Object({
      apps: Type.Optional(Type.Array(Type.String({ description: "Optional app ids to include. Defaults to slack, outlook, teams, canvas." }))),
      includeSnapshots: Type.Optional(Type.Boolean({ description: "Include snapshot digest summaries. Defaults to true." })),
      snapshotLimitPerApp: Type.Optional(Type.Number({ description: "Readable snapshot artifacts to summarize per app. Defaults to 3." })),
      includeExternal: Type.Optional(Type.Boolean({ description: "Load JSON app configs from APP_AUTOMATION_CONFIG_DIR. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      const catalog = await resolveCatalog(params);
      const wantedIds = params.apps?.length ? params.apps.map((app) => String(app)) : ["slack", "outlook", "teams", "canvas"];
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
      return textResult(renderWorkAppOverview({ apps, refreshers, snapshotDigests, root }), {
        apps,
        refreshers,
        snapshotDigests,
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
    name: `${TOOL_PREFIX}_refresh_bundle_start`,
    label: "App Automation Refresh Bundle Start",
    description: "Start a standard bundle of Slack, Outlook, and Teams snapshot refreshers from the blessed catalog.",
    promptSnippet: "Use this to keep Slack, Outlook mail/calendar, and Teams notification/calendar snapshots current without starting each refresher individually.",
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
          lastRunAt: null,
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
        ? publicEntries.map((entry) => `${entry.id}: ${entry.app}.${entry.action} every ${entry.intervalSeconds}s status=${entry.lastStatus} runs=${entry.runCount} errors=${entry.errorCount}`).join("\n")
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
    description: "List or plan blessed API-less app automation actions. Usage: /tendril-app [app] [action]",
    handler: async (args, ctx) => {
      const words = String(args || "").trim().split(/\s+/).filter(Boolean);
      const catalog = await resolveCatalog();
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
      ctx.ui.notify(renderAppList(catalog.apps), "info");
    },
  });
}
