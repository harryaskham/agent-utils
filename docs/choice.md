# Multi-input spoken choices

Agent Utils provides a generic interactive choice surface plus independent input
adapters:

- [`extensions/choice.js`](../extensions/choice.js) owns question/choice state,
  timeout, TTS, terminal controls, the visible widget, and the
  `interactive_choice` tool / `/choice` command.
- [`extensions/ring-input.js`](../extensions/ring-input.js) is an optional Finger
  One adapter. It reads the already-daemonised ring event source with bounded
  `ring get`; it never starts `ring daemon`, scans BLE, enables a ring, or owns a
  hardware connection.

The split uses Pi's built-in inter-extension event bus (`pi.events`). Future input
modules can participate without importing either implementation.

## Generic input event contract

Input adapters emit `agent-utils:input-action` with one semantic action. The
bus is deliberately generic rather than ring- or choice-owned, so future Pi
controls can consume the same input modules:

| Action | Meaning |
| --- | --- |
| `select-prev` | Highlight the previous option. |
| `select-next` | Highlight the next option. |
| `choose-current` | Confirm the highlighted option. |
| `choose-index` | Confirm zero-based `index` directly. |
| `cancel` | Cancel without selecting. |

Payloads may include `source`, `raw`, and the active `sessionId`. A mismatched
`sessionId` is ignored. The choice extension emits
`agent-utils:choice-session` with `status: started|ended` so adapters attach only
while needed and release resources immediately afterward.

## Keyboard input

While a choice is visible:

- **Up** or **k** — previous
- **Down** or **j** — next
- **Enter** — choose the highlighted option
- **1–9** — choose that one-indexed option directly
- **Escape**, **q**, or **Ctrl-C** — cancel

Navigation wraps by default; `wrap: false` clamps at the ends. Choices are capped
at nine so direct numeric selection is unambiguous. Immutable startup defaults
live under `agentUtils.choice`:

```json
{
  "agentUtils": {
    "choice": {
      "timeoutMs": 30000,
      "wrap": true,
      "maxChoices": 9,
      "speechEnabled": true,
      "descriptionOnNavigate": true,
      "prefix": "",
      "suffix": "",
      "repeat": {
        "interval": 300,
        "limit": null
      },
      "append": [
        {
          "title": "Generate more options",
          "description": "Present a different set of choices for the same question",
          "tts": false,
          "cacophonyAction": "freeformReply"
        },
        {
          "title": "Stop Choices",
          "description": "Stop here without choosing an item",
          "terminal": true,
          "tts": false,
          "cacophonyAction": "discard"
        }
      ],
      "forceAtAgentEnd": true
    }
  }
}
```

`settings.json` is startup policy and is never rewritten by `/choice`,
`/force-choice`, or `/ring-input`. Their setters and toggles affect only the
current session; edit the JSON explicitly to change the next startup.

`agentUtils.choice.append` adds the same configured control rows after every
agent-provided choice list without mutating that list or shifting its indices.
Each row requires `title` and a supported `cacophonyAction` (`freeformReply` or
`discard`); `description` is optional visible detail. `tts:false` keeps the row
visible while excluding it from the initial announcement, repeats, and
navigation speech. Selecting a non-terminal appended row returns a distinct
`status: action` tool result with its `cacophonyAction`, rather than pretending
it was an ordinary answer. `terminal:true` ends the choice with a terminating
non-selection result; a terminal `discard` also disables runtime force-choice
for the current session. Appended action metadata is copied into the mirrored
Cacophony choice, and local/mobile races still settle the exact durable choice
only once. Invalid append rows are ignored. The combined visible list remains
subject to `maxChoices` (and the numeric-selection maximum of nine).

Pending choices re-read the complete spoken introduction every
`repeat.interval` seconds (default `300`). `repeat.limit` is the maximum number
of re-reads after the initial announcement; its default `null` is unlimited and
`0` disables repeats. `/choice settings repeat.interval=60 repeat.limit=3`
overrides them for the current session; `repeat.limit=null` restores unlimited
runtime repeats. Environment overrides are `PI_CHOICE_REPEAT_INTERVAL` and
`PI_CHOICE_REPEAT_LIMIT`.

Set startup `timeoutMs` to `0` (or run `/choice settings timeout=0` for this
session) to disable automatic choice timeout entirely. A startup zero is an
operator policy: it also
ignores a model-generated per-call `timeoutMs: 30000` argument. Escape, explicit cancellation, session
shutdown, or a selection still terminates the choice normally. The ring adapter
keeps listening indefinitely by renewing its bounded `ring get` smart client
every five minutes while that no-timeout choice remains active; navigation can
continue for any number of gestures before selection.

