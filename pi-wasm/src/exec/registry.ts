// pi-wasm exec-backend selection registry (S13, bead bd-6ebbf6).
//
// The per-session SELECTION layer on top of ms2-2's landed S13a ExecBackend
// interface (bd-4d085a): maps a stable backend id to its concrete tier and
// constructs it from a session context. It does NOT own the CHOICE or its
// persistence — that stays with aurora's S11 keyed-session layer (bd-0dc0bc),
// which reads the persisted id, calls `createExecBackend`, and wires the result
// via `env.setExecBackend()`.
//
// Tiers registered:
//   "none"     → NullExecBackend           (S13a; shell_unavailable default)
//   "js-shell" → JsShellBackend            (S10 bd-ef8f24; coreutils over the VFS)
//   "remote"   → RelayExecBackend (http)   (S15 bd-ef14af; ssh-localhost/MCP relay)
//   "microvm"  → MicrovmExecBackend        (S14 bd-c6ffc3; v86 Linux guest)
//
// Construction that needs config the session hasn't provided (a relay endpoint,
// a booted v86 machine) returns `err(...)` rather than throwing, so S11 can fall
// back to "none" or surface the gap.

import { err, ok } from "@earendil-works/pi-agent-core";
import type { ExecutionEnv, Result } from "@earendil-works/pi-agent-core";
import type { ExecBackend } from "./exec-backend";
import { NullExecBackend } from "./exec-backend";
import { createJsShellBackend, type JsShellBackendOptions } from "./js-shell-backend";
import { createHttpRelayExecBackend, type HttpRelayTransportOptions } from "./relay-backend";
import { createMicrovmExecBackend, type MicrovmExecBackendOptions } from "./microvm-backend";

export const EXEC_BACKEND_IDS = ["none", "js-shell", "remote", "microvm"] as const;
export type ExecBackendId = (typeof EXEC_BACKEND_IDS)[number];

/** Everything the registry may need to construct any tier for a session. */
export interface ExecBackendContext {
  /** The session's ExecutionEnv — required by the js-shell tier. */
  env: ExecutionEnv;
  /** Optional js-shell env vars (HOME, etc.). */
  jsShell?: JsShellBackendOptions;
  /** Relay config for the "remote" tier (S6 settings.relay: { endpoint, token }). */
  relay?: HttpRelayTransportOptions;
  /** microVM machine + options for the "microvm" tier (requires a v86 machine). */
  microvm?: MicrovmExecBackendOptions;
}

/** Narrow an arbitrary (e.g. persisted) string to a known ExecBackendId. */
export function isExecBackendId(id: string): id is ExecBackendId {
  return (EXEC_BACKEND_IDS as readonly string[]).includes(id);
}

/**
 * Construct the ExecBackend for a session-selected id. Returns `err` (never
 * throws) when the chosen tier needs config the context doesn't carry, so the
 * caller can fall back to "none".
 */
export function createExecBackend(id: ExecBackendId, ctx: ExecBackendContext): Result<ExecBackend, string> {
  switch (id) {
    case "none":
      return ok(new NullExecBackend());
    case "js-shell":
      return ok(createJsShellBackend(ctx.env, ctx.jsShell));
    case "remote":
      if (!ctx.relay || !ctx.relay.endpoint) {
        return err('exec backend "remote" requires relay settings with an endpoint (S6 settings.relay)');
      }
      return ok(createHttpRelayExecBackend(ctx.relay));
    case "microvm":
      if (!ctx.microvm || !ctx.microvm.machine) {
        return err('exec backend "microvm" requires a MicrovmMachine (S14)');
      }
      return ok(createMicrovmExecBackend(ctx.microvm));
    default: {
      // Defensive: a raw/stale persisted id that slipped past isExecBackendId.
      const unknown: string = id;
      return err(`unknown exec backend id: ${unknown}`);
    }
  }
}
