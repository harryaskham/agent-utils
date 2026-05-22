// Pi extension: preserve operator-owned true defaults for model/provider/thinking.
//
// Pi's built-in runtime controls may update defaultProvider/defaultModel and
// defaultThinkingLevel in settings.json. This extension treats a namespaced set
// of true-default settings as immutable-by-convention and copies them back onto
// Pi's built-in default keys during extension load, session start, and clean
// shutdown. Runtime model/effort switching remains allowed; this only guards
// persisted defaults.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function normalizeThinkingLevel(value) {
  const level = normalizeString(value)?.toLowerCase();
  return level && THINKING_LEVELS.has(level) ? level : undefined;
}

function expandHome(path) {
  const text = String(path || "");
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return text;
}

export function settingsFileCandidates({ env = process.env, cwd = process.cwd() } = {}) {
  const candidates = [];
  const add = (path, scope) => {
    if (!path || candidates.some((entry) => entry.path === path)) return;
    candidates.push({ path, scope });
  };
  add(join(expandHome(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), "settings.json"), "global");
  add(join(cwd, ".pi", "settings.json"), "project");
  return candidates;
}

function readSettingsFile(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function selectSettingsSource(options = {}) {
  const existing = settingsFileCandidates(options)
    .map((entry) => ({ ...entry, settings: readSettingsFile(entry.path) }))
    .filter((entry) => entry.settings && typeof entry.settings === "object");
  const withTrueDefaults = existing.filter((entry) => hasTrueDefaults(entry.settings));
  if (withTrueDefaults.length > 0) return withTrueDefaults.at(-1);
  return existing[0] || settingsFileCandidates(options)[0];
}

export function extractTrueDefaults(settings = {}) {
  const agentUtils = settings.agentUtils || {};
  const scoped = agentUtils.trueDefaults || agentUtils.piTrueDefaults || settings.trueDefaults || {};
  let provider = normalizeString(
    scoped.provider ?? scoped.defaultProvider ?? agentUtils.trueDefaultProvider ?? settings.trueDefaultProvider,
  );
  let model = normalizeString(
    scoped.model ?? scoped.modelId ?? scoped.defaultModel ?? agentUtils.trueDefaultModel ?? settings.trueDefaultModel,
  );
  const thinkingLevel = normalizeThinkingLevel(
    scoped.thinkingLevel ?? scoped.defaultThinkingLevel ?? scoped.effort ?? scoped.trueDefaultEffort ??
      agentUtils.trueDefaultThinkingLevel ?? agentUtils.trueDefaultEffort ??
      settings.trueDefaultThinkingLevel ?? settings.trueDefaultEffort,
  );

  if (model?.includes("/") && !provider) {
    const slash = model.indexOf("/");
    provider = normalizeString(model.slice(0, slash));
    model = normalizeString(model.slice(slash + 1));
  }

  return { provider, model, thinkingLevel };
}

export function hasTrueDefaults(settings = {}) {
  const defaults = extractTrueDefaults(settings);
  return Boolean(defaults.provider || defaults.model || defaults.thinkingLevel);
}

function applyDefaultsToSettings(settings, defaults) {
  const next = { ...(settings || {}) };
  let changed = false;
  if (defaults.provider && next.defaultProvider !== defaults.provider) {
    next.defaultProvider = defaults.provider;
    changed = true;
  }
  if (defaults.model && next.defaultModel !== defaults.model) {
    next.defaultModel = defaults.model;
    changed = true;
  }
  if (defaults.thinkingLevel && next.defaultThinkingLevel !== defaults.thinkingLevel) {
    next.defaultThinkingLevel = defaults.thinkingLevel;
    changed = true;
  }
  return { settings: next, changed };
}

export function restoreTrueDefaultSettings(options = {}) {
  const source = selectSettingsSource(options);
  const settings = source.settings || readSettingsFile(source.path) || {};
  const defaults = extractTrueDefaults(settings);
  if (!hasTrueDefaults(settings)) {
    return { ok: true, changed: false, reason: "no true defaults configured", path: source.path, scope: source.scope, defaults };
  }
  const applied = applyDefaultsToSettings(settings, defaults);
  if (applied.changed && options.write !== false) {
    writeFileSync(source.path, `${JSON.stringify(applied.settings, null, 2)}\n`);
  }
  return { ok: true, changed: applied.changed, path: source.path, scope: source.scope, defaults };
}

function findTrueDefaultModel(ctx, defaults) {
  if (!defaults.provider || !defaults.model) return null;
  return ctx?.modelRegistry?.find?.(defaults.provider, defaults.model) || null;
}

async function applyRuntimeDefaults(pi, ctx, defaults) {
  const result = { modelApplied: false, thinkingApplied: false, modelMissing: false };
  const model = findTrueDefaultModel(ctx, defaults);
  if (model && typeof pi.setModel === "function") {
    result.modelApplied = Boolean(await pi.setModel(model));
  } else if (defaults.provider && defaults.model) {
    result.modelMissing = true;
  }
  if (defaults.thinkingLevel && typeof pi.setThinkingLevel === "function") {
    pi.setThinkingLevel(defaults.thinkingLevel);
    result.thinkingApplied = true;
  }
  return result;
}

function formatDefaults(defaults) {
  const parts = [];
  if (defaults.provider) parts.push(`provider=${defaults.provider}`);
  if (defaults.model) parts.push(`model=${defaults.model}`);
  if (defaults.thinkingLevel) parts.push(`thinking=${defaults.thinkingLevel}`);
  return parts.join(" ") || "none configured";
}

function notify(ctx, message, level = "info") {
  ctx?.ui?.notify?.(message, level);
}

export default function trueDefaultsExtension(pi) {
  let lastRestore = restoreTrueDefaultSettings();

  pi.on?.("session_start", async (_event, ctx) => {
    lastRestore = restoreTrueDefaultSettings();
    if (!lastRestore.defaults || !hasTrueDefaults(readSettingsFile(lastRestore.path) || {})) return;
    await applyRuntimeDefaults(pi, ctx, lastRestore.defaults);
  });

  pi.on?.("session_shutdown", async (event) => {
    if (event?.reason === "reload" || event?.reason === "quit" || event?.reason === "new" || event?.reason === "resume" || event?.reason === "fork") {
      lastRestore = restoreTrueDefaultSettings();
    }
  });

  pi.registerCommand?.("true-defaults", {
    description: "Show or reapply immutable-by-convention true defaults for provider/model/thinking settings.",
    handler: async (args, ctx) => {
      const token = String(args || "").trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase() || "status";
      if (token === "help" || token === "--help") {
        notify(ctx, "Usage: /true-defaults [status|apply] — true defaults are edited directly in settings.json under agentUtils.trueDefaults or trueDefault* keys.", "info");
        return;
      }
      if (token !== "status" && token !== "apply") {
        notify(ctx, "Usage: /true-defaults [status|apply]", "warning");
        return;
      }
      if (token === "apply") lastRestore = restoreTrueDefaultSettings();
      notify(ctx, [
        `true-defaults ${token}: ${lastRestore.changed ? "restored persisted defaults" : lastRestore.reason || "already restored"}`,
        `source: ${lastRestore.scope || "unknown"} ${lastRestore.path || ""}`.trim(),
        `configured: ${formatDefaults(lastRestore.defaults || {})}`,
      ].join("\n"), lastRestore.ok ? "info" : "error");
    },
  });
}
