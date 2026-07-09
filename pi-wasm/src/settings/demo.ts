// pi-wasm S6 (bd-4c572a): standalone settings-screen demo. Proves the acceptance
// end-to-end in a browser: enter a key + endpoint + model, Save, RELOAD, and the
// values persist and are picked up as a runtime config a new session would use.
// Exposes window.__PI_WASM_SETTINGS__ for the S8 Playwright harness to assert on.

import { SettingsStore, toRuntimeConfig, isRuntimeConfigReady, mountSettingsPanel } from "./index";

const store = new SettingsStore();
const app = document.getElementById("app") as HTMLElement;
const summary = document.getElementById("summary") as HTMLElement;

async function renderSummary(): Promise<void> {
  const persisted = await store.load();
  const cfg = toRuntimeConfig(persisted);
  summary.textContent = JSON.stringify(
    {
      baseUrl: cfg.baseUrl,
      selectedModel: cfg.model?.id ?? null,
      provider: cfg.model?.provider ?? null,
      hasApiKeyForSelected: Boolean(cfg.apiKey),
      providers: Object.keys(persisted.providerKeys),
      runtimeReady: isRuntimeConfigReady(persisted),
    },
    null,
    2,
  );
}

mountSettingsPanel(app, store, { onSaved: () => void renderSummary() });
void renderSummary();

// Test hook for the S8 Playwright harness (no secrets exposed beyond the user's
// own browser state, which is the whole point of this screen).
(globalThis as Record<string, unknown>).__PI_WASM_SETTINGS__ = {
  store,
  reload: renderSummary,
  toRuntimeConfig: () => store.load().then(toRuntimeConfig),
};
