// pi-wasm S14 (bd-c6ffc3): the microVM tier of the pluggable exec-backend seam.
//
// A miniscule Linux microVM (recommended: v86 — see ../../MICROVM-FEASIBILITY.md)
// gives the in-browser agent real bash/coreutils client-side. Unlike the remote
// tier (S15), the guest runs *in the tab*; unlike a per-call process, a microVM
// is a persistent boot — so exec() must inject each command into the running
// guest over its serial console and parse stdout + the exit code back out.
//
// This module is v86-agnostic: it talks to a `MicrovmMachine` seam (boot +
// serial duplex), exactly like RelayExecBackend talks to a `RelayTransport`. The
// real v86 adapter (boot a vendored Buildroot image, bridge /work to the S2
// LightningFsVfs via a 9p handler) is a separate increment and plugs in behind
// this same seam. `MicrovmExecBackend` implements the landed `ExecBackend`
// interface (S13a bd-4d085a), registers as id="microvm" through ms2-0's
// id→backend factory (S13 bd-6ebbf6), and is selected per session by S11.
//
// exec() contract (same as the SDK Shell): never throw — encode failures in the
// Result; honor `abortSignal` + `timeout`. Because a serial console is a single
// shared line, concurrent exec() calls are SERIALIZED (queued) so their output
// cannot interleave.

import { ok, err, ExecutionError } from "@earendil-works/pi-agent-core";
import type { Result } from "@earendil-works/pi-agent-core";
import type { ExecBackend, ExecBackendOptions, ExecResult } from "./exec-backend";

/**
 * The microVM machine seam: a booted guest exposing a serial console duplex.
 * Implemented for real by a v86 adapter (next increment) and by a mock guest in
 * tests. `writeSerial` types bytes at the guest console; `onSerialData` streams
 * console output back. `boot()` MUST be idempotent and resolve once a shell is
 * ready to accept commands on the serial line.
 */
export interface MicrovmMachine {
  /** Stable machine kind, e.g. "v86". */
  readonly kind: string;
  /** Whether the machine can be booted/used now (emulator module loaded). */
  readonly available: boolean;
  /** Boot the guest (idempotent). Resolves when the serial shell is ready. */
  boot(): Promise<void>;
  /** Write bytes to the guest serial console (as if typed). */
  writeSerial(data: string): void;
  /** Subscribe to guest serial output. Returns an unsubscribe function. */
  onSerialData(listener: (chunk: string) => void): () => void;
  /** Release the VM. Best-effort; must not throw. */
  dispose?(): Promise<void>;
}

export interface MicrovmExecBackendOptions {
  machine: MicrovmMachine;
  /** Backend id (default "microvm"). */
  id?: string;
  /** Max time to wait for `machine.boot()` before failing an exec (default 60s). */
  bootTimeoutMs?: number;
}

/** Single-quote a value for safe injection into a POSIX shell command line. */
function shSingleQuote(value: string): string {
  // Close the quote, emit an escaped literal quote, reopen: ' -> '\''
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A short unique token; distinguishes a command's real output from console echo. */
function runToken(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const raw = c?.randomUUID ? c.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return raw.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}

/**
 * Frame one command for the serial console. The BEGIN/END markers carry the
 * unique token as printf *arguments* (not in the format literal), so the marker
 * strings only ever appear in the command's OUTPUT — never in the shell's echo
 * of the injected source line — which is what makes output extraction robust to
 * console echo and shell prompts. `cd` into cwd and export env first.
 */
export function frameCommand(command: string, token: string, opts: ExecBackendOptions): string {
  const begin = `printf 'PIWASM_BEGIN_%s\\n' ${shSingleQuote(token)}`;
  const end = `__piwasm_rc=$?; printf 'PIWASM_END_%s:%d\\n' ${shSingleQuote(token)} "$__piwasm_rc"`;
  const prelude: string[] = [];
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) prelude.push(`export ${k}=${shSingleQuote(String(v))}`);
    }
  }
  // cd into the resolved cwd (best-effort; a failed cd still runs the command in
  // the previous dir, matching a permissive shell). Group the user command so a
  // trailing background/newline can't swallow the END marker. The BEGIN marker
  // is emitted AFTER the prelude so no cd/export output can leak into stdout.
  prelude.push(`cd ${shSingleQuote(opts.cwd)} 2>/dev/null`);
  return `${prelude.join("\n")}\n${begin}\n${command}\n${end}\n`;
}

export const BEGIN_RE = (token: string) => new RegExp(`PIWASM_BEGIN_${token}\\r?\\n`);
export const END_RE = (token: string) => new RegExp(`PIWASM_END_${token}:(-?\\d+)\\r?\\n`);

/**
 * Extract `{ stdout, exitCode }` from accumulated serial output for a token.
 * Returns undefined until the END marker has arrived. stdout is the console
 * bytes between the BEGIN marker line and the END marker line.
 */
