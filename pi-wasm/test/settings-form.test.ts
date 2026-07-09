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
    });
    expect(parsed.settings).toBeUndefined();
    expect(parsed.errors).toHaveLength(2);
  });
});
