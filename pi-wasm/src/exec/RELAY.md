# pi-wasm remote exec relay (S15, bd-ef14af)

The **remote tier** of the pluggable exec-backend seam (S13, bd-6ebbf6) offloads
heavy work the browser sandbox cannot do — real `bash`, big builds, host tools,
GPU, internal-network access — to a real host. Browsers cannot open raw TCP/ssh,
so the tab talks to a **relay** it *can* reach (HTTP/WebSocket), and the relay
runs the command on the host (ssh-into-localhost, a mesh node, or via an
MCP/provided-tool bridge) and streams the result back.

`RelayExecBackend` implements the landed `ExecBackend` interface (S13a,
`src/exec/exec-backend.ts`); it registers as `id: "remote"` through the S13
id→backend factory (bd-6ebbf6) and is selected per session by S11.

## Browser usage

```ts
import { createHttpRelayExecBackend } from "./exec";
import { toRuntimeConfig, SettingsStore } from "./settings";

// Read the relay endpoint/token from the top-level S6 settings.relay field
// (a secret, kept out of the VFS settings.json), set in the Settings screen:
//   settings.relay = { endpoint: "http://localhost:8730/exec", token: "…" }
const cfg = (await new SettingsStore().load()).relay;

const backend = createHttpRelayExecBackend({
  endpoint: cfg?.endpoint ?? "",
  token: cfg?.token,
});
// env.setExecBackend(backend)  // wired per-session by S13 registry / S11
```

`backend.available` is `false` when no endpoint is configured, so `exec()`
degrades to the stable `shell_unavailable` error rather than throwing.

## Relay HTTP contract (transport = `http`)

The relay MUST expose an endpoint that:

- Accepts `POST <endpoint>` with `Content-Type: application/json` and body:
  ```json
  { "command": "ls -la /work", "cwd": "/work", "env": { "K": "V" }, "timeout": 30 }
  ```
- Authenticates via `Authorization: Bearer <token>` (the relay's OWN token; see
  security below).
- Runs the command on the host (e.g. `ssh localhost -- sh -lc '<command>'`,
  honoring `cwd`, `env`, and the `timeout` seconds) and responds `200` with:
  ```json
  { "stdout": "…", "stderr": "…", "exitCode": 0 }
  ```
- Returns a non-2xx status on failure (mapped to `spawn_error` client-side).

A streaming WebSocket/SSE transport can drop in behind the same `RelayExecBackend`
later by implementing `RelayTransport` (emit `onStdout`/`onStderr` chunks as they
arrive); the backend + `ExecBackend` contract are unchanged.

## ssh-into-localhost

Operator-approved (Harry, 2026-07-09): the relay may `ssh` into **localhost** (or
a mesh node) to give the in-browser agent a real shell on the user's own machine.
The caco codebase has many ssh-to-localhost exec patterns to model the relay on.
A minimal reference relay (a small first-party ws↔ssh / authenticated-exec
service) is a follow-up; this slice delivers the browser-side backend + contract.

## Security model

- **Token-only auth.** The relay authenticates the browser with its own Bearer
  token. Model API keys are NEVER sent through the relay.
- **Explicit, operator-visible endpoint.** No ambient host access: the relay
  endpoint (and token) are configured explicitly in S6 settings; nothing runs
  remotely unless an endpoint is set (`available === false` otherwise).
- **Host-side allowlist.** The relay is responsible for command/host allowlisting,
  sandboxing, and refusing to exfiltrate secrets — the browser cannot enforce
  this. Document + default the relay to least privilege.
- **Isolation.** The remote tier is one swappable backend; it cannot regress the
  light no-bash MVP path (default `NullExecBackend`) or the JS-shell tier.
