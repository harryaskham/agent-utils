# Endless agent resume mode

`/endless` keeps a Pi agent running after it would otherwise stop. It listens to
Pi's `agent_settled` event—not the earlier `agent_end` event—so automatic retries,
auto-compaction retries, tool execution, and queued follow-ups finish before a
resume is scheduled.

```text
/endless keep going
/endless delay=60 keep going
/endless compact=true delay=60 continue the current goals
/endless status
/endless off
```

Flags may appear anywhere in the command. Remaining words form the resume
message. A bare `/endless` uses the configured default message.

## Settings

```json
{
  "agentUtils": {
    "endless": {
      "defaultMessage": "You are in endless mode; stopping is disabled",
      "delay": 60
    }
  }
}
```

Precedence is environment over settings over built-in defaults:

- `PI_ENDLESS_DEFAULT_MESSAGE`
- `PI_ENDLESS_DELAY`

`delay` is measured in seconds and may be `0` through `86400`. The command's
`delay=` value overrides the startup default for the current endless run.
Enabling and disabling endless mode is runtime-only; it does not rewrite
settings.

## Compaction ordering

With `compact=true`, the delay expires first and then the extension calls Pi's
documented `ctx.compact()` API. The resume user message is sent only from the
compaction `onComplete` callback. If compaction is unavailable or fails, a warning
is shown and the resume is delivered without compaction rather than silently
stranding endless mode.

Only one resume timer or compaction can be active. Repeated `agent_settled`
events are deduplicated, `/endless off` cancels pending timers and invalidates
compaction callbacks, and session shutdown clears all runtime state.
