# Agent Utils, Paratenic, and the wider AHP surface

## Goal

Make Agent Utils a first-class producer and consumer of the useful Agent Host Protocol surface through the neutral Paratenic Pi adapter, without making Agent Utils depend on Paratenic or turning AG-UI/A2UI into competing authorities.

AHP remains authoritative for distributed session, chat, elicitation, terminal, resource, and attachment state. Pi remains authoritative for its running tool calls and local interaction promises. AG-UI is a derived event projection and A2UI is declarative presentation.

## Current state

### Elicitation

The current `interactive_choice` path supports one AHP `single-select` question with optional freeform input. Agent Utils publishes stable lifecycle snapshots on `pi.events`; the Paratenic extension maps them to backend protocol input events and AHP `chat/input*` plus session `inputNeeded`. AHP responses return through the same semantic input bus as keyboard, Omni, ring, and Cacophony.

Missing AHP question features:

- multi-select;
- boolean;
- text as a first-class question rather than a single-select escape hatch;
- number and integer validation;
- multiple questions in one elicitation;
- answer drafts and skipped optional questions;
- URL/review requests;
- explicit accept, decline, and cancel presentation.

### Images and attachments

The `/image-*` commands and `kitty_image_preview_*` tools are local terminal presentation. They do **not** currently create AHP image attachments or resources.

Tendril capture can send image content into Pi as a user message, but the current Paratenic extension flattens observed messages and tool results to text. Paratenic currently constructs AHP messages with `attachments: None`. Therefore an AHP/Culture observer may see descriptive text or a saved local path, but not a portable image attachment in the feed.

Local filesystem paths must not be projected to remote clients as if they were portable resources.

### Terminals

Paratenic implements the AHP 0.8 terminal surface:

- `createTerminal` and `disposeTerminal`;
- client and session claims;
- subscribable `TerminalState`;
- `terminal/input`, `terminal/data`, and `terminal/resized`;
- title, cwd, exit, clear, and shell command-detection actions;
- a real PTY-backed platform shell;
- Culture VT rendering and keyboard control.

Culture users can already create and control these terminals. Agent `bash` tool calls are ordinary tool calls and do not automatically become AHP terminals. Agent Utils currently exposes no agent-facing tool for creating, claiming, or writing an AHP terminal.

## Decisions

1. Keep `interactive_choice` as the small compatibility tool for common single-select decisions.
2. Add a generic `interactive_input` tool for the complete bounded AHP elicitation model.
3. Implement every local interaction through a transport-neutral form state machine and semantic event bus. Paratenic remains an adapter.
4. Represent portable images using AHP attachments backed by AHP resources, never kitty graphics state or raw local paths.
5. Keep ephemeral `bash` executions as tool calls. Create an AHP terminal only when an agent or user explicitly requests a persistent interactive shell.
6. Expose agent-initiated AHP operations through a narrow, capability-advertised local Paratenic control API or client library. Do not shell out to Culture and do not make the Pi backend impersonate an untracked AHP client.
7. Culture's cross-host inbox remains derived from `SessionState.inputNeeded`; do not add another choices database.

## Generic interactive input

### Tool shape

Add `interactive_input` alongside `interactive_choice`:

```ts
interactive_input({
  title?: string,
  message?: string,
  url?: string,
  questions: [
    {
      id: string,
      kind: "single-select" | "multi-select" | "boolean" |
            "text" | "number" | "integer",
      prompt: string,
      title?: string,
      required?: boolean,
      defaultValue?: unknown,
      options?: [{ id: string, label: string, description?: string, recommended?: boolean }],
      allowFreeform?: boolean,
      min?: number,
      max?: number,
      format?: string
    }
  ],
  timeoutMs?: number
})
```

Bounds must match the advertised adapter capability and remain conservative: at most 16 questions, 64 options per select question, 512-byte IDs, and bounded text/freeform values.

Return one normalized result:

```ts
{
  status: "accepted" | "declined" | "cancelled" | "timeout" | "error",
  answers: {
    [questionId]: {
      state: "submitted" | "skipped",
      kind: "selected" | "selected-many" | "boolean" | "text" | "number",
      value: unknown,
      freeformValues?: string[]
    }
  },
  source: "keyboard" | "omni" | "ring" | "cacophony" | "ahp" | string
}
```

