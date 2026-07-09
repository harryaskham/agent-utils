// pi-wasm S6 (bd-4c572a): load persisted settings into the runtime shape the
// Path-A loop needs. The S7 app shell (aurora) constructs the agent as:
//
//   const cfg = toRuntimeConfig(await store.load());
//   new Agent({ getApiKey: cfg.getApiKey, streamFn /* S3, uses cfg.baseUrl */,
//               initialState: { tools: createBrowserFileTools(env), model: cfg.model?.id, systemPrompt } });
//
// so this module is the bridge between the settings screen and `new Agent(...)`.

import { normalizeSettings } from "./store";
import type { ModelSpec, PiWasmSettings } from "./types";

/** Signature of the `getApiKey` callback passed to `new Agent({ getApiKey })`. */
export type GetApiKey = (provider: string) => string | undefined;

/** Build the provider→key resolver for the Agent constructor. */
export function createGetApiKey(settings: PiWasmSettings): GetApiKey {
  const keys = normalizeSettings(settings).providerKeys;
  return (provider) => keys[provider] || undefined;
}

export interface ResolvedModelConfig {
  /** The selected model (or the first available, or null if none configured). */
  model: ModelSpec | null;
  /** Effective base URL: the model's own baseUrl, else the global baseUrl. */
  baseUrl: string;
  /** API key for the selected model's provider, if present. */
  apiKey: string | undefined;
}

/** Resolve the selected model + its base URL + api key (for the S3 streamFn). */
export function resolveModelConfig(settings: PiWasmSettings): ResolvedModelConfig {
  const s = normalizeSettings(settings);
  const model = s.models.find((m) => m.id === s.selectedModelId) ?? s.models[0] ?? null;
  const baseUrl = (model?.baseUrl && model.baseUrl.trim()) || s.baseUrl;
  const apiKey = model ? s.providerKeys[model.provider] || undefined : undefined;
  return { model, baseUrl, apiKey };
}

export interface RuntimeConfig extends ResolvedModelConfig {
  /** Provider→key resolver for `new Agent({ getApiKey })`. */
  getApiKey: GetApiKey;
  /** settings.json overrides to apply to the session. */
  settings: Record<string, unknown>;
}

/** One-call loader the S7 shell uses to configure a session before start. */
export function toRuntimeConfig(settings: PiWasmSettings): RuntimeConfig {
  const s = normalizeSettings(settings);
  return { ...resolveModelConfig(s), getApiKey: createGetApiKey(s), settings: s.settings };
}

/** True when there is enough config (a model + its key + a base URL) to start a real session. */
export function isRuntimeConfigReady(settings: PiWasmSettings): boolean {
  const { model, apiKey, baseUrl } = resolveModelConfig(settings);
  return Boolean(model && apiKey && baseUrl);
}
