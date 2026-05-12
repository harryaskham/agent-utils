import os from "node:os";
import path from "node:path";

export const APP_AUTOMATION_SPEC_VERSION = 1;
export const DEFAULT_STATE_ROOT = "~/.local/state/agent-utils/app-automation";

export function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

export function stateRoot(env = process.env) {
  return path.resolve(expandHome(env.APP_AUTOMATION_STATE_ROOT || DEFAULT_STATE_ROOT));
}

export function sanitizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export const BLESSED_APPS = [
  {
    id: "slack",
    label: "Slack Web",
    url: "https://app.slack.com/client",
    category: "messaging",
    auth: {
      strategy: "reuse-browser-session",
      notes: [
        "Prefer an existing Playwright/browser profile or system-authenticated Slack web session.",
        "Never store Slack cookies or tokens in repo files or snapshot artifacts.",
        "If auth is missing, the action should return a login-required status and leave the browser open for operator login.",
      ],
    },
    actions: [
      {
        id: "open",
        label: "Open Slack web",
        mode: "interactive",
        driver: "playwright",
        description: "Open or reuse Slack web in a Playwright-controlled browser for later DOM or Tendril interactions.",
        outputs: ["browser-session"],
        plan: [
          { kind: "browser.open", url: "https://app.slack.com/client", reuseSession: true },
          { kind: "wait", condition: "workspace-or-login-visible" },
        ],
      },
      {
        id: "notifications.snapshot",
        label: "Snapshot unread Slack notifications",
        mode: "read",
        driver: "playwright",
        description: "Extract a conservative unread/channel/DM notification summary and persist it as canonical JSON and Markdown.",
        outputs: ["snapshots/slack/notifications.json", "snapshots/slack/notifications.md"],
        plan: [
          { kind: "browser.open", url: "https://app.slack.com/client", reuseSession: true },
          { kind: "dom.extract", target: "workspace-sidebar", selectors: ["[data-qa]", "[aria-label]"] },
          { kind: "snapshot.write", format: ["json", "markdown"], name: "notifications" },
        ],
      },
    ],
  },
  {
    id: "canvas",
    label: "Markdown canvas sync",
    url: "about:blank",
    category: "canvas",
    auth: {
      strategy: "app-specific",
      notes: [
        "Canvas targets vary by product; configs should provide the target URL and paste/import selector.",
        "Markdown source stays in the agent workspace; exported HTML/plain text goes to state snapshots.",
      ],
    },
    actions: [
      {
        id: "sync-markdown",
        label: "Export Markdown and sync to canvas",
        mode: "write",
        driver: "playwright-or-tendril",
        description: "Render Markdown via pandoc or a configured exporter and paste/import it into a web canvas/editor target.",
        params: ["sourcePath", "targetUrl", "targetSelector", "exportFormat"],
        outputs: ["snapshots/canvas/latest.md", "snapshots/canvas/latest.html", "snapshots/canvas/sync.json"],
        plan: [
          { kind: "file.read", param: "sourcePath" },
          { kind: "document.export", command: "pandoc", formatParam: "exportFormat", defaultFormat: "html" },
          { kind: "browser.open", urlParam: "targetUrl", reuseSession: true },
          { kind: "editor.replace", selectorParam: "targetSelector", input: "exported-document" },
          { kind: "snapshot.write", format: ["json", "markdown", "html"], name: "canvas-sync" },
        ],
      },
    ],
  },
  {
    id: "outlook",
    label: "Outlook Web",
    url: "https://outlook.office.com/mail/",
    category: "mail-calendar",
    auth: { strategy: "reuse-browser-session", notes: ["Use existing Microsoft web auth where available."] },
    actions: [
      {
        id: "notifications.snapshot",
        label: "Snapshot mail/calendar notifications",
        mode: "read",
        driver: "playwright",
        description: "Future blessed read-only action for inbox/calendar notification summaries.",
        outputs: ["snapshots/outlook/notifications.json"],
        plan: [{ kind: "placeholder", nextBead: "bd-a7835e" }],
      },
    ],
  },
  {
    id: "teams",
    label: "Teams Web",
    url: "https://teams.microsoft.com/v2/",
    category: "messaging-meetings",
    auth: { strategy: "reuse-browser-session", notes: ["Use existing Microsoft web auth where available."] },
    actions: [
      {
        id: "notifications.snapshot",
        label: "Snapshot chat/meeting notifications",
        mode: "read",
        driver: "playwright",
        description: "Future blessed read-only action for Teams notification summaries.",
        outputs: ["snapshots/teams/notifications.json"],
        plan: [{ kind: "placeholder", nextBead: "bd-a7835e" }],
      },
    ],
  },
];

