# Session summary — durable /tts "Session is closed" after a session store reopen

## Goal

Find and fix why `/tts on` in pi-daemon durable sessions failed with `/tts: Session is closed` while `/tts status` worked, and pin it with a test that toggles /tts after the session's store is replaced.

## Bead(s)

- `bd-963c23` — Daemon-side /tts on fails with 'Session is closed' in pi-daemon durable sessions (status works)

## Before state

- Failing tests: none (no test closed a session's store between calls).
- Cause: pi-daemon 1.14.0 gives each module command and observer a `ctx.state` built by `moduleState(harness, …)`, bound to the session's open Harness. Session stores close when idle (or are replaced) and reopen as a new Harness. `extensions/lib/durable-agent-audio.js` kept the first call's `ctx.state` in its per-session record and wrote settings and the spoken ledger through it, so after a reopen every write threw pi-durable's `Session is closed`. `/tts status` only reads in-memory state, so it kept working. The failure lasted until the worker reloaded the module, which matches "transient but repeated all day".

## After state

- Failing tests: none; `test/durable-agent-audio.test.js` 24/24, all durable and tts-narration-durable suites 122/122.
- Writes (`saveSettings`, ledger `claim`) use the current call's state handle; the session record adopts the newest durable handle for any write without one. No retries or guards were added.
- The new test fails on the old code with exactly `/tts: Session is closed`.

## Diff summary

- Code/content commits: 75804ae5 (final squash SHA comes from the reintegration receipt).
- Summary artefact commit: intentionally omitted.
- Files touched: `extensions/lib/durable-agent-audio.js`, `test/durable-agent-audio.test.js`.
- Tests: +1 (store closes and reopens between `/tts status`, `/tts on`, an observed `message_end`, `/narrate on`, `/tts off`, then a worker restart checks the ledger persisted).
- Behavioural delta: `/tts` and `/narrate` toggles and once-only speech claims persist after pi-daemon idles out or replaces a session's store.

## Operator-takeaway

Every pi-daemon module ctx handle (`state`, `ui`, `env`, `harness`) is bound to one Harness and must be used per call, never cached in module memory. I grepped the other durable modules (git, cacophony, context-limit, visual-thoughts, loop, choice, voice) and they already read `ctx.state` per call; durable audio was the only one that kept a handle.
