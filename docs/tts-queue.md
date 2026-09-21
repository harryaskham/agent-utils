# Machine-global TTS queue

Agent Utils serializes PCM playback across Pi sessions on one machine without a
daemon. Synthesized audio and small metadata records are spooled under
`$PI_TTS_QUEUE_DIR` or `~/.cache/agent-utils/tts-queue`; atomic directory locks
coordinate independent Pi processes.

The default policy is one active playback with a two-second early overlap.
Speech synthesis and agent work remain asynchronous while playback waits. Any
live Pi session can claim queued jobs, so a job survives its originating session
exiting as long as another Agent Utils session is running.

For PCM, only automatic `/tts` and `/narrate` playback opts into the queue by default.
Azure `/read`, spoken choices, and direct realtime reply playback remain immediate and
interruptible without entering the machine queue. Environment objects and
credentials are never serialized; metadata contains only playback routing such
as backend, sink, pan, and stream name.

Local command playback from `/tts`, `/narrate`, and `/read` also uses queue
slots when this extension is loaded. It needs no audio buffer: a scheduling
record reserves capacity until the command exits. Duration is unknown, so these
jobs cannot trigger timed end-of-speech overlap. Commands, utterances, and their
environment stay in memory; only the originating session can execute them, and
they do not survive its exit. Skip/cancel terminates the command process group.
Reload all queue workers after updating from a PCM-only version. For direct
playback with no spool, load only the speech extensions, not `tts-queue.js`.
See [local command configuration](tts-narration.md#local-command-playback).

## User control

```text
/tts-queue status
/tts-queue skip
/tts-queue next
/tts-queue clear
/tts-queue parallel=2
/tts-queue overlap=2
```

`skip` marks the oldest active job for cancellation; its worker polls the marker
and advances the queue. `next` prompts immediate scheduling. `clear` removes
waiting jobs without interrupting active speech. `parallel` allows 1–8 active
jobs. `overlap` is seconds, capped at 30: one additional job may begin when an
active job is within that interval of its estimated end.

Configuration is machine-global and persists in `config.json` beneath the queue
root. It therefore applies consistently to later Pi sessions.

## Disk budget

The queue is a playback spool, not an archive of speech that has already played.
Its regular spool files under `jobs/` and `active/` have a **1 GiB (1,073,741,824 bytes)** ceiling, including PCM audio and job metadata.
The tiny root configuration and lock files are separate from that budget.

- Cleanup runs asynchronously at startup, on cancellation, periodically while running, and before publishing new audio.
- Cancelled jobs are reclaimed even when all playback slots are busy.
  Stale partial/orphaned queue files are also removed; an interrupted claim with surviving job metadata is recovered instead of discarded.
- If space is still needed, the oldest waiting jobs are evicted first.
  Their callers receive an interrupted/dropped result with `reason: "storage_limit"`, not a successful playback receipt.
- Active speech is never evicted or interrupted to make room.
  If a pre-existing active spool alone exceeds the limit, new admissions are refused until it drains; the status details report the over-limit state.
- A single clip plus metadata that exceeds the cap is rejected without writing its payload.
  Waiting in-memory admissions are bounded as well.
- Byte checks, eviction and publication share the machine lock, so independent updated Pi processes cannot each admit against the same free space.
  Unknown files and symlink targets are never garbage-collected.

`tts_queue_status` details include `storage.bytes`, `storage.maxBytes`, `storage.checkedAt`, and `storage.overLimit`.
Usage is the most recent maintenance/admission snapshot for that worker; `null` means it has not scanned yet.
Bulk cleanup uses asynchronous filesystem operations rather than blocking the Pi event loop while removing a large legacy backlog.
Cancellation receipts are reclaimed after the originating waiter acknowledges them, its process exits, or their 24-hour retention expires.

After updating Agent Utils, reload or restart each Pi session using the queue.
Already-running older versions retain their old writer behavior; installing source alone does not enforce the cap in those processes.

## Agent tools

Agent-facing controls are disabled by default to keep the normal tool surface
small. Set `PI_TTS_QUEUE_AGENT_TOOLS=1` before starting Pi to register:

- `tts_queue_status`
- `tts_queue_configure({ maxParallel?, overlapMs? })`
- `tts_queue_control({ action: "skip" | "next" | "clear", confirmed? })`

Clearing through the agent tool requires `confirmed=true`; status, skip, next,
and bounded policy changes do not.

## Failure and cleanup

Queue metadata and PCM files are owner-only.
Playback claims, maintenance and admission checks run under an atomic `mkdir` mutex, held until asynchronous storage work completes.
A dead owner can be recovered; an abandoned directory with no valid owner is recoverable after a five-second initialization grace period.
A live owner's lock is not stolen merely because cleanup takes longer than five seconds, and release checks the lease token.

This ownerless-directory recovery matters after a crash between lock creation and owner publication: earlier versions could leave all future playback and cleanup blocked indefinitely.
Dead active workers are recovered through the existing replay path; normal completion removes their spool files.
Output processes remain interruptible through the existing playback backend.
Cross-machine coordination remains out of scope.
