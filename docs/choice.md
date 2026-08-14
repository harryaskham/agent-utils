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
at nine so direct numeric selection is unambiguous. Durable defaults live under
`agentUtils.choice` and can be changed with `/choice settings timeout=30000
wrap=true max=9 speech=true`:

```json
{
  "agentUtils": {
    "choice": {
      "timeoutMs": 30000,
      "wrap": true,
      "maxChoices": 9,
      "speechEnabled": true
    }
  }
}
```

Choice speech resolves the same `agentUtils.tts` voice, embedding, language,
speed, style, endpoint, backend, server, and device used by `/read`, `/tts`, and
the `speak` tool. `PI_CHOICE_*` / `PI_TTS_*` / Pulse env overrides still win.

Escape is the freeform escape hatch: it invalidates the visible choice, consumes
only the Escape key, leaves the editor untouched, stops input adapters/TTS, and
removes terminal interception. Crucially, Escape alone does **not** resolve the
pending tool or resume the agent. The choice waits silently until the user submits
the next ordinary freeform editor message; that input stays on Pi's normal path,
then the old choice resolves as cancelled.

## Ring input adapter

The adapter starts this smart client for each active choice:

```text
ring get --events <configured-events> --count 100000 \
  --timeout-ms <choice-timeout> --after now --format json
```

`--after now` prevents historical gestures selecting a fresh question. Choice
completion/cancellation terminates the `ring get` client; the external daemon and
ring connection remain untouched. A disconnected ring therefore causes no
special lifecycle work: keyboard input remains available and the bounded client
quietly times out or is stopped when the choice ends.

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
`/ring-input off`, or `/ring-input settings key=value` for durable runtime
inspection/control.

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
