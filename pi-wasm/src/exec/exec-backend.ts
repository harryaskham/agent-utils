// Pluggable execution backend seam for pi-wasm (S13a, bead bd-4d085a).
//
// The S2 BrowserExecutionEnv isolates `exec()` as the single place any shell
// plugs in. This defines the swappable backend interface + a default
// `NullExecBackend` (== the S2 no-bash behavior). Concrete tiers plug in here
// without touching the Agent loop, the file tools (S4), or the VFS (S2):
//   remote (ssh/MCP bridge) · js-shell (coreutils-in-JS over the VFS) ·
//   WebContainer · wasm microVM (v86/CheerpX) — see scratch pi-wasm:exec-backend-seam.
// Backend selection is per-session (Harry's "selectable per session"; owned by
// the S11 keyed-session layer).

import { err, ExecutionError } from "@earendil-works/pi-agent-core";
import type { Result, ShellExecOptions } from "@earendil-works/pi-agent-core";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** SDK ShellExecOptions plus the resolved absolute working directory. */
export type ExecBackendOptions = ShellExecOptions & { cwd: string };

/**
 * A shell execution backend. `exec()` must honor the same contract as the SDK
 * Shell.exec: never throw/reject — encode all failures in the returned Result;
 * respect `abortSignal` + `timeout`; stream via `onStdout`/`onStderr` where the
 * backend supports it.
 */
export interface ExecBackend {
  /** Stable id, e.g. "none" | "remote" | "js-shell" | "webcontainer" | "microvm". */
  readonly id: string;
  /**
   * Whether the backend can run now (deps loaded, endpoint reachable).
   *
   * `exec()` gates on this AT CALL TIME, so backends whose reachability changes
   * at runtime (e.g. the remote / ssh-localhost tier) should implement this as a
   * GETTER rather than a construction-time snapshot. The `readonly` modifier
   * permits a getter.
   */
  readonly available: boolean;
  exec(command: string, options: ExecBackendOptions): Promise<Result<ExecResult, ExecutionError>>;
  /** Release backend resources. Best-effort; must not throw. */
  dispose?(): Promise<void>;
}

export const SHELL_UNAVAILABLE_MESSAGE =
  "exec/bash is unavailable in the browser VFS environment (pi-wasm no-bash MVP; configure an ExecBackend — see pi-wasm S13/S14)";

/** Default backend: no shell. Preserves the S2 `shell_unavailable` behavior. */
export class NullExecBackend implements ExecBackend {
  readonly id = "none";
  readonly available = false;
  async exec(_command: string, _options: ExecBackendOptions): Promise<Result<ExecResult, ExecutionError>> {
    return err(new ExecutionError("shell_unavailable", SHELL_UNAVAILABLE_MESSAGE));
  }
}
