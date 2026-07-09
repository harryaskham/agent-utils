import { describe, expect, it } from "vitest";
import {
  EXEC_BACKEND_IDS,
  createExecBackend,
  isExecBackendId,
  type ExecBackendId,
} from "../src/exec/registry";
import { createBrowserExecutionEnv, type BrowserExecutionEnv } from "../src/vfs/browser-execution-env";
import { InMemoryVfs } from "./in-memory-vfs";
import type { MicrovmMachine } from "../src/exec/microvm-backend";

async function makeEnv(): Promise<BrowserExecutionEnv> {
  return createBrowserExecutionEnv({ vfs: new InMemoryVfs(), cwd: "/work" });
}

const fakeMachine: MicrovmMachine = {
  kind: "fake",
  available: true,
  async boot() {},
  writeSerial() {},
  onSerialData() {
    return () => {};
  },
};

describe("exec-backend registry (S13, bd-6ebbf6)", () => {
  it("exposes the four known ids and validates them", () => {
    expect([...EXEC_BACKEND_IDS]).toEqual(["none", "js-shell", "remote", "microvm"]);
    expect(isExecBackendId("js-shell")).toBe(true);
    expect(isExecBackendId("remote")).toBe(true);
    expect(isExecBackendId("bogus")).toBe(false);
  });

  it('builds "none" → NullExecBackend (unavailable default)', async () => {
    const env = await makeEnv();
    const r = createExecBackend("none", { env });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("none");
      expect(r.value.available).toBe(false);
    }
  });

  it('builds "js-shell" → JsShellBackend (available) from the env', async () => {
    const env = await makeEnv();
    const r = createExecBackend("js-shell", { env });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe("js-shell");
      expect(r.value.available).toBe(true);
    }
  });

  it('builds "remote" with relay settings; errors without an endpoint', async () => {
    const env = await makeEnv();
    const okRes = createExecBackend("remote", { env, relay: { endpoint: "http://localhost:8730/exec" } });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) expect(okRes.value.id).toBe("remote");

    expect(createExecBackend("remote", { env }).ok).toBe(false);
    expect(createExecBackend("remote", { env, relay: { endpoint: "" } }).ok).toBe(false);
  });

  it('builds "microvm" with a machine; errors without one', async () => {
    const env = await makeEnv();
    const okRes = createExecBackend("microvm", { env, microvm: { machine: fakeMachine } });
    expect(okRes.ok).toBe(true);
    if (okRes.ok) expect(okRes.value.id).toBe("microvm");

    expect(createExecBackend("microvm", { env }).ok).toBe(false);
  });

  it("errors on an unknown (stale/cast) id rather than throwing", async () => {
    const env = await makeEnv();
    const r = createExecBackend("bogus" as ExecBackendId, { env });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown exec backend id");
  });
});
