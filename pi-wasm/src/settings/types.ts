// pi-wasm S6 (bd-4c572a): settings/keys data model.
//
// A user configures the in-browser agent BEFORE it runs real work: their own
// API keys (per provider), a base URL / proxy endpoint, a lightweight models
// list, the selected model, and freeform settings.json overrides. Everything is
// stored ONLY in the user's browser (see SettingsStore).

/** A lightweight model entry (a browser-side models.json row). */
export interface ModelSpec {
  /** Model id as the provider/models.json knows it, e.g. "gpt-5.5" or "claude-opus-4.8". */
  id: string;
  /** Provider key used to resolve the API key + provider wiring, e.g. "openai", "anthropic", "litellm". */
  provider: string;
  /** Optional human label for the picker. */
  label?: string;
  /** Optional per-model base URL override (else the global baseUrl). */
  baseUrl?: string;
}

/** Remote exec relay (S15) config for the "remote" backend. */
export interface RelayConfig {
  /** Relay endpoint URL, e.g. http://localhost:8730/exec. */
  endpoint: string;
  /** Bearer token presented to the relay (secret; the relay's own auth, never a model key). */
  token?: string;
}

/** The full persisted settings blob. */
export interface PiWasmSettings {
  /** Per-provider API keys. The user's own keys, stored only in their browser. */
  providerKeys: Record<string, string>;
  /** Default provider / proxy base URL (e.g. the LiteLLM proxy). Consumed by the S3 streamFn. */
  baseUrl: string;
  /** Available models (a browser-side models.json). */
  models: ModelSpec[];
  /** Currently selected model id (should match a models[].id), or null. */
  selectedModelId: string | null;
  /** Freeform settings.json overrides loaded into the session. */
  settings: Record<string, unknown>;
  /**
   * Remote exec relay (S15) config for the "remote" ExecBackend. Kept TOP-LEVEL
   * (a secret; not materialized into the VFS settings.json by seedAgentConfig).
   * The S13 registry / S11 SessionManager read settings.relay to build the
   * "remote" backend. Absent when no relay is configured.
   */
  relay?: RelayConfig;
}

export const DEFAULT_SETTINGS: PiWasmSettings = {
  providerKeys: {},
  baseUrl: "",
  models: [],
  selectedModelId: null,
  settings: {},
};
