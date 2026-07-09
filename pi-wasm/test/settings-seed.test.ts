import { describe, it, expect } from "vitest";
import { createBrowserExecutionEnv } from "../src/vfs";
import { seedAgentConfig } from "../src/settings/seed-vfs";
import type { PiWasmSettings } from "../src/settings/types";

const settings: PiWasmSettings = {
  providerKeys: { openai: "sk-o", litellm: "sk-l" },
  baseUrl: "http://proxy:4000",
  models: [{ id: "gpt-5.5", provider: "litellm" }],
  selectedModelId: "gpt-5.5",
  settings: { theme: "dark" },
};

describe("seedAgentConfig (S6 settings -> S2 VFS seam)", () => {
  it("writes auth/models/settings json into the VFS, readable back via the env", async () => {
    const env = await createBrowserExecutionEnv({ fsName: `s6-seed-${Date.now()}`, wipe: true });
    const written = await seedAgentConfig(env, settings);
    expect(written).toEqual([
      "/home/.pi/agent/auth.json",
      "/home/.pi/agent/models.json",
      "/home/.pi/agent/settings.json",
    ]);

    const read = async (p: string) => {
      const r = await env.readTextFile(p);
      if (!r.ok) throw r.error;
      return JSON.parse(r.value);
    };
    expect((await read("/home/.pi/agent/auth.json")).providers.openai.apiKey).toBe("sk-o");
    expect((await read("/home/.pi/agent/models.json")).selected).toBe("gpt-5.5");
    expect((await read("/home/.pi/agent/models.json")).baseUrl).toBe("http://proxy:4000");
    expect((await read("/home/.pi/agent/settings.json")).theme).toBe("dark");
  });

  it("respects a custom agentDir", async () => {
    const env = await createBrowserExecutionEnv({ fsName: `s6-seed2-${Date.now()}`, wipe: true });
    const written = await seedAgentConfig(env, settings, { agentDir: "/work/.pi/agent" });
    expect(written[0]).toBe("/work/.pi/agent/auth.json");
    const r = await env.readTextFile("/work/.pi/agent/auth.json");
    expect(r.ok).toBe(true);
  });
});