By default, moving the highlight speaks both the option headline and its
`summary` description. Set `/choice settings descriptions=false`,
`agentUtils.choice.descriptionOnNavigate=false`, or
`PI_CHOICE_DESCRIPTION_ON_NAVIGATE=0` to restore headline-only navigation; the
initial spoken option list still includes descriptions in either mode.

Choice speech resolves the same `agentUtils.tts` voice, embedding, language,
speed, style, endpoint, backend, server, and device used by `/read`, `/tts`, and
the `speak` tool. `agentUtils.choice.prefix` and `suffix` wrap only the initial
question; option headlines and navigation speech remain unmodified. Set them with
`/choice settings prefix="$AGENT_ID: " suffix=" please"`, override them per
`interactive_choice` call with `prefix`/`suffix`, or use `PI_CHOICE_PREFIX` and
`PI_CHOICE_SUFFIX`. Safe `$VAR`/`${VAR}` expansion is supported without command
substitution. `PI_CHOICE_*` / `PI_TTS_*` / Pulse env overrides still win.

## Cacophony/mobile mirroring

Managed Cacophony agents automatically mirror every Pi `interactive_choice` into
Cacophony when both `CACO_AGENT_ID` (or `CACOPHONY_AGENT`) and `CACO_PROJECT`
(or `CACOPHONY_PROJECT`) are present. Pi remains the modal and speech owner; the
Cacophony copy uses `notifyMode: direct-message`, so it is visible to durable
mobile/operator surfaces without speaking the question a second time.

Resolution is bidirectional:

- a mobile/Cacophony selection resolves the open Pi modal at the same index;
- a Pi keyboard, ring, or adapter selection resolves the durable Cacophony copy;
- Pi cancellation, timeout, supersession, abort, or shutdown discards the durable
  copy rather than leaving a stale operator choice.

The bridge presents asynchronously and polls only its exact choice ID with
bounded non-overlapping calls, so a missing/backpressured daemon never blocks the
Pi choice. Presentation and resolution races are idempotent. Startup policy lives
under `agentUtils.choice.cacophony`:

```json
{
  "enabled": true,
  "pollMs": 2000,
  "notifyMode": "direct-message"
}
```

`PI_CHOICE_CACO_ENABLED`, `PI_CHOICE_CACO_POLL_MS`, and
`PI_CHOICE_CACO_NOTIFY_MODE` override these values for the process. Setting
`enabled: false` opts a managed agent out.

## Continuous control with `/force-choice`

```text
/force-choice on
/force-choice status
/force-choice off
```

When enabled, the extension waits for Pi's `agent_end` event—the point after all
tools and the final assistant message, where the agent would otherwise stop—and
injects one tagged custom control message with `deliverAs: followUp` and
`triggerTurn: true`. It requires the next run to call `interactive_choice` with
2–5 concrete next actions, allowing continuous keyboard/ring control.

The request is deduplicated: if the next run fails to present a choice, the
extension warns and does not inject repeatedly. Presenting a real choice satisfies
and rearms it for the next agent end. A selected option labelled exactly `Stop
continuous choices` (also simple `stop`, `idle`, `pause`, or `finish`) disables
the mode for the current session, so continuous operation can itself be ended
from the ring. Durable configuration is `agentUtils.choice.forceAtAgentEnd` or
`PI_FORCE_CHOICE` (env wins), and defines startup behavior only. Runtime
`/force-choice on|off`, `/choice settings force=...`, Stop selections, and Escape
never rewrite that startup policy.

The TUI implementation is a true `ctx.ui.custom` modal, not a below-editor
widget: it owns focus, captures arrow sequences before the editor, and swallows
unmapped typing. Numbers and the selected item use accent styling, while summaries,
controls, timeout state, and the border use distinct theme colors.

Under `/force-choice`, **q**, **Q**, and Escape are hard stops: they disable force
mode for the current session without changing its startup setting, resolve the
choice immediately, and return a terminating final tool result so Pi skips the
automatic follow-up model call and the agent actually ends. `q`/`Q` are the
reliable terminal fallback when Escape is intercepted or encoded by the active
terminal protocol; common Kitty CSI-u Escape and q encodings are recognized too.
Outside force mode, Escape is the freeform escape hatch: it invalidates the visible choice, consumes
only the Escape key, leaves the editor untouched, stops input adapters/TTS, and
removes terminal interception. Crucially, Escape alone does **not** resolve the
pending tool or resume the agent. The choice waits silently until the user submits
the next ordinary freeform editor message; that input stays on Pi's normal path,
then the old choice resolves as cancelled.

## Omni and direct-ring input adapters

