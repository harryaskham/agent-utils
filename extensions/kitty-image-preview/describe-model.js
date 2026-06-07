// Vision/describe model resolution for the kitty image preview (bd-02c6ff).
//
// Mirrors tendril-share's describe-model precedence so the kitty_image_preview_*
// describe path is configurable via settings.json and defaults to a
// github-copilot model. Auth is unchanged: callers feed the resolved model to
// ctx.modelRegistry.getApiKeyAndHeaders, so github-copilot models reuse pi's
// baked Copilot token/headers — no separate JWT/auth.json hook is needed.
//
// Pure over (ctx, { params, env, settings }). settings.json is read from disk
// only when an explicit `settings` object is not supplied, so unit tests stay
// hermetic by passing settings directly.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_DESCRIBE_MODEL, FALLBACK_DESCRIBE_MODELS } from "./constants.js";
import { parseModelSpec } from "./parse.js";

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

// settings.json keys honoured for the kitty image preview describe model. Kept
// kitty-specific (does not read tendril.* keys) so operators can pin the two
// describe paths independently.
export function configuredDescribeModelFromSettings(settings = {}) {
  const candidates = [
    settings?.kittyImagePreview?.describeModel,
    settings?.agentUtils?.kittyImagePreview?.describeModel,
  ];
  return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
}

export function modelSupportsImage(model) {
  return !Array.isArray(model?.input) || model.input.includes("image");
}

// Resolve the configured describe-model spec + its source, NOT counting the
// per-call param (handled separately so a param can win even over env/settings).
export function describeModelConfig({ env = process.env, settings } = {}) {
  const envValue = String(env.KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL || "").trim();
  if (envValue) return { spec: envValue, source: "KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL" };
  const resolvedSettings = settings ?? readAgentSettings(env);
  const settingsValue = configuredDescribeModelFromSettings(resolvedSettings);
  if (settingsValue) return { spec: settingsValue, source: "settings.json" };
  return { spec: DEFAULT_DESCRIBE_MODEL, source: "default" };
}

function findRegisteredModel(ctx, spec) {
  const parsed = parseModelSpec(spec);
  return parsed ? ctx?.modelRegistry?.find?.(parsed.provider, parsed.modelId) : ctx?.model;
}

// Full resolution: per-call describeModel param -> KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL
// -> settings.json (kittyImagePreview.describeModel) -> default github-copilot
// model with a fallback chain. Returns { model, spec, source }. Throws a clear
// error when an explicitly configured model is missing or text-only, and when no
// default fallback is registered.
export function resolveDescribeModel(ctx, { params = {}, env = process.env, settings } = {}) {
  const paramSpec = String(params.describeModel || "").trim();
  if (paramSpec) {
    const model = findRegisteredModel(ctx, paramSpec);
    if (!model) throw new Error(`Vision model ${paramSpec} is not registered. Pass describeModel as provider/model.`);
    if (!modelSupportsImage(model)) {
      throw new Error(`Model ${model.provider}/${model.id} does not advertise image input support. Pass describeModel with an image-capable model.`);
    }
    return { model, spec: paramSpec, source: "param" };
  }

  const config = describeModelConfig({ env, settings });
  const configured = config.source !== "default" ? config.spec : "";
  const specs = configured ? [config.spec] : [...FALLBACK_DESCRIBE_MODELS];
  const missing = [];
  const textOnly = [];
  for (const spec of specs) {
    const model = findRegisteredModel(ctx, spec);
    if (!model) { missing.push(spec); continue; }
    if (!modelSupportsImage(model)) { textOnly.push(`${model.provider}/${model.id}`); continue; }
    return { model, spec, source: config.source };
  }

  if (configured) {
    throw new Error(`Vision model ${configured} from ${config.source} is not registered or does not advertise image input support. Set KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL=provider/model or kittyImagePreview.describeModel in settings.json.`);
  }
  throw new Error(`No default kitty image preview vision model is registered. Tried: ${specs.join(", ")}.${textOnly.length ? ` Text-only matches: ${textOnly.join(", ")}.` : ""}${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}`);
}
