# Per-session context limits (`/context 500k`)

## Why

Pi compacts a conversation when its context nears the model's window: the window minus `compaction.reserveTokens`. On a 1M-token model with a 64k reserve, that's about 936k. So a long session sits at 400–900k tokens, and every request re-reads all of it from cache. That's most of the cost of long sessions.

A profile can lower the threshold for a model for every session (Pi's `settings.json`: `compaction.modelOverrides["provider/modelId"].reserveTokens`; pi-daemon passes it to its sessions from bd-6bea0a on). `/context` sets a limit for one session: lower than the profile's, or, in pi-daemon on Pi 1.5.2 and later, higher, for a session that needs the whole window.

| Command | Effect |
| --- | --- |
| `/context 500k` | The session's context is kept to 500k tokens (also `1.2m`, `300000`; at least 20k, and under the model's window). |
| `/context` | Shows the limit and the current context. |
| `/context off` | Back to the profile's threshold for the model. |

## Opt-in

The plugin isn't loaded by default, and once loaded it does nothing until a session sets a limit.

| Host | File | Enable by | The limit is kept in |
| --- | --- | --- | --- |
| TUI Pi | `extensions/context-limit.js` (not in the package manifest) | listing it in `settings.json`'s `extensions` | a custom session entry (`agent-utils:context-limit`), so it follows the session and its branches across restarts |
| pi-daemon | `extensions/durable/context-limit.mjs` (the Nix package exports it as `context-limit.mjs`) | listing it in a profile's extensions | the module's per-session state |

The editor chips' context chip shows a session's limit while one is set: the share of the limit
used, then `≤500k` (the limit, not the model's window) in orange. TUI Pi reads it from the
session's limit entry; pi-client follows the pi-daemon module's per-session state, so a limit set
from any client shows in every pane of that session. `/context off` brings back the window.

## When it compacts

- **TUI Pi:** after a run, once the agent has settled. Pi's `compact()` stops a running agent, so the extension waits for `agent_settled`, as `self-compact.js` does, and compacts only if Pi is idle with nothing pending. A long run can pass the limit until it ends; the model's own threshold still applies during it. RPC mode and Paratenic's AHP bridge are left alone.
- **pi-daemon on Pi 1.5.2 and later:** the limit is the conversation's own compaction setting. `/context` writes an override for the session's model with Durable's `configure({ compaction })`: `reserveTokens` is the model's window less the limit. Durable then keeps every request under the limit: a background compaction starts shortly before it (the profile's `backgroundTokens`, 32,768 by default), and a request that would pass it waits for the summary. A conversation's own override holds over the profile's for that model, so a limit above the profile's threshold raises it for this session. Forks and sub-agents inherit it. Other compaction settings of the conversation are kept; `/context off` takes only the limit out. If the session changes model, the limit is not carried over until `/context` is run again; until then the observer below keeps it, which can only compact earlier than the profile's threshold.
- **pi-daemon before that (1.14 and later):** as soon as a response's context passes the limit. The observer asks for Durable's background compaction (`info.compact`): the run goes on, and the summary is placed at the next boundary. It asks once, and again only if the context is still over the limit ten minutes later. Older pi-daemons don't offer `info.compact`; the limit is then kept but never acts.

A response's context is what it sent and what came back: input, cache read and write, and output.
