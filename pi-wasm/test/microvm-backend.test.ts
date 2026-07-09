import { describe, it, expect, vi } from "vitest";
import {
  MicrovmExecBackend,
  createMicrovmExecBackend,
  frameCommand,
  parseSerialResult,
  BEGIN_RE,
  END_RE,
  type MicrovmMachine,
} from "../src/exec/microvm-backend";
import type { ExecBackendOptions } from "../src/exec/exec-backend";

const opts = (over: Partial<ExecBackendOptions> = {}): ExecBackendOptions => ({ cwd: "/work", ...over });

type Responder = (
  frame: string,
) => { stdout: string; exitCode: number; echo?: boolean } | null;

/**
 * A fake guest: on each serial write it extracts the run token from the framed
 * command, then asynchronously emits console echo (optional) + the BEGIN marker
 * + canned stdout + the END marker, mimicking a real serial console. A responder
 * returning `null` never completes (for abort/timeout tests).
 */
class MockMachine implements MicrovmMachine {
  readonly kind = "mock";
  available = true;
  bootCount = 0;
  disposed = false;
  interrupts = 0;
  bootImpl: () => Promise<void> = async () => {};
  private listeners = new Set<(chunk: string) => void>();

  constructor(private readonly responder: Responder) {}

  async boot(): Promise<void> {
    this.bootCount += 1;
    await this.bootImpl();
  }

