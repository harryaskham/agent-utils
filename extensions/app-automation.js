import { mkdir, readdir, stat } from "node:fs/promises";

import { Type } from "@sinclair/typebox";

import {
  APP_AUTOMATION_SPEC_VERSION,
  buildActionPlan,
  listAppConfigs,
  renderAppList,
  renderPlan,
  stateRoot,
} from "./app-automation/catalog.js";

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

export default function appAutomationExtension(pi) {
  pi.registerTool({
    name: `${TOOL_PREFIX}_list`,
    label: "App Automation List",
    description: "List blessed API-less web app automation configs and their available high-level actions.",
    promptSnippet: "Discover blessed app automation configs for Slack, Outlook, Teams, and canvas workflows before using raw Playwright/Tendril.",
    parameters: Type.Object({
      includeActions: Type.Optional(Type.Boolean({ description: "Include action summaries. Defaults to true." })),
    }),
    async execute(_toolCallId, params) {
      const apps = listAppConfigs({ includeActions: params.includeActions !== false });
      return textResult(renderAppList(apps), {
        apps,
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
    }),
    async execute(_toolCallId, params) {
      const plan = buildActionPlan({ app: params.app, action: params.action, params: params.params || {} });
      return textResult(renderPlan(plan), { plan });
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
      const apps = listAppConfigs({ includeActions: false });
      return textResult(
        `app-automation stateRoot=${root} exists=${summary.exists} apps=${apps.map((app) => app.id).join(",")}`,
        { state: summary, apps, specVersion: APP_AUTOMATION_SPEC_VERSION },
      );
    },
  });

  pi.registerCommand("tendril-app", {
    description: "List or plan blessed API-less app automation actions. Usage: /tendril-app [app] [action]",
    handler: async (args, ctx) => {
      const words = String(args || "").trim().split(/\s+/).filter(Boolean);
      if (words.length >= 2) {
        const plan = buildActionPlan({ app: words[0], action: words[1] });
        ctx.ui.notify(renderPlan(plan), "info");
        return;
      }
      const apps = listAppConfigs();
      if (words.length === 1) {
        const app = apps.find((entry) => entry.id === words[0]);
        ctx.ui.notify(app ? renderAppList([app]) : `Unknown app: ${words[0]}`, app ? "info" : "warning");
        return;
      }
      ctx.ui.notify(renderAppList(apps), "info");
    },
  });
}
