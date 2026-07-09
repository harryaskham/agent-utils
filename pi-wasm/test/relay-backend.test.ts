import { describe, it, expect, vi } from "vitest";
import {
  RelayExecBackend,
  HttpRelayTransport,
  createHttpRelayExecBackend,
  type RelayTransport,
  type RelayRunRequest,
  type RelayRunHooks,
  type RelayExecResponse,
} from "../src/exec/relay-backend";
import type { ExecBackendOptions } from "../src/exec/exec-backend";

const opts = (over: Partial<ExecBackendOptions> = {}): ExecBackendOptions => ({ cwd: "/work", ...over });

class MockTransport implements RelayTransport {
  readonly kind = "mock";
  available = true;
  constructor(
    private readonly handler: (req: RelayRunRequest, hooks: RelayRunHooks) => Promise<RelayExecResponse>,
  ) {}
  run(req: RelayRunRequest, hooks: RelayRunHooks): Promise<RelayExecResponse> {
    return this.handler(req, hooks);
  }
}

describe("RelayExecBackend (remote exec tier)", () => {
  it("returns ok with stdout/stderr/exitCode and forwards cwd/env + stream hooks", async () => {
    let seen: RelayRunRequest | undefined;
    const transport = new MockTransport(async (req, hooks) => {
      seen = req;
      hooks.onStdout?.("hello\n");
      return { stdout: "hello\n", stderr: "warn\n", exitCode: 0 };
    });
    const backend = new RelayExecBackend({ transport });
    const onStdout = vi.fn();

    const res = await backend.exec("echo hello", opts({ env: { A: "1" }, onStdout }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ stdout: "hello\n", stderr: "warn\n", exitCode: 0 });
    }
    expect(seen).toEqual({ command: "echo hello", cwd: "/work", env: { A: "1" }, timeoutSeconds: undefined });
    expect(onStdout).toHaveBeenCalledWith("hello\n");
    expect(backend.id).toBe("remote");
  });

  it("returns shell_unavailable when the transport is not available", async () => {
    const transport = new MockTransport(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    transport.available = false;
    const backend = new RelayExecBackend({ transport });
    const res = await backend.exec("ls", opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("shell_unavailable");
  });

  it("returns aborted when the abort signal is already aborted (never calls transport)", async () => {
    const run = vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    const backend = new RelayExecBackend({ transport: new MockTransport(run) });
    const res = await backend.exec("sleep 1", opts({ abortSignal: AbortSignal.abort() }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("aborted");
    expect(run).not.toHaveBeenCalled();
  });

  it("maps a transport rejection to spawn_error (never throws)", async () => {
    const backend = new RelayExecBackend({
      transport: new MockTransport(async () => {
        throw new Error("connection refused");
      }),
    });
    const res = await backend.exec("ls", opts());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("spawn_error");
      expect(res.error.message).toContain("connection refused");
    }
  });

  it("maps a timeout to the timeout error code", async () => {
    // Transport rejects when the combined (timeout) signal fires.
    const backend = new RelayExecBackend({
      transport: new MockTransport(
        (_req, hooks) =>
          new Promise((_resolve, reject) => {
            hooks.abortSignal?.addEventListener("abort", () => reject(new Error("aborted by signal")));
          }),
      ),
    });
    const res = await backend.exec("sleep 5", opts({ timeout: 0.02 }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("timeout");
  });

  it("dispose delegates to the transport", async () => {
    const dispose = vi.fn(async () => {});
    const transport: RelayTransport = {
      kind: "mock",
      available: true,
      run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      dispose,
    };
    await new RelayExecBackend({ transport }).dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });
});

describe("HttpRelayTransport", () => {
  const makeFetch = (impl: (url: string, init: RequestInit) => Response) =>
    vi.fn(async (url: unknown, init?: unknown) => impl(String(url), (init ?? {}) as RequestInit)) as unknown as typeof fetch;

  it("POSTs command JSON with a Bearer token and parses the response", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit = {};
    const fetchImpl = makeFetch((url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ stdout: "out", stderr: "err", exitCode: 2 }), { status: 200 });
    });
    const backend = createHttpRelayExecBackend({
      endpoint: "http://localhost:8730/exec",
      token: "tok",
      fetchImpl,
    });
    const onStderr = vi.fn();
    const res = await backend.exec("whoami", opts({ onStderr }));

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ stdout: "out", stderr: "err", exitCode: 2 });
    expect(capturedUrl).toBe("http://localhost:8730/exec");
    expect(capturedInit.method).toBe("POST");
    const headers = capturedInit.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer tok");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(capturedInit.body))).toEqual({ command: "whoami", cwd: "/work" });
    expect(onStderr).toHaveBeenCalledWith("err");
  });

  it("is unavailable with an empty endpoint (⇒ shell_unavailable)", async () => {
    const backend = createHttpRelayExecBackend({ endpoint: "", fetchImpl: makeFetch(() => new Response("")) });
    expect(backend.available).toBe(false);
    const res = await backend.exec("ls", opts());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("shell_unavailable");
  });

  it("maps a non-2xx relay response to spawn_error", async () => {
    const fetchImpl = makeFetch(() => new Response("boom", { status: 503, statusText: "Service Unavailable" }));
    const backend = createHttpRelayExecBackend({ endpoint: "http://localhost:8730/exec", fetchImpl });
    const res = await backend.exec("ls", opts());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("spawn_error");
      expect(res.error.message).toContain("503");
    }
  });

  it("does not send an Authorization header when no token is configured", async () => {
    let headers: Record<string, string> = {};
    const fetchImpl = makeFetch((_url, init) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ stdout: "", stderr: "", exitCode: 0 }), { status: 200 });
    });
    const transport = new HttpRelayTransport({ endpoint: "http://localhost:8730/exec", fetchImpl });
    await transport.run({ command: "ls", cwd: "/work" }, {});
    expect(headers["authorization"]).toBeUndefined();
  });
});
