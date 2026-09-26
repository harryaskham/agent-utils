# Safe self-compaction boundaries

`self_compact` is an optional standalone-Pi convenience, not a portable AHP lifecycle operation.

## RPC/AHP safety

The tool is hidden at context/tool boundaries and refused at execution in RPC mode or while the generic Paratenic AHP bridge is enabled. A late bridge announcement cancels pending self-compaction and removes the tool. This is deliberate: the current generic bridge does not expose an exactly-once, client-correlated compact-and-resume operation. Agent Utils must not turn a client-owned request into an abort followed by an uncorrelated autonomous turn.

Use the owning controller's supported compaction path instead. This change does **not** implement a new AHP capability, alter Paratenic transport, or automatically resume historical aborted client requests.

## Standalone lifecycle

Previously the tool called `ctx.compact()` inside its own `execute()`. Pi's session implementation calls `abort()` at the start of manual compaction. That can abort the very tool run whose result and continuation the client is waiting for.

The tool now:

1. checks context usage (75% default), rate limit and runtime support;
2. returns a queued receipt with `terminate: true`, allowing the tool result to settle normally;
3. waits for `agent_settled`, not merely `agent_end`;
4. defers out of the event dispatcher, avoiding compact → abort → event-drain reentrancy;
5. rechecks that the session is idle, has no queued input, and has not changed generations;
6. starts compaction and issues one continuation only on success, while still idle.

New input, a new run, shutdown or an AHP bridge announcement invalidates pending work. Abort before admission prevents compaction. Errors are reported without an automatic restart or retry loop. Duplicate completion callbacks cannot cause duplicate turns. If sibling tools prevent immediate termination, compaction waits for the eventual normal settled boundary.

Manual `/compact` is unchanged. The ordinary post-compaction role checkpoint remains non-triggering and cannot by itself resume an aborted client request.

## Operator disablement

`PI_SELF_COMPACT_TOOL=0` prevents registration. In managed `settings.json`, disable the extension through the package filter:

```json
{
  "source": "git:github.com/harryaskham/agent-utils",
  "extensions": ["!extensions/self-compact.js"]
}
```

Model self-selection is a separate policy:

```json
"selfModelSelection": { "models": [] }
```

The empty allowlist denies `self_set_model`; it does not disable manual `/m` or `/model`. Keep `m.js` loaded for the operator command. Existing Pi processes must reload settings/extensions; editing settings does not retroactively change their loaded tool sets.

Regression tests: `test/self-compact.test.js` covers deferred ordering, idle/pending-input checks, new-input/shutdown fences, RPC/AHP refusal, thresholds and exactly-once continuation. `test/m-command.test.js` covers agent allowlist enforcement separately from manual switching. No production compaction or mass Culture-session recovery is performed by these tests.
