// pi-wasm S15 (bd-ef14af): the REMOTE tier of the pluggable exec-backend seam.
//
// The browser sandbox cannot open raw TCP/ssh, so heavy work (real bash, big
// builds, host tools) is offloaded to a server through a RELAY the tab CAN
// reach: an HTTP/WebSocket endpoint that runs the command on a real host
// (ssh-into-localhost, a mesh node, or an MCP/provided-tool bridge) and returns
// stdout/stderr/exitCode. See RELAY.md for the relay contract + security model.
//
// RelayExecBackend implements ms2-2's landed `ExecBackend` (S13a bd-4d085a): it
// registers as id="remote" through ms2-0's id→backend factory (S13 bd-6ebbf6)
// and is selected per session by aurora's S11. Transport is pluggable so a
// streaming WebSocket transport can drop in behind the same backend later.

import { ok, err, ExecutionError } from "@earendil-works/pi-agent-core";
import type { Result } from "@earendil-works/pi-agent-core";
import type { ExecBackend, ExecBackendOptions, ExecResult } from "./exec-backend";

/** A command to run on the remote host, as sent to the relay. */
export interface RelayRunRequest {
  command: string;
  /** Resolved absolute working directory on the remote host. */
  cwd: string;
  /** Extra environment variables for the command. */
  env?: Record<string, string>;
  /** Timeout in seconds, forwarded so the relay can enforce it host-side too. */
  timeoutSeconds?: number;
}

/** What the relay returns for a completed command. */
export interface RelayExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Per-run streaming/abort hooks handed to a transport. */
export interface RelayRunHooks {
  abortSignal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * The relay transport seam. `run()` MAY throw/reject (network, non-2xx, abort) —
 * RelayExecBackend catches and maps to the stable ExecutionError codes. A
 * non-streaming transport (HTTP) emits the full stdout/stderr as single chunks;
 * a streaming transport (WebSocket/SSE) emits chunks as they arrive.
 */
export interface RelayTransport {
  /** Stable transport kind, e.g. "http" | "websocket". */
  readonly kind: string;
  /** Whether the transport is configured + believed reachable right now. */
  readonly available: boolean;
  run(request: RelayRunRequest, hooks: RelayRunHooks): Promise<RelayExecResponse>;
  /** Release transport resources. Best-effort; must not throw. */
  dispose?(): Promise<void>;
}

export interface HttpRelayTransportOptions {
  /** Relay endpoint URL, e.g. "http://localhost:8730/exec" (empty ⇒ unavailable). */
  endpoint: string;
  /** Bearer token presented to the relay (the relay's OWN auth — never a model key). */
  token?: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
  /** Injectable fetch for tests / custom transports. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Non-streaming HTTP relay transport: POSTs the command as JSON and reads back a
 * `{ stdout, stderr, exitCode }` JSON response. Emits stdout/stderr as one chunk
 * each. The relay must implement the contract documented in RELAY.md.
 */
export class HttpRelayTransport implements RelayTransport {
  readonly kind = "http";
  private readonly endpoint: string;
  private readonly token?: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpRelayTransportOptions) {
    this.endpoint = options.endpoint ?? "";
    this.token = options.token;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  get available(): boolean {
    return this.endpoint.length > 0 && typeof this.fetchImpl === "function";
  }

  async run(request: RelayRunRequest, hooks: RelayRunHooks): Promise<RelayExecResponse> {
    const headers: Record<string, string> = { "content-type": "application/json", ...this.headers };
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers,
      signal: hooks.abortSignal,
      body: JSON.stringify({
        command: request.command,
        cwd: request.cwd,
        env: request.env,
        timeout: request.timeoutSeconds,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `relay responded ${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const data = (await response.json()) as Partial<RelayExecResponse>;
    const result: RelayExecResponse = {
      stdout: typeof data.stdout === "string" ? data.stdout : "",
      stderr: typeof data.stderr === "string" ? data.stderr : "",
      exitCode: typeof data.exitCode === "number" ? data.exitCode : 0,
    };
    if (hooks.onStdout && result.stdout) hooks.onStdout(result.stdout);
    if (hooks.onStderr && result.stderr) hooks.onStderr(result.stderr);
    return result;
  }
}

export interface RelayExecBackendOptions {
  transport: RelayTransport;
  /** Backend id (default "remote"). */
  id?: string;
}

/** Remote-tier ExecBackend: runs commands off-device through a relay transport. */
export class RelayExecBackend implements ExecBackend {
  readonly id: string;
  private readonly transport: RelayTransport;

  constructor(options: RelayExecBackendOptions) {
    this.transport = options.transport;
    this.id = options.id ?? "remote";
  }

  /** Reachability can change at runtime, so this is a getter (per the ExecBackend contract). */
  get available(): boolean {
    return this.transport.available;
  }

  async exec(command: string, options: ExecBackendOptions): Promise<Result<ExecResult, ExecutionError>> {
    if (!this.available) {
      return err(
        new ExecutionError(
          "shell_unavailable",
          `remote exec backend "${this.id}" is unavailable (no relay endpoint configured/reachable)`,
        ),
      );
    }
    if (options.abortSignal?.aborted) {
      return err(new ExecutionError("aborted", "remote exec aborted before start"));
    }

    const timeoutSignal =
      options.timeout && options.timeout > 0 ? AbortSignal.timeout(options.timeout * 1000) : undefined;
    const sources = [options.abortSignal, timeoutSignal].filter((s): s is AbortSignal => Boolean(s));
    const abortSignal = sources.length > 0 ? AbortSignal.any(sources) : undefined;

    try {
      const response = await this.transport.run(
        { command, cwd: options.cwd, env: options.env, timeoutSeconds: options.timeout },
        { abortSignal, onStdout: options.onStdout, onStderr: options.onStderr },
      );
      return ok({
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
        exitCode: typeof response.exitCode === "number" ? response.exitCode : 0,
      });
    } catch (error) {
      // Order matters: an explicit user abort outranks the timeout.
      if (options.abortSignal?.aborted) {
        return err(new ExecutionError("aborted", "remote exec aborted", toError(error)));
      }
      if (timeoutSignal?.aborted) {
        return err(new ExecutionError("timeout", `remote exec exceeded ${options.timeout}s`, toError(error)));
      }
      return err(
        new ExecutionError(
          "spawn_error",
          `remote exec failed via ${this.transport.kind} relay: ${toError(error).message}`,
          toError(error),
        ),
      );
    }
  }

  async dispose(): Promise<void> {
    await this.transport.dispose?.();
  }
}

/** Convenience: a remote ExecBackend over the built-in HTTP relay transport. */
export function createHttpRelayExecBackend(
  options: HttpRelayTransportOptions & { id?: string },
): RelayExecBackend {
  const { id, ...transportOptions } = options;
  return new RelayExecBackend({ transport: new HttpRelayTransport(transportOptions), id });
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
