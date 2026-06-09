// Shared describe/vision-model resolver (bd-f20ebd).
//
// Dedups the param -> env var -> settings.json -> default+fallback precedence,
// settings.json reading, provider/model parsing, and image-support checks that
// were independently duplicated in extensions/tendril-share.js and
// extensions/kitty-image-preview/describe-model.js. Each caller binds its own
// env var, settings.json key namespace, default model, fallback chain, and
// operator-facing error hints, so the two describe paths stay independently
// configurable while the resolution logic lives in one place.
//
// Pure over (ctx, options). settings.json is read from disk only when an
// explicit `settings` object is not supplied, so unit tests stay hermetic by
// passing settings directly. Callers feed the resolved model to
// ctx.modelRegistry.getApiKeyAndHeaders, so github-copilot models reuse pi's
// baked Copilot token/headers — no separate JWT/auth.json hook is needed.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function parseModelSpec(spec) {
  if (!spec) return undefined;
  const slash = String(spec).indexOf("/");
  if (slash <= 0 || slash === String(spec).length - 1) throw new Error(`Vision model must be provider/model, got: ${spec}`);
  return { provider: String(spec).slice(0, slash), modelId: String(spec).slice(slash + 1) };
}

export function modelSupportsImage(model) {
  return !Array.isArray(model?.input) || model.input.includes("image");
}

export function agentSettingsPath(env = process.env) {
  return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "settings.json");
}

export function readAgentSettings(env = process.env) {
  const settingsPath = agentSettingsPath(env);
  try {
    if (!existsSync(settingsPath)) return {};
    return JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return {};
  }
}

function readByPath(obj, dottedPath) {
  return String(dottedPath)
    .split(".")
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

// First non-empty configured model string among the given dotted settings.json
// key paths (e.g. "tendril.describeModel"). Empty string when none configured.
export function pickConfiguredModel(settings = {}, settingsKeys = []) {
  return (
    settingsKeys
      .map((keyPath) => readByPath(settings, keyPath))
      .map((value) => String(value || "").trim())
      .find(Boolean) || ""
  );
}

// Resolve the configured describe-model spec + its source, NOT counting any
// per-call param. The env var wins over settings.json, which wins over the
// default. Reads settings.json from disk only when `settings` is omitted.
export function computeDescribeModelConfig({ env = process.env, settings, envVar, settingsKeys = [], defaultModel } = {}) {
  const envValue = String(env[envVar] || "").trim();
  if (envValue) return { spec: envValue, source: envVar };
  const resolvedSettings = settings ?? readAgentSettings(env);
  const settingsValue = pickConfiguredModel(resolvedSettings, settingsKeys);
  if (settingsValue) return { spec: settingsValue, source: "settings.json" };
  return { spec: defaultModel, source: "default" };
}

function findRegisteredModel(ctx, spec) {
  const parsed = parseModelSpec(spec);
  return parsed ? ctx?.modelRegistry?.find?.(parsed.provider, parsed.modelId) : ctx?.model;
}

// Full resolution: per-call describeModel param -> env var -> settings.json ->
// default model with a fallback chain. Returns { model, spec, source }. Throws a
// clear error when an explicitly configured model is missing or text-only, and
// when no default fallback is registered. `configHint` is appended to the
// configured-but-unusable error; `subject` names the path in the no-default
// error (e.g. "Tendril" / "kitty image preview").
export function resolveDescribeModel(ctx, {
  params = {},
  env = process.env,
  settings,
  envVar,
  settingsKeys = [],
  defaultModel,
  fallbacks = [],
  configHint = "",
  subject = "vision",
} = {}) {
  const paramSpec = String(params.describeModel || "").trim();
  if (paramSpec) {
    const model = findRegisteredModel(ctx, paramSpec);
    if (!model) throw new Error(`Vision model ${paramSpec} is not registered. Pass describeModel as provider/model.`);
    if (!modelSupportsImage(model)) {
      throw new Error(`Model ${model.provider}/${model.id} does not advertise image input support. Pass describeModel with an image-capable model.`);
    }
    return { model, spec: paramSpec, source: "param" };
  }

  const config = computeDescribeModelConfig({ env, settings, envVar, settingsKeys, defaultModel });
  const configured = config.source !== "default" ? config.spec : "";
  const specs = configured ? [config.spec] : [...fallbacks];
  const missing = [];
  const textOnly = [];
  for (const spec of specs) {
    const model = findRegisteredModel(ctx, spec);
    if (!model) { missing.push(spec); continue; }
    if (!modelSupportsImage(model)) { textOnly.push(`${model.provider}/${model.id}`); continue; }
    return { model, spec, source: config.source };
  }

  if (configured) {
    throw new Error(`Vision model ${configured} from ${config.source} is not registered or does not advertise image input support. ${configHint}`);
  }
  throw new Error(`No default ${subject} vision model is registered. Tried: ${specs.join(", ")}.${textOnly.length ? ` Text-only matches: ${textOnly.join(", ")}.` : ""}${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`);
}
