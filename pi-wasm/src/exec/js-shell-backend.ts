// pi-wasm js-shell backend — the JS-shell reference ExecBackend (pi-wasm S10,
// bead bd-ef8f24; the reference tier proving ms2-2's S13a ExecBackend seam,
// bd-4d085a).
//
// A dependency-free, browser-clean JS shell (coreutils-in-JS) that operates over
// the session's shared ExecutionEnv VFS — so `bash` sees the SAME tree as the S4
// file tools, over lightning-fs (browser) or InMemoryVfs (tests). Plug it into a
// session with `env.setExecBackend(new JsShellBackend(env))`; the `bash` tool
// (S13a) then routes real commands through it.
//
// Contract (SDK Shell / S13a): `exec()` NEVER throws — a failed command is
// `ok:true` with a nonzero exitCode; only aborts/timeouts become an
// ExecutionError. Honors `abortSignal` + `timeout` (seconds) and streams via
// `onStdout`/`onStderr`.

import { err, ExecutionError, ok } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, Result } from "@earendil-works/pi-agent-core";
import type { ExecBackend, ExecBackendOptions, ExecResult } from "./exec-backend";
import { runCommandLine, type ShellState } from "./js-shell/run";

export interface JsShellBackendOptions {
  /** Extra environment variables exposed to the shell (merged over defaults). */
  env?: Record<string, string>;
}

type RaceOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "aborted" }
  | { kind: "error"; error: Error };

/** Race a promise against an optional timeout and abort signal. */
async function raceRun<T>(
  work: Promise<T>,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<RaceOutcome<T>> {
  // Belt-and-suspenders: runCommandLine is defensively non-throwing, but a
  // runner-level bug must still never escape as a rejection (ms2-2 review).
  const racers: Array<Promise<RaceOutcome<T>>> = [
    work.then((value) => ({ kind: "value", value }) as RaceOutcome<T>).catch(
      (error): RaceOutcome<T> => ({ kind: "error", error: error instanceof Error ? error : new Error(String(error)) }),
    ),
  ];
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    racers.push(new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }));
  }
  let onAbort: (() => void) | undefined;
  if (signal) {
    racers.push(new Promise((resolve) => {
      if (signal.aborted) {
        resolve({ kind: "aborted" });
        return;
      }
      onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    }));
  }
  try {
    return await Promise.race(racers);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class JsShellBackend implements ExecBackend {
  readonly id = "js-shell";
  private readonly env: ExecutionEnv;
  private readonly baseEnv: Record<string, string>;

  constructor(env: ExecutionEnv, options: JsShellBackendOptions = {}) {
    this.env = env;
    this.baseEnv = { HOME: "/home", ...options.env };
  }

  /** Always ready: pure JS over the VFS, no async deps to load or endpoint to reach. */
  get available(): boolean {
    return true;
  }

  async exec(command: string, options: ExecBackendOptions): Promise<Result<ExecResult, ExecutionError>> {
    if (options.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));

    const state: ShellState = {
      cwd: options.cwd,
      env: { ...this.baseEnv, ...(options.env ?? {}), PWD: options.cwd },
    };

    const work = runCommandLine(command, this.env, state, {
      onStdout: options.onStdout,
      onStderr: options.onStderr,
      signal: options.abortSignal,
    });

    const timeoutMs = typeof options.timeout === "number" ? options.timeout * 1000 : undefined;
    const raced = await raceRun(work, timeoutMs, options.abortSignal);
    if (raced.kind === "timeout") return err(new ExecutionError("timeout", `timeout:${options.timeout}`));
    if (raced.kind === "aborted") return err(new ExecutionError("aborted", "aborted"));
    if (raced.kind === "error") return err(new ExecutionError("unknown", raced.error.message, raced.error));
    return ok(raced.value);
  }
}

/** Factory form for the S13 id→backend registry (bd-6ebbf6). */
export function createJsShellBackend(env: ExecutionEnv, options?: JsShellBackendOptions): JsShellBackend {
  return new JsShellBackend(env, options);
}