### Compatibility wrapper

`interactive_choice` continues to accept its existing schema and maps internally to one required `single-select` question. Existing result details remain stable. Stop-confirmation remains an Agent Utils sub-flow and is emitted as an update/revision of the same runtime request.

Do not overload `interactive_choice` with a boolean `multiSelect` switch and increasingly unrelated result shapes. A separate generic tool preserves compatibility and makes AHP mapping direct.

### Local form state machine

Implement a reusable `InteractiveInputStateMachine` under `extensions/lib/`:

- ordered question focus;
- option focus independent of selected values;
- single-select replacement;
- multi-select toggle plus explicit submit;
- text editing;
- number/integer parsing and min/max validation;
- required/optional validation;
- skip optional question;
- accept, decline, cancel, and timeout;
- immutable complete snapshots with stable request/question/option IDs;
- exactly-once terminal settlement.

Keyboard defaults:

- Up/Down: navigate options or questions;
- Space: toggle a multi-select option;
- Enter: select single option, commit a field, or submit a valid form;
- Tab/Shift-Tab: next/previous question;
- `i`: edit text/freeform;
- Escape: return/cancel according to the existing no-leak policy;
- numeric shortcuts only when unambiguous in the focused question.

Omni/ring adapters need additive semantic actions rather than UI-specific events:

- select previous/next;
- question previous/next;
- toggle current;
- choose current/ID;
- submit form;
- decline/cancel;
- freeform update/submit.

### Adapter lifecycle

Add generic events while preserving choice aliases:

- `agent-utils:interactive-input-capability`;
- `agent-utils:interactive-input-sync-request`;
- `agent-utils:interactive-input-session` with started/updated/ended complete snapshots;
- `agent-utils:input-action` responses keyed by request ID and stable question/option IDs.

The Paratenic extension advertises exactly the question kinds supported by the loaded Agent Utils version. A response is acknowledged only after the runtime validates and admits it; final AHP settlement still waits for the runtime-authoritative ended event.

## Portable image and attachment projection

### Resource ownership

Add a bounded attachment publication contract between Pi extensions and Paratenic:

1. A producer publishes bytes or a readable file handle to an owner-private Paratenic adapter operation.
2. Paratenic imports/copies the content into its confined resource store before acknowledging publication.
3. It returns an opaque AHP resource URI, media type, size, and optional dimensions.
4. The Pi adapter emits a rich message/response attachment referencing that URI.
5. AHP clients retrieve bytes through `resourceRead` with normal authorization and bounds.
6. Retention follows the owning turn/session policy; deleting a local screenshot later cannot break an acknowledged attachment.

Never expose `file:///Users/...` or remote Tendril source paths directly. Never inline unbounded base64 into backend event frames or persisted chat state.

### Message mapping

Extend the neutral backend protocol from flattened text to ordered bounded content blocks:

- text;
- image/resource reference;
- document/resource reference;
- optional text selection/provenance;
- tool-result resource content where AHP supports it.

The Paratenic Pi extension should inspect Pi message content blocks and publish supported image blocks before emitting the corresponding user/assistant message. Unsupported blocks receive a visible bounded textual placeholder rather than disappearing silently.

### `/image-*` behavior

Keep gallery navigation, kitty placement, animation, and side-rail state local. Add an explicit share operation rather than making every preview globally visible:

- `kitty_image_preview_share_current` publishes the current image as an AHP attachment;
- optional `share: true` on still-image add/capture tools publishes once;
- gallery cycling and screenshot streams do not publish each frame by default;
- a stream may expose one replaceable live resource only after AHP resource-watch semantics and retention are defined.

Tendril one-shot capture/describe should use the same attachment publisher. Periodic Tendril ticks must skip while Pi is busy and must never queue unbounded follow-ups behind `interactive_choice`.

## Agent-accessible AHP terminals

### Existing user path

Culture and any conforming AHP client can already call `createTerminal`, subscribe to its channel, dispatch `terminal/input`/`terminal/resized`, and dispose it. A session claim associates the terminal with a Pi session and lets Culture surface it beside that session.

### Missing agent path

Add narrow model-callable tools only when a local Paratenic capability is registered:

