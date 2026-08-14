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
at nine so direct numeric selection is unambiguous.

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

Other settings:

- `PI_RING_CHOICE_ENABLED=0` disables the adapter while retaining keyboard choices.
- `PI_RING_CHOICE_RING=<name>` filters events to one configured ring.
- `PI_RING_COMMAND=<path>` overrides the smart-client executable.

Use `/ring-input status`, `/ring-input mappings`, `/ring-input on`, and
`/ring-input off` for runtime inspection/control.

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
