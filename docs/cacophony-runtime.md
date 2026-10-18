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

An explicit complete agent/project pair always wins and no visiting registration is attempted.

Other Agent Utils extensions resolve identity from `extensions/lib/cacophony-runtime.js`, passing the current Pi context (or a scope getter) to `getCacophonyRuntimeIdentity(env, ctx)`. Visiting identities and identity listeners are keyed by the live `ctx.sessionManager.getSessionId()`, never by cwd or inherited `PI_SESSION_ID`. An unscoped lookup can resolve a complete managed environment identity, but cannot borrow a visitor from another session. Child Cacophony processes receive the resolved identity only in their own scoped environment.

### Pi-Daemon logical sessions

Agent Utils deliberately reads ordinary `process.env`; it does not implement a private environment overlay. Pi-Daemon `0.3.9` and later provide the generic host contract: extension loading, callbacks, commands, tools, RPC, runtime replacement, and asynchronous continuations run with a logical per-session `process.env` view. That view combines a neutral supervisor-owned service baseline with exactly one session overlay, and writes/deletes remain local to that session.

Consequently, the same Agent Utils package can run concurrently for sessions A and B while resolving different Cacophony identities, child MCP environments, choice mirrors, and graphics namespaces. A complete managed environment identity always overrides that session's visiting fallback. `DISABLE_PI_CACO` is likewise session-local under Pi-Daemon. Agent Utils must never emulate this by temporarily mutating a shared host environment; older Pi-Daemon versions without the generic contract are unsupported for concurrent managed logical sessions.

Pi conversation identity and an external Pi-Daemon logical session ID are **not interchangeable**. In the classic Pi-Daemon adapter, the host's `request.sessionId` is separate from the Pi `SessionManager` conversation ID and is not published through classic `ExtensionContext`. The Durable module API used by Pi-Daemon 1.x has a different context with a `sessionId`; this classic Pi extension is not a Durable module.

A host/operator that knows the actual external ID can explicitly supply `PI_CACO_RUNTIME_AGENT_ID=<external-id>` in that logical session's environment. Registration then passes `--runtime-agent-id <external-id>` as provenance; Cacophony stores it as an annotation/default short name, not as a managed identity. The extension never invents this ID from the conversation UUID, cwd, profile name, inherited Pi metadata, or Cacophony agent variables. Without an explicit external ID the flag is omitted. Automatic discovery of the host's external PD ID requires a host-provided identity contract; it is not claimed here.

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
4. auto-registration is enabled.

Registration supports Herdr and other hosts supported by the Caco CLI; the plugin does not require tmux. The CLI runs with Pi's session `ctx.cwd` as its working directory, not the MCP daemon's directory.

After session startup, registration runs asynchronously:

```text
caco agent register --project <project> --session-id <current-pi-session-id> [--runtime-agent-id <explicit-external-id>] --json
```

Registration requires `ctx.sessionManager.getSessionId()` even if the parent environment names another session. It fails closed when the live ID is unavailable. Use a Caco build containing the `--session-id` and `--runtime-agent-id` registration flags (Cacophony PR #4505); there is no fallback to cwd-based registration on older builds.

Only a response containing a non-empty durable agent ID for the requested project is accepted; session/runtime provenance, when returned, must match the request. Success writes a version-2 custom session receipt including the Pi session ID and explicit external provenance, publishes the scoped runtime identity, and adds one visible/context message explaining that the session is registered as a visiting agent. Failure leaves Pi functional and emits one bounded warning.

When the receipt carries Cacophony's rendered `visiting` profile (`guidance.text`, Caco bd-ae0ff8), that message includes it in full: how identity, messages, beads and queues work for a visitor (including running `caco` with `CACOPHONY_ACTOR=<visiting id>`), that it owns its checkout and publishes regular pull requests, and that managed lifecycle commands are not for it. The transcript shows only the one-line headline, marked `visiting guidance attached`. Older Caco versions without `guidance` keep the one-line message.

On reload or restart, the latest active-branch receipt matching **session ID, project, and external provenance** restores the runtime identity without rerunning the CLI or duplicating the registration message. Legacy receipts without a session ID and inherited parent/fork receipts are not restored. With no configured project, a matching receipt can restore its own project. Abandoned branches are not searched.

New sessions, forks, and switches invalidate the old visiting fallback. An old asynchronous registration may finish its CLI request, but cannot append a receipt, announce identity, or clear a new session's in-flight request. Shutdown clears only this runtime's owned session identity; other logical sessions remain registered. `/caco-runtime` shows the current managed, visiting, disabled, in-progress, or unregistered state.

## Manual visiting-agent registration

Use `/caco-agent-register` to register the current session explicitly, including when `autoRegister` is false (the default) or `PI_CACO_AUTO_REGISTER=0`. With no argument it uses the configured project environment variable. `/caco-agent-register project=tools` selects a project for that registration, including when neither project environment variable is set. Both forms use the actual Pi session working directory and live conversation ID, just like startup registration. No settings or parent environment variables are changed. An existing managed or visiting identity is reused rather than silently reassigning it to another project.

Manual and startup registration share the same in-flight request, durable receipt, identity publication, and downstream MCP notification. Repeated commands reuse the existing identity. Receipts restore on reload/restart even with auto-registration off.

`/caco-runtime` distinguishes **unregistered; auto-registration off** from **disabled by DISABLE_PI_CACO** and points to the manual command. The latter is a global kill switch and still blocks manual registration; use `PI_CACO_AUTO_REGISTER=0`, not `DISABLE_PI_CACO=1`, when only boot registration should be disabled.

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

The child server also receives the Pi session working directory through its `cwd` launch option. This applies to the session-owned server, not separately configured ambient/remote MCP servers; use `/caco-agent-register` for registering the current Pi session rather than a remote server's working directory.

The extension never writes those values into `process.env` or `settings.json`.
It does nothing when `DISABLE_PI_CACO=1`, identity/project is incomplete, or
visiting registration was skipped. Registration is serialized and deduplicated per identity. The native runtime
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
- Registration uses the existing `caco` CLI and its configured local daemon/auth policy.
- No identity is inferred from a timeout, malformed response, or failed command.
- A session without a configured or explicitly requested project never registers.
- The visiting identity is scoped to the Pi session and child integrations that explicitly consume the shared runtime context.
- The transient MCP uses the canonical `caco mcp stdio` child process; Agent Utils does not implement an MCP protocol client.
- Child identity is explicit and scoped. Existing parent identity variables are read but never rewritten.