  writeSerial(data: string): void {
    if (data === "\x03") {
      this.interrupts += 1;
      return;
    }
    const m = /PIWASM_BEGIN_%s\\n' '([^']+)'/.exec(data);
    if (!m) return;
    const token = m[1];
    const res = this.responder(data);
    if (!res) return; // never completes
    queueMicrotask(() => {
      if (res.echo) this.emit(data);
      this.emit(`PIWASM_BEGIN_${token}\n`);
      if (res.stdout) this.emit(res.stdout);
      this.emit(`PIWASM_END_${token}:${res.exitCode}\n`);
    });
  }

  onSerialData(listener: (chunk: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  private emit(chunk: string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
}

describe("frameCommand / parseSerialResult (pure)", () => {
  it("frames cd + env exports + begin/end markers with the token as a printf arg", () => {
    const frame = frameCommand("echo hi", "tok123", opts({ cwd: "/work/app", env: { FOO: "bar" } }));
    expect(frame).toContain("printf 'PIWASM_BEGIN_%s\\n' 'tok123'");
    expect(frame).toContain("export FOO='bar'");
    expect(frame).toContain("cd '/work/app'");
    expect(frame).toContain("echo hi");
    expect(frame).toContain("printf 'PIWASM_END_%s:%d\\n' 'tok123'");
    // The concatenated marker string must NOT appear in the framed source, so a
    // console echo of the frame can never be mistaken for real output.
    expect(frame).not.toContain("PIWASM_BEGIN_tok123");
  });

  it("single-quote-escapes cwd/env values", () => {
    const frame = frameCommand("true", "t", opts({ cwd: "/w/it's", env: { X: "a'b" } }));
    expect(frame).toContain(`cd '/w/it'\\''s'`);
    expect(frame).toContain(`export X='a'\\''b'`);
  });

  it("returns undefined until END arrives, then extracts stdout + exit code", () => {
    const token = "abc";
    expect(parseSerialResult("partial output no end", token)).toBeUndefined();
    const buf = `PIWASM_BEGIN_${token}\nhello world\nPIWASM_END_${token}:0\n`;
    const r = parseSerialResult(buf, token)!;
    expect(r.stdout).toBe("hello world");
    expect(r.exitCode).toBe(0);
  });

  it("strips console echo before the BEGIN marker and parses non-zero codes", () => {
    const token = "z9";
    const buf =
      `printf 'PIWASM_BEGIN_%s\\n' 'z9'\nfalse\n` + // echoed source (contains marker only split)
      `PIWASM_BEGIN_${token}\n` +
      `PIWASM_END_${token}:1\n`;
    const r = parseSerialResult(buf, token)!;
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  it("BEGIN_RE/END_RE tolerate CRLF", () => {
    const token = "cr";
    const buf = `PIWASM_BEGIN_${token}\r\nout\r\nPIWASM_END_${token}:7\r\n`;
    expect(BEGIN_RE(token).test(buf)).toBe(true);
    expect(END_RE(token).test(buf)).toBe(true);
    const r = parseSerialResult(buf, token)!;
    expect(r.stdout).toBe("out");
    expect(r.exitCode).toBe(7);
  });
});

describe("MicrovmExecBackend", () => {
  it("has id 'microvm' and is available when the machine is loadable", () => {
    const m = new MockMachine(() => ({ stdout: "", exitCode: 0 }));
    const backend = createMicrovmExecBackend({ machine: m });
    expect(backend.id).toBe("microvm");
    expect(backend.available).toBe(true);
    m.available = false;
    expect(backend.available).toBe(false);
  });

  it("boots lazily once and returns stdout + exit code (echo-robust)", async () => {
    const m = new MockMachine((frame) =>
      frame.includes("echo hi") ? { stdout: "hi\n", exitCode: 0, echo: true } : { stdout: "", exitCode: 0 },
    );
    const backend = new MicrovmExecBackend({ machine: m });
    const r = await backend.exec("echo hi", opts());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.stdout).toBe("hi");
      expect(r.value.exitCode).toBe(0);
      expect(r.value.stderr).toBe("");
    }
    expect(m.bootCount).toBe(1);
    // Second exec reuses the boot.
    await backend.exec("echo hi", opts());
    expect(m.bootCount).toBe(1);
  });

  it("propagates a non-zero exit code", async () => {
    const m = new MockMachine(() => ({ stdout: "", exitCode: 3 }));
    const backend = new MicrovmExecBackend({ machine: m });
    const r = await backend.exec("false", opts());
    expect(r.ok && r.value.exitCode).toBe(3);
  });

  it("streams stdout via onStdout", async () => {
    const m = new MockMachine(() => ({ stdout: "streamed-out\n", exitCode: 0 }));
    const backend = new MicrovmExecBackend({ machine: m });
    const chunks: string[] = [];
    const r = await backend.exec("cat", opts({ onStdout: (c) => chunks.push(c) }));
    expect(r.ok).toBe(true);
    expect(chunks.join("")).toContain("streamed-out");
  });

  it("reports shell_unavailable when the machine is not available", async () => {
    const m = new MockMachine(() => ({ stdout: "", exitCode: 0 }));
    m.available = false;
    const backend = new MicrovmExecBackend({ machine: m });
    const r = await backend.exec("echo hi", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("shell_unavailable");
  });

  it("returns aborted when the signal is already aborted", async () => {
    const m = new MockMachine(() => ({ stdout: "", exitCode: 0 }));
    const backend = new MicrovmExecBackend({ machine: m });
    const r = await backend.exec("echo hi", opts({ abortSignal: AbortSignal.abort() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("aborted");
  });

  it("interrupts the guest (Ctrl-C) and reports aborted on mid-run abort", async () => {
    const m = new MockMachine(() => null); // never completes
    const backend = new MicrovmExecBackend({ machine: m });
    const controller = new AbortController();
    const p = backend.exec("sleep 999", opts({ abortSignal: controller.signal }));
    await Promise.resolve();
    controller.abort();
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("aborted");
    expect(m.interrupts).toBe(1);
  });

  it("times out and interrupts the guest", async () => {
    vi.useFakeTimers();
    try {
      const m = new MockMachine(() => null); // never completes
      const backend = new MicrovmExecBackend({ machine: m });
      const p = backend.exec("sleep 999", opts({ timeout: 2 }));
      await vi.advanceTimersByTimeAsync(2000);
      const r = await p;
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("timeout");
      expect(m.interrupts).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes concurrent exec() calls so output cannot interleave", async () => {
    const seen: string[] = [];
    const m = new MockMachine((frame) => {
      const cmd = frame.includes("cmdA") ? "A" : "B";
      seen.push(cmd);
      return { stdout: `${cmd}-out\n`, exitCode: 0 };
    });
    const backend = new MicrovmExecBackend({ machine: m });
    const [a, b] = await Promise.all([backend.exec("cmdA", opts()), backend.exec("cmdB", opts())]);
    expect(a.ok && a.value.stdout).toBe("A-out");
    expect(b.ok && b.value.stdout).toBe("B-out");
    // Second command only started after the first completed (queued).
    expect(seen).toEqual(["A", "B"]);
  });

  it("maps a boot failure to spawn_error and can retry", async () => {
    const m = new MockMachine(() => ({ stdout: "ok\n", exitCode: 0 }));
    m.bootImpl = vi.fn().mockRejectedValueOnce(new Error("no kvm")).mockResolvedValue(undefined);
    const backend = new MicrovmExecBackend({ machine: m });
    const first = await backend.exec("echo hi", opts());
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.code).toBe("spawn_error");
    const second = await backend.exec("echo hi", opts());
    expect(second.ok).toBe(true);
    expect(m.bootCount).toBe(2);
  });

  it("dispose() tears down the machine and blocks further exec", async () => {
    const m = new MockMachine(() => ({ stdout: "", exitCode: 0 }));
    const backend = new MicrovmExecBackend({ machine: m });
    await backend.dispose();
    expect(m.disposed).toBe(true);
    const r = await backend.exec("echo hi", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("shell_unavailable");
  });

  it("never throws — failures are encoded in the Result", async () => {
    const m = new MockMachine(() => ({ stdout: "", exitCode: 0 }));
    m.writeSerial = () => {
      throw new Error("serial dead");
    };
    const backend = new MicrovmExecBackend({ machine: m });
    const r = await backend.exec("echo hi", opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("spawn_error");
  });
});
