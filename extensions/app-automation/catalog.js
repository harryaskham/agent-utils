import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildBrowserOpenCommand, buildDomExtractCommand } from "./playwright-bridge.js";

export const APP_AUTOMATION_SPEC_VERSION = 1;
export const DEFAULT_STATE_ROOT = "~/.local/state/agent-utils/app-automation";
export const DEFAULT_CONFIG_DIR = "~/.config/agent-utils/app-automation/apps.d";

export function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

export function stateRoot(env = process.env) {
  return path.resolve(expandHome(env.APP_AUTOMATION_STATE_ROOT || DEFAULT_STATE_ROOT));
}

export function configDir(env = process.env) {
  return path.resolve(expandHome(env.APP_AUTOMATION_CONFIG_DIR || DEFAULT_CONFIG_DIR));
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
          { kind: "dom.extract", script: "slackExtractorScript", output: "slack-extraction.json" },
          { kind: "slack.notifications.snapshot" },
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
        description: "Render Markdown to canonical artifacts and prepare a browser paste/import plan for a web canvas/editor target.",
        params: ["sourcePath"],
        outputs: ["snapshots/canvas/latest.md", "snapshots/canvas/latest.html", "snapshots/canvas/paste.txt", "snapshots/canvas/sync.json"],
        plan: [
          { kind: "canvas.sync-markdown" },
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
        label: "Snapshot mail notifications",
        mode: "read",
        driver: "playwright",
        description: "Conservative read-only normalization of supplied Outlook mail notification extraction text/JSON.",
        outputs: ["snapshots/outlook/notifications.snapshot.json", "snapshots/outlook/notifications.snapshot.md"],
        plan: [{ kind: "generic.notifications.snapshot", app: "outlook", includePatterns: ["unread", "mention", "flag", "important", "meeting", "calendar", "invite"] }],
      },
      {
        id: "calendar.snapshot",
        label: "Snapshot Outlook calendar items",
        mode: "read",
        driver: "playwright",
        description: "Conservative read-only normalization of supplied Outlook calendar extraction text/JSON.",
        outputs: ["snapshots/outlook/calendar.snapshot.json", "snapshots/outlook/calendar.snapshot.md"],
        plan: [{ kind: "generic.notifications.snapshot", app: "outlook", includePatterns: ["meeting", "calendar", "today", "tomorrow", "starts", "accepted", "tentative"] }],
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
        description: "Conservative read-only normalization of supplied Teams chat and meeting notification extraction text/JSON.",
        outputs: ["snapshots/teams/notifications.snapshot.json", "snapshots/teams/notifications.snapshot.md"],
        plan: [{ kind: "generic.notifications.snapshot", app: "teams", includePatterns: ["unread", "mention", "chat", "meeting", "call", "reply", "activity"] }],
      },
      {
        id: "calendar.snapshot",
        label: "Snapshot Teams calendar/meeting items",
        mode: "read",
        driver: "playwright",
        description: "Conservative read-only normalization of supplied Teams calendar or meeting extraction text/JSON.",
        outputs: ["snapshots/teams/calendar.snapshot.json", "snapshots/teams/calendar.snapshot.md"],
        plan: [{ kind: "generic.notifications.snapshot", app: "teams", includePatterns: ["meeting", "calendar", "starts", "join", "today", "tomorrow"] }],
      },
    ],
  },
];

export function publicAppConfig(app, { includeActions = true } = {}) {
  const entry = {
    id: app.id,
    label: app.label,
    url: app.url,
    category: app.category,
    auth: app.auth,
    source: app.source || "built-in",
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
}

export function listAppConfigs({ includeActions = true, catalog = BLESSED_APPS } = {}) {
  return catalog.map((app) => publicAppConfig(app, { includeActions }));
}

export function findApp(appId, catalog = BLESSED_APPS) {
  const normalized = sanitizeId(appId);
  return catalog.find((app) => app.id === normalized);
}

export function findAction(app, actionId) {
  if (!app) return undefined;
  const wanted = String(actionId || "").trim();
  return app.actions.find((action) => action.id === wanted || sanitizeId(action.id) === sanitizeId(wanted));
}

function ensureArray(value, fallback = []) {
  return Array.isArray(value) ? value : fallback;
}

function normalizeStringArray(value) {
  return ensureArray(value).filter((item) => typeof item === "string");
}

export function normalizeAppConfig(raw, { source = "external" } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("app config must be an object");
  const id = sanitizeId(raw.id);
  if (!id) throw new Error("app config requires a non-empty id");
  const actions = ensureArray(raw.actions).map((action, index) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      throw new Error(`app ${id} action ${index + 1} must be an object`);
    }
    const actionId = String(action.id || "").trim();
    if (!actionId) throw new Error(`app ${id} action ${index + 1} requires id`);
    return {
      id: actionId,
      label: String(action.label || actionId),
      mode: String(action.mode || "read"),
      driver: String(action.driver || "playwright"),
      description: String(action.description || ""),
      params: normalizeStringArray(action.params),
      outputs: normalizeStringArray(action.outputs),
      plan: ensureArray(action.plan).map((step) => cloneJson(step)),
    };
  });
  return {
    id,
    label: String(raw.label || id),
    url: String(raw.url || "about:blank"),
    category: String(raw.category || "custom"),
    auth: raw.auth && typeof raw.auth === "object" ? cloneJson(raw.auth) : { strategy: "app-specific", notes: [] },
    actions,
    source,
  };
}

