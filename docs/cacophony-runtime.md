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

Other Agent Utils extensions resolve identity from `extensions/lib/cacophony-runtime.js`, so a visiting identity becomes usable immediately without mutating `process.env`. Child Cacophony processes receive the resolved identity only in their own scoped environment.

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

## Security and lifecycle

- Settings and parent-process startup environment are never rewritten.
- Registration uses the existing `caco` CLI and its configured local daemon/auth policy.
- No identity is inferred from a timeout, malformed response, or failed command.
- A project-less session never registers.
- The visiting identity is scoped to the Pi session and child integrations that explicitly consume the shared runtime context.
