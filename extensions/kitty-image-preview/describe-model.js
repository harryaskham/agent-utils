// Vision/describe model resolution for the kitty image preview (bd-02c6ff).
//
// Mirrors tendril-share's describe-model precedence so the kitty_image_preview_*
// describe path is configurable via settings.json and defaults to a
// github-copilot model. The param -> env -> settings -> default+fallback logic,
// settings.json reading, provider/model parsing, and image-support checks live
// in the shared resolver at extensions/lib/describe-model.js (bd-f20ebd); this
// module only binds the kitty-specific env var, settings.json key namespace,
// default model, fallback chain, and operator-facing error hints. Auth is
// unchanged: callers feed the resolved model to
// ctx.modelRegistry.getApiKeyAndHeaders, so github-copilot models reuse pi's
// baked Copilot token/headers — no separate JWT/auth.json hook is needed.
//
// Pure over (ctx, { params, env, settings }). settings.json is read from disk
// only when an explicit `settings` object is not supplied, so unit tests stay
// hermetic by passing settings directly.

import {
  agentSettingsPath,
  computeDescribeModelConfig,
  modelSupportsImage,
  pickConfiguredModel,
  readAgentSettings,
  resolveDescribeModel as resolveDescribeModelCore,
} from "../lib/describe-model.js";
import { DEFAULT_DESCRIBE_MODEL, FALLBACK_DESCRIBE_MODELS } from "./constants.js";

export { agentSettingsPath, modelSupportsImage, readAgentSettings };

const ENV_VAR = "KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL";
// settings.json keys honoured for the kitty image preview describe model. Kept
// kitty-specific (does not read tendril.* keys) so operators can pin the two
// describe paths independently.
const SETTINGS_KEYS = Object.freeze([
  "kittyImagePreview.describeModel",
  "agentUtils.kittyImagePreview.describeModel",
]);
const CONFIG_HINT = `Set ${ENV_VAR}=provider/model or kittyImagePreview.describeModel in settings.json.`;
const SUBJECT = "kitty image preview";

export function configuredDescribeModelFromSettings(settings = {}) {
  return pickConfiguredModel(settings, SETTINGS_KEYS);
}

// Resolve the configured describe-model spec + its source, NOT counting the
// per-call param (handled separately so a param can win even over env/settings).
export function describeModelConfig({ env = process.env, settings } = {}) {
  return computeDescribeModelConfig({
    env,
    settings,
    envVar: ENV_VAR,
    settingsKeys: SETTINGS_KEYS,
    defaultModel: DEFAULT_DESCRIBE_MODEL,
  });
}

// Full resolution: per-call describeModel param -> KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL
// -> settings.json (kittyImagePreview.describeModel) -> default github-copilot
// model with a fallback chain. Returns { model, spec, source }. Throws a clear
// error when an explicitly configured model is missing or text-only, and when no
// default fallback is registered.
export function resolveDescribeModel(ctx, { params = {}, env = process.env, settings } = {}) {
  return resolveDescribeModelCore(ctx, {
    params,
    env,
    settings,
    envVar: ENV_VAR,
    settingsKeys: SETTINGS_KEYS,
    defaultModel: DEFAULT_DESCRIBE_MODEL,
    fallbacks: FALLBACK_DESCRIBE_MODELS,
    configHint: CONFIG_HINT,
    subject: SUBJECT,
  });
}