async function readExternalConfigFile(filePath) {
  const rawText = await readFile(filePath, "utf8");
  const parsed = JSON.parse(rawText);
  const rawApps = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.apps) ? parsed.apps : [parsed]);
  return rawApps.map((app) => normalizeAppConfig(app, { source: filePath }));
}

export async function loadExternalAppConfigs({ env = process.env } = {}) {
  const dir = configDir(env);
  const exists = await stat(dir).then((info) => info.isDirectory(), () => false);
  if (!exists) return { configDir: dir, apps: [], errors: [] };
  const entries = await readdir(dir, { withFileTypes: true });
  const apps = [];
  const errors = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dir, entry.name);
    try {
      apps.push(...await readExternalConfigFile(filePath));
    } catch (error) {
      errors.push({ path: filePath, message: error.message });
    }
  }
  return { configDir: dir, apps, errors };
}

export async function loadCatalog({ env = process.env, includeExternal = true } = {}) {
  const builtIns = BLESSED_APPS.map((app) => ({ ...cloneJson(app), source: app.source || "built-in" }));
  if (!includeExternal) return { apps: builtIns, external: { configDir: configDir(env), apps: [], errors: [] } };
  const external = await loadExternalAppConfigs({ env });
  const byId = new Map(builtIns.map((app) => [app.id, app]));
  for (const app of external.apps) byId.set(app.id, app);
  return { apps: Array.from(byId.values()), external };
}

function resolveParamValue(step, key, params) {
  if (typeof step[key] === "string") return step[key];
  const paramKey = step[`${key}Param`];
  if (typeof paramKey === "string") return params[paramKey];
  return undefined;
}

function coerceArg(value, params) {
  if (typeof value === "string" && value.startsWith("$params.")) return String(params[value.slice(8)] ?? "");
  return String(value ?? "");
}

export function buildStepCommand(step, params = {}) {
  if (!step || typeof step !== "object") return { executable: false, reason: "step is not an object" };
  if (step.kind === "browser.open") return buildBrowserOpenCommand(step, params);
  if (step.kind === "tendril.run") {
    const target = resolveParamValue(step, "target", params);
    const dsl = resolveParamValue(step, "dsl", params);
    if (!target || !dsl) return { executable: false, reason: "tendril.run requires target and dsl" };
    return { executable: true, command: "tendril", args: ["run", "--window", String(target), String(dsl)] };
  }
  if (step.kind === "cli.exec") {
    const command = String(step.command || "");
    const allowlist = new Set(["playwright-cli", "tendril", "pandoc"]);
    if (!allowlist.has(command)) return { executable: false, reason: `command not in allowlist: ${command}` };
    return { executable: true, command, args: ensureArray(step.args).map((arg) => coerceArg(arg, params)) };
  }
  if (step.kind === "dom.extract") return { ...buildDomExtractCommand(step, params), kind: "dom.extract" };
  if (step.kind === "wait") return { executable: true, internal: "wait", args: [] };
  if (step.kind === "snapshot.write") return { executable: true, internal: "snapshot.write", args: [] };
  if (step.kind === "slack.notifications.snapshot") return { executable: true, internal: "slack.notifications.snapshot", args: [] };
  if (step.kind === "canvas.sync-markdown") return { executable: true, internal: "canvas.sync-markdown", args: [] };
  if (step.kind === "generic.notifications.snapshot") return { executable: true, internal: "generic.notifications.snapshot", args: [] };
  return { executable: false, reason: `no runner for step kind: ${step.kind || "unknown"}` };
}

export function buildExecutionPlan(plan) {
  const stepCommands = plan.steps.map((step, index) => ({ index, kind: step.kind || "unknown", ...buildStepCommand(step, plan.params) }));
  const executable = plan.action.missingParams.length === 0 && stepCommands.every((step) => step.executable);
  return {
    executable,
    missingParams: plan.action.missingParams,
    blockedSteps: stepCommands.filter((step) => !step.executable),
    stepCommands,
  };
}

export function buildActionPlan({ app: appId, action: actionId, params = {}, env = process.env, catalog = BLESSED_APPS }) {
  const app = findApp(appId, catalog);
  if (!app) throw new Error(`Unknown app automation config: ${appId}`);
  const action = findAction(app, actionId);
  if (!action) throw new Error(`Unknown action '${actionId}' for app '${app.id}'`);

  const requiredParams = action.params || [];
  const missingParams = requiredParams.filter((name) => params[name] === undefined || params[name] === "");
  const root = stateRoot(env);
  const plan = {
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
    nextImplementationBeads: ["bd-de1af2", "bd-cb5a40", "bd-829091", "bd-a7835e"],
    steps: cloneJson(action.plan || []),
    notes: [
      "Plans are deterministic. The runner executes only allowlisted cli.exec, tendril.run, and snapshot.write steps.",
      "High-level browser.open, dom.extract, document.export, and editor.replace steps remain planned until app-specific driver beads land.",
    ],
  };
  plan.execution = buildExecutionPlan(plan);
  plan.executable = plan.execution.executable;
  return plan;
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
