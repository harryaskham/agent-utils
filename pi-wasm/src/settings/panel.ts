// pi-wasm S6 (bd-4c572a): the settings/keys screen (framework-light DOM). The S7
// app shell can embed this panel; a standalone demo page (settings-demo.html)
// makes it reload-testable on its own. All persistence goes through SettingsStore
// (the user's own browser); this file is thin glue over the pure form helpers.

import { SettingsStore } from "./store";
import { settingsToForm, formToSettings, type SettingsFormValues } from "./form";
import type { PiWasmSettings } from "./types";

export interface SettingsPanelHandle {
  /** Reload values from the store into the form. */
  refresh(): Promise<void>;
  /** Remove listeners + clear the container. */
  destroy(): void;
}

export interface MountSettingsPanelOptions {
  /** Called after a successful save with the persisted settings. */
  onSaved?(settings: PiWasmSettings): void;
}

const NOTICE =
  "Your API keys are stored ONLY in this browser (IndexedDB) and are never sent " +
  "anywhere except directly to the model endpoint you configure. Use \"Clear all\" to wipe them.";

const FIELD_NAMES = ["baseUrl", "providerKeysJson", "modelsJson", "selectedModelId", "settingsJson"] as const;

export function mountSettingsPanel(
  container: HTMLElement,
  store: SettingsStore,
  options: MountSettingsPanelOptions = {},
): SettingsPanelHandle {
  container.textContent = "";
  const form = document.createElement("form");
  form.className = "pi-wasm-settings";
  form.innerHTML = `
    <p class="notice"></p>
    <label>Base URL (provider / LiteLLM proxy)
      <input name="baseUrl" type="text" placeholder="http://100.83.90.42:4000" autocomplete="off" /></label>
    <label>Provider API keys — JSON, e.g. { "openai": "sk-..." }
      <textarea name="providerKeysJson" rows="4" spellcheck="false"></textarea></label>
    <label>Models — JSON array of { "id", "provider", "baseUrl"? }
      <textarea name="modelsJson" rows="6" spellcheck="false"></textarea></label>
    <label>Selected model id
      <input name="selectedModelId" type="text" list="pi-wasm-model-ids" autocomplete="off" />
      <datalist id="pi-wasm-model-ids"></datalist></label>
    <label>settings.json overrides — JSON object
      <textarea name="settingsJson" rows="4" spellcheck="false"></textarea></label>
    <div class="errors" role="alert"></div>
    <div class="actions">
      <button type="submit" data-act="save">Save</button>
      <button type="button" data-act="reset">Reset</button>
      <button type="button" data-act="clear">Clear all</button>
      <span class="status" aria-live="polite"></span>
    </div>`;
  (form.querySelector(".notice") as HTMLElement).textContent = NOTICE;
  container.appendChild(form);

  const fieldEl = (name: (typeof FIELD_NAMES)[number]) =>
    form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLTextAreaElement;
  const errorsEl = form.querySelector(".errors") as HTMLElement;
  const statusEl = form.querySelector(".status") as HTMLElement;
  const datalistEl = form.querySelector("#pi-wasm-model-ids") as HTMLDataListElement;

  function fill(values: SettingsFormValues): void {
    for (const name of FIELD_NAMES) fieldEl(name).value = values[name];
    refreshModelDatalist(values.modelsJson);
  }

  function read(): SettingsFormValues {
    return {
      baseUrl: fieldEl("baseUrl").value,
      providerKeysJson: fieldEl("providerKeysJson").value,
      modelsJson: fieldEl("modelsJson").value,
      selectedModelId: fieldEl("selectedModelId").value,
      settingsJson: fieldEl("settingsJson").value,
    };
  }

  function refreshModelDatalist(modelsJson: string): void {
    datalistEl.textContent = "";
    try {
      const models = JSON.parse(modelsJson || "[]");
      if (Array.isArray(models)) {
        for (const m of models) {
          if (m && typeof m.id === "string") {
            const opt = document.createElement("option");
            opt.value = m.id;
            datalistEl.appendChild(opt);
          }
        }
      }
    } catch {
      /* invalid JSON while typing — ignore for the datalist */
    }
  }

  async function refresh(): Promise<void> {
    fill(settingsToForm(await store.load()));
    errorsEl.textContent = "";
    statusEl.textContent = "";
  }

  const onSubmit = async (e: Event): Promise<void> => {
    e.preventDefault();
    const { settings, errors } = formToSettings(read());
    if (!settings) {
      errorsEl.textContent = errors.join("; ");
      statusEl.textContent = "";
      return;
    }
    errorsEl.textContent = "";
    await store.save(settings);
    statusEl.textContent = "Saved \u2713";
    options.onSaved?.(settings);
  };

  const onClick = async (e: Event): Promise<void> => {
    const target = e.target as HTMLElement;
    const act = target.dataset.act;
    if (act === "reset") {
      await refresh();
      statusEl.textContent = "Reset";
    } else if (act === "clear") {
      await store.clear();
      await refresh();
      statusEl.textContent = "Cleared";
    }
  };

  const onInput = (e: Event): void => {
    if ((e.target as HTMLElement).getAttribute("name") === "modelsJson") {
      refreshModelDatalist((e.target as HTMLTextAreaElement).value);
    }
  };

  form.addEventListener("submit", onSubmit);
  form.addEventListener("click", onClick);
  form.addEventListener("input", onInput);
  void refresh();

  return {
    refresh,
    destroy() {
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("click", onClick);
      form.removeEventListener("input", onInput);
      container.textContent = "";
    },
  };
}
