# Delayed Pi delivery with `/after`

`extensions/after.js` schedules a one-shot prompt or slash command inside the current Pi session without using system cron, `at`, shell background jobs, or daemon-global scheduling.

## Usage

```text
/after 10m Check the deployment and summarize failures.
/after 120s /compact
/after 2h /choice Continue? | Yes | Stop
/after status
/after cancel after-mabc1234-deadbeef
/after cancel all
```

Durations accept `ms`, `s`, `m`, and `h`, may be fractional, must be at least 10 milliseconds, and are bounded to 30 days.

Ordinary payloads are delivered as follow-up user messages. Payloads beginning with `/` opt into Pi's extension-command, skill-command, and prompt-template expansion. `/compact` is handled directly through Pi's compaction API because built-in commands do not pass through extension command dispatch; optional text after `/compact` becomes custom compaction instructions.

## Persistence and delivery fence

Each timer writes a session custom entry containing a stable ID, wall-clock due time, payload, and status. Reload/restart reconstructs the latest state for each ID and re-arms scheduled timers. An overdue timer runs promptly.

Immediately before dispatch, the extension appends a durable `delivering` fence. Restart recovery never replays a timer in that indeterminate state, preventing duplicate commands or prompts. Successful delivery appends `delivered`; cancellation appends `cancelled`; synchronous dispatch failure appends `failed`.

This gives at-most-once restart behavior. A process crash in the very small interval after the `delivering` fence but before dispatch is retained as an explicit indeterminate receipt rather than risking duplicate operator intent.

Runtime timeout handles are cleared during session shutdown. Durable scheduled intent remains in the session and is restored by the replacement extension instance.
