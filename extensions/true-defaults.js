// Pi extension: preserve operator-owned true defaults for model/provider/thinking.
//
// Pi's built-in runtime controls may update defaultProvider/defaultModel and
// defaultThinkingLevel in settings.json. This extension treats a namespaced set
// of true-default settings as immutable-by-convention and copies them back onto
// Pi's built-in default keys during extension load, FRESH session start
// (startup/new), and clean shutdown (quit/new). Explicit process-level runtime
// choices take precedence: Pi's --model/--thinking flags and the managed-launcher
// PI_MODEL/PI_PROVIDER/PI_REASONING_EFFORT environment variables win over true
// defaults. Continuing sessions (reload/resume/fork) also preserve runtime/temp
// model/effort changes instead of re-asserting the default. Thinking values,
// including adaptive, are delegated to Pi core unchanged.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "adaptive"]);

function normalizeString(value) {
  const text = String(value ?? "").trim();
  return text ? text : undefined;
}

function normalizeThinkingLevel(value) {
  const level = normalizeString(value)?.toLowerCase();
  return level && THINKING_LEVELS.has(level) ? level : undefined;
}

function cliArgumentValue(argv, name) {
  let value;
  for (let index = 0; index < argv.length - 1; index++) {
    if (argv[index] === name) value = normalizeString(argv[index + 1]);
  }
  return value;
}

function splitThinkingSuffix(modelSpec) {
  const spec = normalizeString(modelSpec);
  if (!spec) return { model: undefined, thinkingLevel: undefined };
  const colon = spec.lastIndexOf(":");
  if (colon <= 0) return { model: spec, thinkingLevel: undefined };
  const thinkingLevel = normalizeThinkingLevel(spec.slice(colon + 1));
  return thinkingLevel
    ? { model: normalizeString(spec.slice(0, colon)), thinkingLevel }
    : { model: spec, thinkingLevel: undefined };
}

// Pi itself owns CLI parsing. This small read-only mirror exists only so the
// extension does not overwrite an explicit startup selection in session_start.
// PI_* model variables are the managed-launcher convention used by Cacophony;
// true-defaults also applies them directly so they remain useful when a launcher
// does not translate them to Pi's native --model/--thinking flags.
export function runtimeOverrides({ argv = process.argv.slice(2), env = process.env } = {}) {
  const cliModelRaw = cliArgumentValue(argv, "--model");
  const cliProvider = cliArgumentValue(argv, "--provider");
  const cliThinkingRaw = cliArgumentValue(argv, "--thinking");
  const envModelRaw = normalizeString(env.PI_MODEL);
  const envProvider = normalizeString(env.PI_PROVIDER);
  const envThinkingRaw = normalizeString(env.PI_REASONING_EFFORT);

  const modelSource = cliModelRaw ? "cli" : envModelRaw ? "env" : undefined;
  const selectedModel = splitThinkingSuffix(cliModelRaw || envModelRaw);
  const cliThinkingLevel = normalizeThinkingLevel(cliThinkingRaw);
  const envThinkingLevel = normalizeThinkingLevel(envThinkingRaw);
  const thinkingLevel = cliThinkingLevel || selectedModel.thinkingLevel || envThinkingLevel;
  const thinkingSource = cliThinkingLevel
    ? "cli"
    : selectedModel.thinkingLevel
      ? modelSource
      : envThinkingLevel
        ? "env"
        : undefined;

  return {
    model: selectedModel.model,
    provider: modelSource === "cli" ? cliProvider : envProvider,
    thinkingLevel,
    modelSource,
    thinkingSource,
  };
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

function findOverrideModel(ctx, overrides) {
  if (!overrides.model) return null;
  const models = ctx?.modelRegistry?.getAll?.() || [];
  const modelSpec = overrides.model.toLowerCase();
  const providerHint = overrides.provider?.toLowerCase();

  if (providerHint) {
    const prefix = `${providerHint}/`;
    const modelId = modelSpec.startsWith(prefix) ? overrides.model.slice(prefix.length) : overrides.model;
    return models.find((model) =>
      model.provider.toLowerCase() === providerHint && model.id.toLowerCase() === modelId.toLowerCase()
    ) || ctx?.modelRegistry?.find?.(overrides.provider, modelId) || null;
  }

  const fullMatch = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === modelSpec);
  if (fullMatch) return fullMatch;

  const idMatches = models.filter((model) => model.id.toLowerCase() === modelSpec);
  if (idMatches.length === 1) return idMatches[0];
  if (ctx?.model && idMatches.some((model) => model.provider === ctx.model.provider && model.id === ctx.model.id)) {
    return ctx.model;
  }
  return null;
}