`agentUtils.choice.inputSource` selects `"auto"` (default), `"omni"`, or
`"ring"`. In auto mode, [`extensions/omni-input.js`](../extensions/omni-input.js)
runs `omni listen --daemon 127.0.0.1:8766` as a subscriber to the always-on
local Omni daemon only while a choice is active. The daemon exclusively owns the
single Helsinki relay registration, local injection, and fan-out to unlimited
app subscribers; Agent Utils starts no daemon, listener, or relay registration. Semantic cast events and generic
Omni `InjectionCommand` key/scroll events map onto the same
`agent-utils:input-action` bus as keyboard input. If `omni tail` is unavailable
or exits, the direct ring adapter becomes the fallback for that choice; when
Omni is listening, no `ring get` process runs, avoiding its idle CPU cost.

Startup configuration:

```json
{
  "agentUtils": {
    "choice": { "inputSource": "auto" },
    "omniInput": {
      "enabled": true,
      "command": "omni",
      "daemon": "127.0.0.1:8766"
    }
  }
}
```

The optional local-daemon token remains in `OMNI_RELAY_TOKEN`; it is inherited
by the smart client and never placed in argv or settings. Use
`PI_CHOICE_INPUT_SOURCE=omni|ring|auto`, `PI_OMNI_CHOICE_ENABLED`,
`PI_OMNI_DAEMON`, or `PI_OMNI_COMMAND` for process overrides. `/omni-input status` reports the active
subscription. The direct ring adapter remains available as an explicit source
or auto fallback.

The direct adapter maintains **at most one** smart-client child per Pi process
while any direct-ring choices are active:

```text
ring get --events <configured-events> --count 100000 \
  --timeout-ms 300000 --after now --format json
```

Choice sessions are multiplexed in memory and routed by session ID and optional
ring name. Starting a replacement or simultaneous choice reuses the existing
child instead of multiplying polling clients. `--after now` prevents historical
gestures selecting a fresh question. The bounded five-minute transport renews
only while a routed choice remains; ending the final choice terminates it.
Teardown is idempotent and escalates from `SIGTERM` to `SIGKILL` after a short
grace period, so a wedged CLI cannot survive selection, cancellation, timeout,
or session shutdown. The external daemon and ring connection remain untouched.
A disconnected ring therefore causes no special lifecycle work: keyboard input
remains available and the bounded client quietly times out or is stopped when
the choice ends.

Default semantic mappings:

| Choice action | Ring events |
| --- | --- |
| `select-prev` | `EVENT_RING_CCW`, `scroll-up`, `previous`, `prev`, `left` |
| `select-next` | `EVENT_RING_CW`, `scroll-down`, `next`, `right` |
| `choose-current` | `EVENT_RING_SELECT`, `yes`, `select`, `confirm` |
| `cancel` | `EVENT_RING_CANCEL`, `no`, `cancel`, `back` |

Event names are normalized case-insensitively with `_` and `-` treated alike.
Override comma-separated mappings with:

- `PI_RING_CHOICE_PREVIOUS_EVENTS`
- `PI_RING_CHOICE_NEXT_EVENTS`
- `PI_RING_CHOICE_SELECT_EVENTS`
- `PI_RING_CHOICE_CANCEL_EVENTS`

Durable defaults live under `agentUtils.ringInput`:

```json
{
  "agentUtils": {
    "ringInput": {
      "enabled": true,
      "command": "ring",
      "previousEvents": ["EVENT_RING_CCW", "scroll-up", "previous", "prev", "left"],
      "nextEvents": ["EVENT_RING_CW", "scroll-down", "next", "right"],
      "selectEvents": ["EVENT_RING_SELECT", "yes", "select", "confirm"],
      "cancelEvents": ["EVENT_RING_CANCEL", "no", "cancel", "back"]
    }
  }
}
```

Optional `ring` filters one configured ring. Environment variables
`PI_RING_CHOICE_ENABLED`, `PI_RING_CHOICE_RING`, `PI_RING_COMMAND`, and the
`PI_RING_CHOICE_*_EVENTS` mapping variables override settings.

Use `/ring-input status`, `/ring-input mappings`, `/ring-input on`,
`/ring-input off`, or `/ring-input settings key=value` for runtime-only
inspection/control. Status includes active connection and routed-session counts,
which should never report more than one direct connection in a Pi process.
Commands never rewrite `agentUtils.ringInput`; edit the file explicitly to
change startup behavior.

## Calling choices

Agents use the `interactive_choice` tool with a question and two to nine
`{label, headline?, summary?, value?}` rows. The question and numbered options are
spoken through the shared direct TTS library; navigating speaks the newly
highlighted headline. TTS failures are warnings only and never break keyboard or
adapter input.

For a manual smoke test:

```text
/choice Pick a mode | Fast | Thorough | Cancel
```
