# Machine-global TTS queue

Agent Utils serializes PCM playback across Pi sessions on one machine without a
daemon. Synthesized audio and small metadata records are spooled under
`$PI_TTS_QUEUE_DIR` or `~/.cache/agent-utils/tts-queue`; atomic directory locks
coordinate independent Pi processes.

The default policy is one active playback with a two-second early overlap.
Speech synthesis and agent work remain asynchronous while playback waits. Any
live Pi session can claim queued jobs, so a job survives its originating session
exiting as long as another Agent Utils session is running.

Only automatic `/tts` and `/narrate` playback opts into the queue by default.
`/read`, spoken choices, and direct realtime reply playback remain immediate and
interruptible without entering the machine queue. Environment objects and
credentials are never serialized; metadata contains only playback routing such
as backend, sink, pan, and stream name.

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

## Agent tools

Agent-facing controls are disabled by default to keep the normal tool surface
small. Set `PI_TTS_QUEUE_AGENT_TOOLS=1` before starting Pi to register:

- `tts_queue_status`
- `tts_queue_configure({ maxParallel?, overlapMs? })`
- `tts_queue_control({ action: "skip" | "next" | "clear", confirmed? })`

Clearing through the agent tool requires `confirmed=true`; status, skip, next,
and bounded policy changes do not.

## Failure and cleanup

Queue metadata and PCM files are owner-only. Playback claims and capacity checks
run under an atomic `mkdir` mutex. A dead lock owner or lock older than five
seconds is recovered, and active leases whose worker PID no longer exists are
removed. Output processes remain interruptible through the existing playback
backend. Cross-machine coordination is intentionally out of scope for this
first version.
