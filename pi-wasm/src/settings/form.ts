// pi-wasm S6 (bd-4c572a): pure (DOM-free) form <-> settings serialization, so the
// settings screen's parse/validate logic is unit-testable headlessly under vitest.

import { normalizeSettings } from "./store";
import type { PiWasmSettings, MicrovmConfig } from "./types";

/** Raw string values as they appear in the settings form. */
export interface SettingsFormValues {
  baseUrl: string;
  providerKeysJson: string;
  modelsJson: string;
  selectedModelId: string;
  settingsJson: string;
  /** Remote exec relay (S15) endpoint — persisted under settings.relay.endpoint. */
  relayEndpoint: string;
  /** Remote exec relay (S15) token (secret) — persisted under settings.relay.token. */
  relayToken: string;
  /** microVM (S14) tuning as a JSON object — persisted under settings.microvm. */
  microvmJson: string;
}

/** Render persisted settings into editable form strings. */
export function settingsToForm(settings: PiWasmSettings): SettingsFormValues {
  const s = normalizeSettings(settings);
  return {
    baseUrl: s.baseUrl,
    providerKeysJson: JSON.stringify(s.providerKeys, null, 2),
    modelsJson: JSON.stringify(s.models, null, 2),
    selectedModelId: s.selectedModelId ?? "",
    settingsJson: JSON.stringify(s.settings, null, 2),
    relayEndpoint: s.relay?.endpoint ?? "",
    relayToken: s.relay?.token ?? "",
    microvmJson: s.microvm ? JSON.stringify(s.microvm, null, 2) : "",
  };
}

export interface FormParseResult {
  /** Present only when there are no errors. */
  settings?: PiWasmSettings;
  errors: string[];
}

/** Parse + validate form strings into settings, collecting human-readable errors. */
export function formToSettings(values: SettingsFormValues): FormParseResult {
  const errors: string[] = [];
  const providerKeys = parseJsonObject(values.providerKeysJson, "Provider keys", errors);
  const models = parseJsonArray(values.modelsJson, "Models", errors);
  const settings = parseJsonObject(values.settingsJson, "settings.json", errors);
  // microVM tuning (S14) — a JSON object under settings.microvm. Empty ({} or
  // blank) coerces to "no overrides" (the backend then uses vendored-asset
  // defaults); invalid JSON is a form error.
  const microvmRaw = parseJsonObject(values.microvmJson, "microVM config", errors);
  if (errors.length > 0) return { errors };

  const selectedModelId = values.selectedModelId.trim() || null;
  // The remote-exec relay (S15) is a TOP-LEVEL secret field the S13 registry /
  // S11 SessionManager read as settings.relay. The dedicated fields are
  // authoritative; an empty endpoint means no relay is configured.
  const relayEndpoint = values.relayEndpoint.trim();
  const relayToken = values.relayToken.trim();
  const relay = relayEndpoint
    ? relayToken
      ? { endpoint: relayEndpoint, token: relayToken }
      : { endpoint: relayEndpoint }
    : undefined;
  return {
    settings: normalizeSettings({
      baseUrl: values.baseUrl.trim(),
      providerKeys: providerKeys as Record<string, string>,
      models: models as PiWasmSettings["models"],
      selectedModelId,
      settings: settings as Record<string, unknown>,
      relay,
      microvm: microvmRaw as unknown as MicrovmConfig | undefined,
    }),
    errors: [],
  };
}

function parseJsonObject(text: string, label: string, errors: string[]): Record<string, unknown> | undefined {
  const t = text.trim();
  if (!t) return {};
  try {
    const value = JSON.parse(t);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${label} must be a JSON object`);
      return undefined;
    }
    return value as Record<string, unknown>;
  } catch (e) {
    errors.push(`${label}: invalid JSON (${(e as Error).message})`);
    return undefined;
  }
}

function parseJsonArray(text: string, label: string, errors: string[]): unknown[] | undefined {
  const t = text.trim();
  if (!t) return [];
  try {
    const value = JSON.parse(t);
    if (!Array.isArray(value)) {
      errors.push(`${label} must be a JSON array`);
      return undefined;
    }
    return value;
  } catch (e) {
    errors.push(`${label}: invalid JSON (${(e as Error).message})`);
    return undefined;
  }
}
