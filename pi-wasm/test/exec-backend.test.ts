import { describe, expect, it } from "vitest";
import type { ExecutionError, Result } from "@earendil-works/pi-agent-core";
import {
  NullExecBackend,
  type ExecBackend,
  type ExecBackendOptions,
  type ExecResult,
} from "../src/exec/exec-backend";
import { createBrowserExecutionEnv, type BrowserExecutionEnv } from "../src/vfs/browser-execution-env";
import { InMemoryVfs } from "./in-memory-vfs";
import { createBrowserFileTools } from "../src/tools/browser-tools";
import { createBrowserAgentTools, createBrowserBashTool } from "../src/tools/bash-tool";

// A trivial backend that echoes the command + resolved cwd, to prove delegation.
class EchoExecBackend implements ExecBackend {
  readonly id = "echo";
  available = true;
  lastCwd?: string;
  async exec(command: string, options: ExecBackendOptions): Promise<Result<ExecResult, ExecutionError>> {
    this.lastCwd = options.cwd;
    return { ok: true, value: { stdout: `ran: ${command} @ ${options.cwd}`, stderr: "", exitCode: 0 } };
  }
}

async function makeEnv(backend?: ExecBackend): Promise<BrowserExecutionEnv> {
  return createBrowserExecutionEnv({ vfs: new InMemoryVfs(), cwd: "/work", execBackend: backend });
}

describe("pluggable exec-backend seam (S13a)", () => {
  it("NullExecBackend is unavailable and reports shell_unavailable", async () => {
    const backend = new NullExecBackend();
    expect(backend.available).toBe(false);
    const r = await backend.exec("echo hi", { cwd: "/work" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("shell_unavailable");
  });

  it("default env (no backend) keeps shell_unavailable — S2/S4 behavior unchanged", async () => {
    const env = await makeEnv();
    const r = await env.exec("echo hi");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("shell_unavailable");
  });

  it("delegates to a configured backend (via ctor) with cwd resolved against env.cwd", async () => {
    const backend = new EchoExecBackend();
    const env = await makeEnv(backend);
    const r = await env.exec("ls", { cwd: "sub" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stdout).toBe("ran: ls @ /work/sub");
    expect(backend.lastCwd).toBe("/work/sub");
  });

  it("setExecBackend switches at runtime and clearing reverts to shell_unavailable", async () => {
    const env = await makeEnv();
    env.setExecBackend(new EchoExecBackend());
    expect((await env.exec("pwd")).ok).toBe(true);
    env.setExecBackend(undefined);
    const r = await env.exec("pwd");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("shell_unavailable");
  });

  it("an unavailable backend falls through to shell_unavailable", async () => {
    const backend = new EchoExecBackend();
    backend.available = false;
    const env = await makeEnv(backend);
    const r = await env.exec("echo");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("shell_unavailable");
  });

  it("bash tool throws without a backend and returns stdout/exit with one", async () => {
    const env = await makeEnv();
    const bash = createBrowserBashTool(env);
    await expect(bash.execute("1", { command: "echo hi" })).rejects.toThrow(/unavailable/i);
    env.setExecBackend(new EchoExecBackend());
    const res = await bash.execute("2", { command: "echo hi" });
    const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("ran: echo hi");
    expect(text).toContain("[exit code: 0]");
  });

  it("createBrowserFileTools excludes bash; createBrowserAgentTools opts it in", async () => {
    const env = await makeEnv();
    expect(createBrowserFileTools(env).map((t) => t.name)).not.toContain("bash");
    expect(createBrowserAgentTools(env).map((t) => t.name)).not.toContain("bash");
    expect(createBrowserAgentTools(env, { bash: true }).map((t) => t.name)).toContain("bash");
  });
});
