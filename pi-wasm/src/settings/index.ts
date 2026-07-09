// pi-wasm S6 (bd-4c572a): public surface of the settings/keys layer.
export { DEFAULT_SETTINGS } from "./types";
export type { ModelSpec, PiWasmSettings } from "./types";

export { SettingsStore, normalizeSettings } from "./store";
export type { SettingsStoreOptions } from "./store";

export {
  createGetApiKey,
  resolveModelConfig,
  toRuntimeConfig,
  isRuntimeConfigReady,
} from "./runtime";
export type { GetApiKey, ResolvedModelConfig, RuntimeConfig } from "./runtime";

export { seedAgentConfig } from "./seed-vfs";
export type { SeedEnv, SeedResult, SeedOptions } from "./seed-vfs";

export { settingsToForm, formToSettings } from "./form";
export type { SettingsFormValues, FormParseResult } from "./form";

export { mountSettingsPanel } from "./panel";
export type { SettingsPanelHandle, MountSettingsPanelOptions } from "./panel";