async function applyRuntimeDefaults(pi, ctx, defaults, overrides = {}) {
  const result = {
    modelApplied: false,
    thinkingApplied: false,
    modelMissing: false,
    modelSource: overrides.modelSource || "true-defaults",
    thinkingSource: overrides.thinkingSource || "true-defaults",
  };

  // Pi has already applied a native CLI model before session_start, so merely
  // avoid replacing it. PI_MODEL is not a native Pi environment variable; when
  // present without --model, resolve and apply it here.
  if (overrides.modelSource !== "cli") {
    const model = overrides.modelSource === "env"
      ? findOverrideModel(ctx, overrides)
      : findTrueDefaultModel(ctx, defaults);
    const alreadyActive = overrides.modelSource === "env" && ctx?.model && model &&
      ctx.model.provider === model.provider && ctx.model.id === model.id;
    if (alreadyActive) {
      result.modelApplied = true;
    } else if (model && typeof pi.setModel === "function") {
      result.modelApplied = Boolean(await pi.setModel(model));
    } else if (overrides.modelSource === "env" || (defaults.provider && defaults.model)) {
      result.modelMissing = true;
    }
  }

  // As with model selection, Pi has already applied --thinking (including a
  // valid :<thinking> suffix on --model). Managed PI_REASONING_EFFORT is applied
  // here; otherwise the immutable true default remains the fallback.
  if (overrides.thinkingSource !== "cli") {
    const thinkingLevel = overrides.thinkingSource === "env"
      ? overrides.thinkingLevel
      : defaults.thinkingLevel;
    const alreadyActive = overrides.thinkingSource === "env" &&
      typeof pi.getThinkingLevel === "function" && pi.getThinkingLevel() === thinkingLevel;
    if (alreadyActive) {
      result.thinkingApplied = true;
    } else if (thinkingLevel && typeof pi.setThinkingLevel === "function") {
      pi.setThinkingLevel(thinkingLevel);
      result.thinkingApplied = true;
    }
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

export default function trueDefaultsExtension(pi, options = {}) {
  let lastRestore = restoreTrueDefaultSettings(options);
  const startupOverrides = runtimeOverrides(options);

  // Reasons that *continue* an operator's working session rather than starting a
  // fresh one. On these, true-defaults must NOT re-assert the persisted default
  // model/effort, so a runtime/temp change (e.g. an operator `/model` switch)
  // survives the reload/resume/fork instead of being yanked back to the default.
  const CONTINUING_REASONS = new Set(["reload", "resume", "fork"]);

  pi.on?.("session_start", async (event, ctx) => {
    if (CONTINUING_REASONS.has(event?.reason)) return;
    lastRestore = restoreTrueDefaultSettings(options);
    if (!lastRestore.defaults || !hasTrueDefaults(readSettingsFile(lastRestore.path) || {})) return;
    await applyRuntimeDefaults(pi, ctx, lastRestore.defaults, startupOverrides);

    // pi.setModel()/setThinkingLevel() intentionally persist ordinary runtime
    // switches. Environment overrides are process-scoped, so immediately repair
    // the settings file after applying them while leaving the active runtime
    // model/thinking untouched.
    if (startupOverrides.modelSource === "env" || startupOverrides.thinkingSource === "env") {
      lastRestore = restoreTrueDefaultSettings(options);
    }
  });

  pi.on?.("session_shutdown", async (event) => {
    // Only re-persist true defaults when the operator's working session truly
    // ends (quit) or a brand-new one begins (new). reload/resume/fork continue
    // the session and must preserve runtime/temp changes.
    if (event?.reason === "quit" || event?.reason === "new") {
      lastRestore = restoreTrueDefaultSettings(options);
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
      if (token === "apply") lastRestore = restoreTrueDefaultSettings(options);
      notify(ctx, [
        `true-defaults ${token}: ${lastRestore.changed ? "restored persisted defaults" : lastRestore.reason || "already restored"}`,
        `source: ${lastRestore.scope || "unknown"} ${lastRestore.path || ""}`.trim(),
        `configured: ${formatDefaults(lastRestore.defaults || {})}`,
        `runtime override: ${formatDefaults({
          provider: startupOverrides.provider,
          model: startupOverrides.modelSource ? startupOverrides.model : undefined,
          thinkingLevel: startupOverrides.thinkingSource ? startupOverrides.thinkingLevel : undefined,
        })}`,
      ].join("\n"), lastRestore.ok ? "info" : "error");
    },
  });
}
