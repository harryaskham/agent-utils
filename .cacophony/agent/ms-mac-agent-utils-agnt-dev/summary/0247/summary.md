# Session summary — defer realtime VAD turns during compaction

## Goal

Harden the just-landed realtime simple compaction path so speech/VAD activity during compaction is queued safely and does not require re-entering `/rt`.

## Bead(s)

- `bd-2e7385` — Harden realtime VAD during compaction

## Before state

- Realtime compaction had been changed to stay active via local/simple summary, but a server VAD `input_audio_buffer.committed` event during the short compaction window could still try to queue a Pi audio follow-up while compaction was rewriting session history.
- Barge-in `speech_started` could also abort the in-flight agent loop even while compaction was running.

## After state

- Realtime now opens a compaction window in `session_before_compact` and closes it on `session_compact`.
- If committed audio arrives while compacting, `triggerCommittedAudioTurn()` defers exactly one audio turn and automatically queues it after the compaction entry is appended.
- `speech_started` no longer barge-in aborts the agent during the compaction window.
- A 30s fallback closes the window if the follow-up compact event never arrives, preventing permanent deferral.
- Closing realtime clears the compaction window and pending deferral.

## Validation

- `node --check extensions/realtime-agent.js`
- `node --test test/realtime-agent.test.js` — 49/49 pass
- `npm run docs:check` — pass
- `git diff --check` — pass
- `npm test` — 293/293 pass

## Diff summary

- Code commit: `9d776d3`.
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`, `docs/realtime-agent.md`.
- Behavioural delta: VAD commits during compaction are queued after compaction, and `/rt` remains active without requiring command re-entry.

## Operator-takeaway

After update/reload, if VAD fires while Pi is compacting, the turn is delayed until the simple compaction is saved and then submitted automatically. If speaking during compact feels paused, that is expected; it should recover without `/rt` restart.
