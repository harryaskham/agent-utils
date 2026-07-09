import { describe, it, expect, vi } from "vitest";
import { createBrowserExecutionEnv } from "../src/vfs";
import { createBrowserFileTools } from "../src/tools";
import {
  SettingsStore,
  toRuntimeConfig,
  isRuntimeConfigReady,
  seedAgentConfig,
  DEFAULT_SETTINGS,
  type PiWasmSettings,
} from "../src/settings";
import { createHttpRelayExecBackend } from "../src/exec";
import { createBrowserAgent } from "../src/provider";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// Epic-level integration smoke (S16, pi-wasm epic bd-f76cee): prove the landed
// module surfaces (S2 VFS, S4 tools, S6 settings, S13a/S15 exec, S3 provider)
// compose into one coherent graph, independent of the S7 UI. Each slice tests
// itself; this asserts they interoperate, catching cross-module drift.

let envSeq = 0;
const freshEnv = () =>
  createBrowserExecutionEnv({ cwd: "/work", fsName: `it-compose-${Date.now()}-${envSeq++}`, wipe: true });

const toolMap = (env: Awaited<ReturnType<typeof createBrowserExecutionEnv>>) =>
  new Map(createBrowserFileTools(env).map((t) => [t.name, t] as const));

const readText = (result: Awaited<ReturnType<AgentTool["execute"]>>) =>
  result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

const settingsWithKey = (): PiWasmSettings => ({
  ...DEFAULT_SETTINGS,
  providerKeys: { openai: "sk-live" },
  baseUrl: "http://relay.example/v1",
  selectedModelId: "m1",
  models: [{ id: "m1", provider: "openai" }],
});

describe("pi-wasm epic modules compose (S1–S6 + S13a/S15)", () => {
  it("S2 VFS + S4 tools: write→read round-trip through the real AgentTools", async () => {
    const env = await freshEnv();
    try {
      const tools = toolMap(env);
      await tools.get("write")!.execute("w", { path: "/work/hi.txt", content: "composed\n" });
      const read = await tools.get("read")!.execute("r", { path: "/work/hi.txt" });
      expect(readText(read)).toContain("composed");
    } finally {
      await env.cleanup();
    }
  });

  it("S6 settings seeds config into the SAME VFS; the S4 read tool reads it back", async () => {
    const env = await freshEnv();
    try {
      const written = await seedAgentConfig(env, settingsWithKey());
      expect(written).toContain("/home/.pi/agent/models.json");
      expect(written).toContain("/home/.pi/agent/auth.json");
      const tools = toolMap(env);
      const models = readText(await tools.get("read")!.execute("r", { path: "/home/.pi/agent/models.json" }));
      expect(models).toContain("m1");
      const auth = readText(await tools.get("read")!.execute("r", { path: "/home/.pi/agent/auth.json" }));
      expect(auth).toContain("openai");
    } finally {
      await env.cleanup();
    }
  });

  it("S6 runtime: toRuntimeConfig wires getApiKey + isRuntimeConfigReady gating", async () => {
    const cfg = toRuntimeConfig(settingsWithKey());
    expect(await cfg.getApiKey("openai")).toBe("sk-live");
    expect(isRuntimeConfigReady(settingsWithKey())).toBe(true);
    expect(isRuntimeConfigReady(DEFAULT_SETTINGS)).toBe(false);
  });

  it("S13a exec seam default is no-bash; the S15 remote tier plugs in over a relay", async () => {
    const env = await freshEnv();
    try {
      const nullExec = await env.exec("echo hi");
      expect(nullExec.ok).toBe(false);
      if (!nullExec.ok) expect(nullExec.error.code).toBe("shell_unavailable");

      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ stdout: "remote-ok\n", stderr: "", exitCode: 0 }), { status: 200 }),
      ) as unknown as typeof fetch;
      const remote = createHttpRelayExecBackend({ endpoint: "http://relay/exec", token: "t", fetchImpl });
      expect(remote.available).toBe(true);
      const res = await remote.exec("uname -a", { cwd: "/work" });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.stdout).toContain("remote-ok");
    } finally {
      await env.cleanup();
    }
  });

  it("S3 provider + Path-A Agent: createBrowserAgent constructs and accepts the S4 tools", async () => {
    const env = await freshEnv();
    try {
      const cfg = toRuntimeConfig(settingsWithKey());
      const agent = createBrowserAgent({
        modelId: cfg.model?.id ?? "m1",
        baseUrl: cfg.baseUrl,
        getApiKey: cfg.getApiKey,
      });
      expect(typeof agent.subscribe).toBe("function");

      const tools = createBrowserFileTools(env);
      expect(tools.length).toBeGreaterThan(0);
      // Path A: assigning state.tools copies the array — the full loop assembles.
      agent.state.tools = tools;
      expect(agent.state.tools.length).toBe(tools.length);
      // bash is excluded from the file tools (no-bash MVP surface).
      expect(agent.state.tools.some((t) => t.name === "bash")).toBe(false);
    } finally {
      await env.cleanup();
    }
  });
});
