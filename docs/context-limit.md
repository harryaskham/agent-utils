# Per-session context limits (`/context 500k`)

## Why

Pi compacts a conversation when its context nears the model's window: the window minus `compaction.reserveTokens`. On a 1M-token model with a 64k reserve, that's about 936k. So a long session sits at 400–900k tokens, and every request re-reads all of it from cache. That's most of the cost of long sessions.

A global lower threshold would cost the sessions that need the whole window. `/context` sets a limit for one session.

| Command | Effect |
| --- | --- |
| `/context 500k` | The session compacts when its context passes 500k tokens (also `1.2m`, `300000`; at least 20k). |
| `/context` | Shows the limit and the current context. |
| `/context off` | Back to the model's own threshold. |

## Opt-in

The plugin isn't loaded by default, and once loaded it does nothing until a session sets a limit.

| Host | File | Enable by | The limit is kept in |
| --- | --- | --- | --- |
| TUI Pi | `extensions/context-limit.js` (not in the package manifest) | listing it in `settings.json`'s `extensions` | a custom session entry (`agent-utils:context-limit`), so it follows the session and its branches across restarts |
| pi-daemon | `extensions/durable/context-limit.mjs` (the Nix package exports it as `context-limit.mjs`) | listing it in a profile's extensions | the module's per-session state |

## When it compacts

- **TUI Pi:** after a run, once the agent has settled. Pi's `compact()` stops a running agent, so the extension waits for `agent_settled`, as `self-compact.js` does, and compacts only if Pi is idle with nothing pending. A long run can pass the limit until it ends; the model's own threshold still applies during it. RPC mode and Paratenic's AHP bridge are left alone.
- **pi-daemon (1.14 and later):** as soon as a response's context passes the limit. The observer asks for Durable's background compaction (`info.compact`): the run goes on, and the summary is placed at the next boundary. It asks once, and again only if the context is still over the limit ten minutes later. Older pi-daemons don't offer `info.compact`; the limit is then kept but never acts.

A response's context is what it sent and what came back: input, cache read and write, and output.