- `ahp_terminal_create({ name, cwd, sessionClaim?, cols?, rows? })`;
- `ahp_terminal_write({ terminal, data, confirmed })`;
- `ahp_terminal_resize({ terminal, cols, rows })`;
- `ahp_terminal_snapshot({ terminal, maxBytes })`;
- `ahp_terminal_dispose({ terminal, confirmed })`.

Creation and reads may be safe by policy; writing commands and disposal require explicit confirmation because they create external side effects. Returned terminal IDs are host-qualified opaque AHP URIs.

### Control boundary

Do not implement these tools by invoking `culture control`; Culture may not be running and is not authoritative. Add an owner-private Paratenic local client/control endpoint or embed the official AHP client in the Pi adapter. It must:

- authenticate as a distinct client identity;
- preserve client sequence/idempotency receipts;
- use normal `createTerminal` and terminal actions;
- enforce that a session-claimed terminal targets the currently registered AHP session;
- never grant the model access to another client's terminal without policy;
- return indeterminate rather than replaying writes after connection loss.

A backend-originated request extension is acceptable only if Paratenic translates it into the same AHP command path with an explicit principal and idempotency identity. Do not mutate terminal state directly from backend frames.

### Shell tool distinction

Keep ordinary `bash` calls represented as AHP tool calls. They are finite, captured executions and should render as tool activity/result. Use an AHP terminal for persistent REPLs, watch processes, interactive debuggers, shells requiring incremental input, or processes the operator should take over in Culture.

## Wider AHP opportunities

Prioritize adapters in this order:

1. Complete elicitation through `interactive_input`.
2. Rich message attachments and confined resources.
3. Agent-accessible persistent terminals.
4. Tool confirmations and result confirmations using Pi's real confirmation hooks.
5. Changesets/file edits with previews rather than plain tool text.
6. Annotations and citations from tool/model output.
7. MCP side channels and client-contributed tools where ownership is explicit.
8. Telemetry/OTLP projection with content-safe defaults.
9. Multi-chat/subagent provenance for delegated workers.

For each surface, capability advertisement must follow—not precede—an end-to-end implementation and conformance test.

## Delivery phases

### Phase 1: safety and foundation

- Prevent periodic Tendril frames from queuing while a modal or turn is active.
- Add tests proving busy and overlapping ticks are skipped.
- Document current image and terminal visibility accurately.
- Define generic input event schemas and stable result compatibility.

### Phase 2: complete elicitation

- Implement `InteractiveInputStateMachine` and `interactive_input`.
- Add TUI form rendering and typed RPC fallback.
- Extend Omni/ring semantic actions for toggle/question navigation/submit.
- Extend the Paratenic Pi adapter from single-select-only to all supported kinds.
- Add AHP round trips for every question/answer kind, multi-question forms, drafts if available, cancellation, timeout, reconnect, and cross-surface races.

### Phase 3: attachments

- Implement confined resource import and rich backend content blocks in Paratenic.
- Add explicit image sharing from Agent Utils.
- Render and retrieve attachments in Culture desktop/Android clients.
- Test authorization, restart durability, size limits, deletion, and remote-host routing.

### Phase 4: terminals

- Add the authenticated local AHP control boundary.
- Add agent-facing terminal tools with confirmation and idempotency.
- Test creation, session claim, Culture takeover, resize, command detection, disconnect, indeterminate writes, process exit, and disposal.

### Phase 5: remaining AHP surfaces

Deliver confirmations, changesets, annotations, client tools, telemetry, and multi-chat incrementally with one source of truth and explicit capability gates.

## Acceptance criteria

- Existing `interactive_choice` callers and result shapes remain compatible.
- A mixed multi-question request is visible and answerable in local TUI and Culture.
- Multi-select requires explicit submit and never resolves on the first toggle.
- Keyboard, Omni, ring, Cacophony, timeout, and AHP still have one deterministic winner.
- Stop confirmation remains a replace-in-place sub-flow with no two actionable inbox rows.
- A shared image is readable from a remote Culture client after the source file is deleted.
- An unshared kitty preview never appears in AHP state.
- Repeated stream frames cannot accumulate behind a blocking choice.
- An agent-created terminal appears under the correct host/session in Culture and accepts normal AHP terminal input.
- Lost acknowledgement of terminal input is reported indeterminate and is never blindly replayed.
- Routine logs contain no image bytes, freeform answers, terminal input, auth tokens, or private local paths.
