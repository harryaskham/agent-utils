import { describe, it, expect } from "vitest";
import { settingsToForm, formToSettings } from "../src/settings/form";
import type { PiWasmSettings } from "../src/settings/types";

const settings: PiWasmSettings = {
  providerKeys: { openai: "sk-o" },
  baseUrl: "http://p",
  models: [{ id: "gpt-5.5", provider: "openai" }],
  selectedModelId: "gpt-5.5",
  settings: { theme: "dark" },
};

describe("settings form (pure serialization)", () => {
  it("round-trips settings -> form -> settings", () => {
    const parsed = formToSettings(settingsToForm(settings));
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings).toEqual(settings);
  });

  it("treats empty JSON fields as empty containers", () => {
    const parsed = formToSettings({
      baseUrl: "",
      providerKeysJson: "",
      modelsJson: "",
      selectedModelId: "",
      settingsJson: "",
      relayEndpoint: "",
      relayToken: "",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings?.providerKeys).toEqual({});
    expect(parsed.settings?.models).toEqual([]);
    expect(parsed.settings?.selectedModelId).toBeNull();
  });

  it("reports invalid JSON with a helpful label", () => {
    const parsed = formToSettings({
      baseUrl: "",
      providerKeysJson: "{bad",
      modelsJson: "[]",
      selectedModelId: "",
      settingsJson: "{}",
      relayEndpoint: "",
      relayToken: "",
    });
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors.join(" ")).toMatch(/Provider keys/);
  });

  it("rejects wrong JSON shapes (object vs array)", () => {
    const parsed = formToSettings({
      baseUrl: "",
      providerKeysJson: "[]",
      modelsJson: "{}",
      selectedModelId: "",
      settingsJson: "{}",
      relayEndpoint: "",
      relayToken: "",
    });
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors).toHaveLength(2);
  });
});

describe("settings form — remote exec relay (S15) fields", () => {
  const base = {
    baseUrl: "",
    providerKeysJson: "",
    modelsJson: "",
    selectedModelId: "",
    settingsJson: "",
    relayEndpoint: "",
    relayToken: "",
  };

  it("surfaces top-level settings.relay as dedicated form fields", () => {
    const withRelay: PiWasmSettings = {
      ...settings,
      relay: { endpoint: "https://r/exec", token: "t0" },
    };
    const form = settingsToForm(withRelay);
    expect(form.relayEndpoint).toBe("https://r/exec");
    expect(form.relayToken).toBe("t0");
    // relay is a top-level secret, not part of the settings.json blob
    expect(JSON.parse(form.settingsJson)).toEqual({ theme: "dark" });
  });

  it("writes the dedicated fields to top-level settings.relay where the registry reads them", () => {
    const parsed = formToSettings({
      ...base,
      relayEndpoint: "https://r/exec",
      relayToken: "t0",
    });
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings?.relay).toEqual({ endpoint: "https://r/exec", token: "t0" });
  });

  it("keeps an endpoint-only relay (token optional)", () => {
    const parsed = formToSettings({ ...base, relayEndpoint: "http://localhost:8730/exec" });
    expect(parsed.settings?.relay).toEqual({ endpoint: "http://localhost:8730/exec" });
  });

  it("omits relay when the endpoint is empty (even if a token was typed)", () => {
    const parsed = formToSettings({ ...base, relayEndpoint: "", relayToken: "orphan" });
    expect(parsed.errors).toEqual([]);
    expect(parsed.settings?.relay).toBeUndefined();
  });

  it("round-trips settings incl. relay -> form -> settings", () => {
    const withRelay: PiWasmSettings = {
      ...settings,
      relay: { endpoint: "https://r/exec", token: "t0" },
    };
    expect(formToSettings(settingsToForm(withRelay)).settings).toEqual(withRelay);
  });
});
