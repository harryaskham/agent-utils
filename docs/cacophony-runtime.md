# Lightweight Cacophony runtime integration

`extensions/cacophony-runtime.js` gives Agent Utils extensions one shared runtime identity without rewriting `settings.json` or mutating the parent Pi process environment.

## Global opt-out

Set:

```sh
DISABLE_PI_CACO=1
```

before launching Pi to disable Agent Utils Cacophony integrations. This takes precedence over managed identity and settings. It disables visiting registration, choice mirroring, force-agent Cacophony speech, realtime voice quickfile, and transient MCP startup. Local choice, speech, STT, and editor behavior remain available.

## Identity discovery

The runtime recognizes:

- agent: `CACO_AGENT_ID`, `CACOPHONY_AGENT_ID`, then legacy `CACOPHONY_AGENT`
- project: `CACO_PROJECT`, then `CACOPHONY_PROJECT`

An explicit complete agent/project pair normally wins and no visiting registration is attempted.

For shared-process Pi-Daemon sessions, Cacophony supplies the same values through
Pi's session-scoped extension flags: `caco-agent-id`, `caco-project`, and
`disable-pi-caco`. Flags take precedence over ambient `process.env`, because the
host process environment belongs to Pi-Daemon rather than any logical session.
Each Pi `ExtensionAPI` instance owns an independent runtime identity context;
module-global identity is never used for managed logical sessions. This prevents
two concurrent agents from inheriting or overwriting each other's identity.

Other Agent Utils extensions resolve identity from `extensions/lib/cacophony-runtime.js`, so a visiting or logical-session identity becomes usable immediately without mutating `process.env`. Child Cacophony processes receive the resolved identity only in their own scoped environment.

## Visiting-agent auto-registration

Enable immutable startup policy in `settings.json`:

```json
{
  "agentUtils": {
    "cacophony": {
      "autoRegister": true
    }
  }
}
```

`PI_CACO_AUTO_REGISTER=1|0` is an optional process-local startup override.

Registration runs only when:

1. Cacophony integration is not globally disabled.
2. a project environment variable is present;
3. no explicit agent identity is present;
4. auto-registration is enabled; and
5. `TMUX` is set.

Without tmux, the extension performs no registration and shows one warning because visiting agents require a stable tmux pane.

After session startup, registration runs asynchronously:

```text
caco agent register --project <project> --json
```

Only a receipt containing a non-empty durable agent ID and project is accepted. Success writes a custom session receipt, publishes the shared runtime identity, and adds one visible/context message explaining that the session is registered as a visiting agent. Failure leaves Pi functional and emits one bounded warning.

On reload or restart, the latest matching session receipt restores the runtime identity without rerunning the CLI or duplicating the registration message. `/caco-runtime` shows the current managed, visiting, disabled, in-progress, or unregistered state.

## Transient Cacophony MCP

Agent Utils declares `pi-mcp-adapter` as its own runtime dependency, so package
resolution does not depend on a sibling Pi package directory. Because adapter
2.25 publishes TypeScript source, loading uses Pi's native loader when available
and a bundled `jiti` fallback elsewhere.

`extensions/cacophony-mcp.js` consumes the shared identity and registers one
session-scoped server named `cacophony-runtime`:

```text
caco mcp stdio
```

The server uses `lifecycle: "keep-alive"`, so the adapter owns connection,
metadata discovery, health recovery, tool refresh, and shutdown. When the
adapter exposes its newer `registerMcpServer()` API, registration updates that
runtime directly. Adapter 2.25 falls back to its public isolated
`createMcpAdapter({ config })` API through a scoped Pi facade: the proxy tool is
named `caco_mcp` and adapter slash commands are `caco-*`, so the operator's
ordinary multi-server `mcp` tool and commands are never overwritten.

Only the child definition receives:

```text
CACO_AGENT_ID=<resolved managed-or-visiting id>
CACO_PROJECT=<resolved project>
```

The extension never writes those values into `process.env` or `settings.json`.
It does nothing when `DISABLE_PI_CACO=1`, identity/project is incomplete, or
visiting registration was skipped (including the no-tmux case). Registration is serialized and deduplicated per identity. The native runtime
API disposes an old identity before replacement. The 2.25 compatibility adapter
is session-owned and tears down through its own `session_shutdown` handler; an
unexpected mid-session identity change asks for a reload instead of leaking a
second adapter. Adapter or transport failure leaves Pi functional and produces
one bounded warning.

Use `/caco-mcp` to inspect whether the transient server is disabled, waiting for
identity/adapter registration, or registered for a concrete project and agent.
With the 2.25 compatibility path, use the `caco_mcp` tool and `caco-mcp`-prefixed
adapter commands; the ordinary `/mcp status` continues to describe the separate
ambient multi-server adapter.

## Security and lifecycle

- Settings and parent-process startup environment are never rewritten.
- Pi-Daemon must inject the three session extension flags alongside its existing
  `runtimeOptions.environmentOverlay`; Agent Utils fails back to ordinary
  process environment only for single-session Pi compatibility.
- Registration uses the existing `caco` CLI and its configured local daemon/auth policy.
- No identity is inferred from a timeout, malformed response, or failed command.
- A project-less session never registers.
- The visiting identity is scoped to the Pi session and child integrations that explicitly consume the shared runtime context.
- The transient MCP uses the canonical `caco mcp stdio` child process; Agent Utils does not implement an MCP protocol client.
- Child identity is explicit and scoped. Existing parent identity variables are read but never rewritten.
