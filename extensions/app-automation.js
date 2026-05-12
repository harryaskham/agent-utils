import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import {
  APP_AUTOMATION_SPEC_VERSION,
  buildActionPlan,
  loadCatalog,
  renderAppList,
  renderPlan,
  stateRoot,
} from "./app-automation/catalog.js";
import { syncMarkdownCanvas } from "./app-automation/canvas.js";
import {
  buildSlackNotificationSnapshot,
  renderSlackNotificationMarkdown,
  slackExtractorScript,
} from "./app-automation/slack.js";

const TOOL_PREFIX = "app_automation";

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
      let input = plan.params.extraction || plan.params.sourceJson || plan.params.sourceText || {};
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
    });
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

export default function appAutomationExtension(pi) {
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