export function listAppConfigs({ includeActions = true } = {}) {
  return BLESSED_APPS.map((app) => {
    const entry = {
      id: app.id,
      label: app.label,
      url: app.url,
      category: app.category,
      auth: app.auth,
    };
    if (includeActions) {
      entry.actions = app.actions.map((action) => ({
        id: action.id,
        label: action.label,
        mode: action.mode,
        driver: action.driver,
        description: action.description,
        params: action.params || [],
        outputs: action.outputs || [],
      }));
    }
    return entry;
  });
}

export function findApp(appId) {
  const normalized = sanitizeId(appId);
  return BLESSED_APPS.find((app) => app.id === normalized);
}

export function findAction(app, actionId) {
  if (!app) return undefined;
  const wanted = String(actionId || "").trim();
  return app.actions.find((action) => action.id === wanted || sanitizeId(action.id) === sanitizeId(wanted));
}

export function buildActionPlan({ app: appId, action: actionId, params = {}, env = process.env }) {
  const app = findApp(appId);
  if (!app) throw new Error(`Unknown app automation config: ${appId}`);
  const action = findAction(app, actionId);
  if (!action) throw new Error(`Unknown action '${actionId}' for app '${app.id}'`);

  const requiredParams = action.params || [];
  const missingParams = requiredParams.filter((name) => params[name] === undefined || params[name] === "");
  const root = stateRoot(env);
  return {
    version: APP_AUTOMATION_SPEC_VERSION,
    app: { id: app.id, label: app.label, url: app.url, category: app.category, auth: app.auth },
    action: {
      id: action.id,
      label: action.label,
      mode: action.mode,
      driver: action.driver,
      description: action.description,
      outputs: action.outputs || [],
      requiredParams,
      missingParams,
    },
    params: cloneJson(params || {}),
    stateRoot: root,
    snapshotDir: path.join(root, "snapshots", app.id),
    dryRun: true,
    executable: false,
    nextImplementationBeads: ["bd-afa933", "bd-de1af2", "bd-cb5a40", "bd-829091", "bd-a7835e"],
    steps: cloneJson(action.plan || []),
    notes: [
      "This scaffold intentionally returns plans only; execution lands in bd-afa933.",
      "Agents should prefer these blessed action plans over ad-hoc Playwright/Tendril commands once execution is implemented.",
    ],
  };
}

export function renderAppList(apps) {
  return apps
    .map((app) => {
      const actions = (app.actions || []).map((action) => `${action.id} [${action.mode}/${action.driver}]`).join(", ");
      return `${app.id}: ${app.label} — ${actions || "no actions"}`;
    })
    .join("\n");
}

export function renderPlan(plan) {
  const missing = plan.action.missingParams.length ? ` missingParams=${plan.action.missingParams.join(",")}` : "";
  const steps = plan.steps.map((step, index) => `${index + 1}. ${step.kind}`).join("\n");
  return [
    `${plan.app.id}.${plan.action.id}: ${plan.action.label} (${plan.action.mode}/${plan.action.driver})${missing}`,
    `stateRoot: ${plan.stateRoot}`,
    `snapshotDir: ${plan.snapshotDir}`,
    "steps:",
    steps || "(no steps)",
  ].join("\n");
}
