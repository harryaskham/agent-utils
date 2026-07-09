import { describe, it, expect } from "vitest";
import { SettingsStore } from "../src/settings/store";
import { DEFAULT_SETTINGS } from "../src/settings/types";

let counter = 0;
const freshStore = () => new SettingsStore({ dbName: `s6-store-${Date.now()}-${counter++}` });

describe("SettingsStore (IndexedDB, browser-local)", () => {
  it("returns defaults when empty", async () => {
    expect(await freshStore().load()).toEqual(DEFAULT_SETTINGS);
  });

  it("round-trips save -> load", async () => {
    const store = freshStore();
    await store.save({
      providerKeys: { openai: "sk-x" },
      baseUrl: "http://p:4000",
      models: [{ id: "gpt-5.5", provider: "openai" }],
      selectedModelId: "gpt-5.5",
      settings: { theme: "dark" },
    });
    const s = await store.load();
    expect(s.providerKeys.openai).toBe("sk-x");
    expect(s.baseUrl).toBe("http://p:4000");
    expect(s.models).toHaveLength(1);
    expect(s.selectedModelId).toBe("gpt-5.5");
    expect(s.settings.theme).toBe("dark");
  });

  it("persists across a new store instance with the same dbName (survives reload)", async () => {
    const dbName = `s6-persist-${Date.now()}`;
    await new SettingsStore({ dbName }).save({ ...DEFAULT_SETTINGS, baseUrl: "http://persist" });
    const reopened = await new SettingsStore({ dbName }).load();
    expect(reopened.baseUrl).toBe("http://persist");
  });

  it("setProviderKey adds and (with empty key) removes", async () => {
    const store = freshStore();
    await store.setProviderKey("openai", "sk-1");
    expect((await store.load()).providerKeys.openai).toBe("sk-1");
    await store.setProviderKey("openai", "");
    expect((await store.load()).providerKeys.openai).toBeUndefined();
  });

  it("clear wipes settings back to defaults", async () => {
    const store = freshStore();
    await store.save({ ...DEFAULT_SETTINGS, baseUrl: "http://x" });
    await store.clear();
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
  });

  it("drops malformed model rows on normalize", async () => {
    const store = freshStore();
    await store.save({
      providerKeys: { a: "1" },
      baseUrl: "b",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      models: [{ id: "m", provider: "p" }, { id: 5 } as any],
      selectedModelId: "m",
      settings: {},
    });
    expect((await store.load()).models).toHaveLength(1);
  });
});
