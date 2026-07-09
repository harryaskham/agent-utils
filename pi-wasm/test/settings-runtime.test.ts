import { describe, it, expect } from "vitest";
import {
  createGetApiKey,
  resolveModelConfig,
  toRuntimeConfig,
  isRuntimeConfigReady,
} from "../src/settings/runtime";
import type { PiWasmSettings } from "../src/settings/types";

const base: PiWasmSettings = {
  providerKeys: { openai: "sk-o", anthropic: "sk-a" },
  baseUrl: "http://proxy:4000",
  models: [
    { id: "gpt-5.5", provider: "openai" },
    { id: "claude-opus-4.8", provider: "anthropic", baseUrl: "http://anthropic" },
  ],
  selectedModelId: "claude-opus-4.8",
  settings: { x: 1 },
};

describe("runtime config (settings -> Agent construction shape)", () => {
  it("createGetApiKey resolves per provider", () => {
    const g = createGetApiKey(base);
    expect(g("openai")).toBe("sk-o");
    expect(g("anthropic")).toBe("sk-a");
    expect(g("google")).toBeUndefined();
  });

  it("resolveModelConfig uses the selected model, its baseUrl override, and key", () => {
    const r = resolveModelConfig(base);
    expect(r.model?.id).toBe("claude-opus-4.8");
    expect(r.baseUrl).toBe("http://anthropic");
    expect(r.apiKey).toBe("sk-a");
  });

  it("falls back to the global baseUrl + first model when none selected", () => {
    const r = resolveModelConfig({ ...base, selectedModelId: null });
    expect(r.model?.id).toBe("gpt-5.5");
    expect(r.baseUrl).toBe("http://proxy:4000");
    expect(r.apiKey).toBe("sk-o");
  });

  it("toRuntimeConfig bundles getApiKey + model + settings", () => {
    const cfg = toRuntimeConfig(base);
    expect(cfg.getApiKey("openai")).toBe("sk-o");
    expect(cfg.model?.id).toBe("claude-opus-4.8");
    expect(cfg.settings).toEqual({ x: 1 });
  });

  it("isRuntimeConfigReady requires a model + its key + a baseUrl", () => {
    expect(isRuntimeConfigReady(base)).toBe(true);
    expect(isRuntimeConfigReady({ ...base, providerKeys: {} })).toBe(false);
    expect(isRuntimeConfigReady({ ...base, models: [], selectedModelId: null })).toBe(false);
  });
});