export function parseSerialResult(
  buffer: string,
  token: string,
): { stdout: string; exitCode: number; consumedTo: number } | undefined {
  const end = END_RE(token).exec(buffer);
  if (!end) return undefined;
  const exitCode = Number.parseInt(end[1], 10);
  const begin = BEGIN_RE(token).exec(buffer);
  const start = begin ? begin.index + begin[0].length : 0;
  let stdout = buffer.slice(start, end.index);
  // Drop exactly one trailing newline that precedes the END marker's printf.
  stdout = stdout.replace(/\r?\n$/, "");
  return { stdout, exitCode, consumedTo: end.index + end[0].length };
}

/** microVM-tier ExecBackend: runs commands in a persistent in-browser Linux guest. */
export class MicrovmExecBackend implements ExecBackend {
  readonly id: string;
  private readonly machine: MicrovmMachine;
  private readonly bootTimeoutMs: number;
  private bootPromise: Promise<void> | undefined;
  private disposed = false;
  /** Serializes exec() calls so their serial output cannot interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: MicrovmExecBackendOptions) {
    this.machine = options.machine;
    this.id = options.id ?? "microvm";
    this.bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  }

  /** Configured + loadable ⇒ available; the guest boots lazily on first exec. */
  get available(): boolean {
    return !this.disposed && this.machine.available;
  }

  private ensureBooted(): Promise<void> {
    if (!this.bootPromise) {
      // Memoize; clear on failure so a later exec can retry the boot.
      this.bootPromise = this.machine.boot().catch((error) => {
        this.bootPromise = undefined;
        throw error;
      });
    }
    return this.bootPromise;
  }

  async exec(command: string, options: ExecBackendOptions): Promise<Result<ExecResult, ExecutionError>> {
    // Chain onto the queue so only one command drives the serial line at a time.
    const run = this.queue.then(() => this.runOne(command, options));
    // Keep the queue alive regardless of this call's outcome.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async runOne(
    command: string,
    options: ExecBackendOptions,
  ): Promise<Result<ExecResult, ExecutionError>> {
    if (this.disposed) return err(new ExecutionError("shell_unavailable", "microvm backend disposed"));
    if (!this.machine.available) {
      return err(new ExecutionError("shell_unavailable", `microvm backend "${this.id}" is unavailable`));
    }
    if (options.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "microvm exec aborted before start"));
    }

    try {
      await this.ensureBooted();
    } catch (error) {
      return err(new ExecutionError("spawn_error", `microvm boot failed: ${toError(error).message}`, toError(error)));
    }

    const token = runToken();
    let buffer = "";
    let streamedTo = 0;
    let sawBegin = false;

    return await new Promise<Result<ExecResult, ExecutionError>>((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: Result<ExecResult, ExecutionError>) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        options.abortSignal?.removeEventListener("abort", onAbort);
        unsubscribe();
        resolve(result);
      };

      const onAbort = () => {
        // Interrupt the running command in the guest, then report aborted.
        try {
          this.machine.writeSerial("\x03");
        } catch {
          /* best-effort */
        }
        finish(err(new ExecutionError("aborted", "microvm exec aborted")));
      };

      const onData = (chunk: string) => {
        buffer += chunk;
        // Stream stdout that has arrived after BEGIN and before END.
        if (!sawBegin) {
          const b = BEGIN_RE(token).exec(buffer);
          if (b) {
            sawBegin = true;
            streamedTo = b.index + b[0].length;
          }
        }
        const parsed = parseSerialResult(buffer, token);
        if (sawBegin && options.onStdout && !parsed) {
          // Emit the growing stdout region (not yet including the END marker).
          const pending = buffer.slice(streamedTo);
          if (pending) {
            options.onStdout(pending);
            streamedTo = buffer.length;
          }
        }
        if (parsed) {
          finish(ok({ stdout: parsed.stdout, stderr: "", exitCode: parsed.exitCode }));
        }
      };

      if (options.abortSignal) options.abortSignal.addEventListener("abort", onAbort, { once: true });
      // Close the race where the signal aborted during boot/queue wait, before
      // the listener was attached (the abort event would otherwise be missed).
      if (options.abortSignal?.aborted) {
        onAbort();
        return;
      }
      if (options.timeout && options.timeout > 0) {
        timer = setTimeout(() => {
          try {
            this.machine.writeSerial("\x03");
          } catch {
            /* best-effort */
          }
          finish(err(new ExecutionError("timeout", `microvm exec exceeded ${options.timeout}s`)));
        }, options.timeout * 1000);
      }

      unsubscribe = this.machine.onSerialData(onData);
      try {
        this.machine.writeSerial(frameCommand(command, token, options));
      } catch (error) {
        finish(err(new ExecutionError("spawn_error", `serial write failed: ${toError(error).message}`, toError(error))));
      }
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.machine.dispose?.();
  }
}

/** Convenience factory (mirrors createHttpRelayExecBackend). */
export function createMicrovmExecBackend(
  options: MicrovmExecBackendOptions,
): MicrovmExecBackend {
  return new MicrovmExecBackend(options);
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  try {
    return new Error(JSON.stringify(error));
  } catch {
    return new Error(String(error));
  }
}
