# Editor status chips

`extensions/editor-chips.js` moves selected session/footer metadata into Pi's editor rails. It is independent of `piGraphics.mode`: it works with `/gfx off`, and when another extension has already installed a custom editor it wraps that editor and applies chips after the existing rail render.

## Configuration

Editor chips are immutable startup policy. Configure them in `settings.json` and reload Pi; there is no runtime setter and the extension never rewrites settings.

```json
{
  "agentUtils": {
    "editorChips": {
      "enabled": true,
      "topLeft": ["speech"],
      "topRight": ["model", "effort"],
      "topCenter": ["directory"],
      "bottomRight": ["mcp", "cost", "context"],
      "bottomLeft": ["meter"],
      "bottomCenter": ["branch", "diff"],
      "hideFooter": true,
      "hiddenStatuses": ["jev"]
    }
  }
}
```

Available fields are:

- `model` — provider and model.
- `effort` — active Pi thinking level.
- `mcp` — MCP count recovered from Pi's extension status data.
- `cost` — cumulative session cost, including nested usage-bearing entries.
- `context` — current context percentage and context-window size.
- `directory` — current working directory, with the home prefix rendered as `~`.
- `branch` — current Git branch.
- `diff` — tracked additions and deletions relative to `HEAD`.
- `speech` — `/ptt`, `/stt` and `/rt` microphone state: a grey dot when no voice mode is enabled, blue when armed/listening, red on air, amber while transcribing, green after a send. See [the speech indicator](realtime-agent.md#speech-indicator).
- `meter` — input level, dBFS and a `✎` transcription mark; present only while audio is being captured.

`cwd` aliases `directory`, `thinking` aliases `effort`, `stt`/`ptt`/`mic`/`recording` alias `speech`, and `volume`/`level`/`db` alias `meter`. Unknown and duplicate field names are ignored. `PI_EDITOR_CHIPS_ENABLED` can provide process-local startup enable/disable policy without changing the settings file.

`hideFooter` defaults to `true`. The extension replaces the ordinary footer because the configured values now live on the editor rails. Extension statuses not represented by the `mcp` chip remain visible on a residual footer line.

`hiddenStatuses` lists extension status keys to keep off that residual line (for example the third-party `jev` package's `jev: ready`). A hidden status that reports a failure (`unconfigured`, `error`, `failed`, `unavailable`, `invalid`, `blocked`, `denied`) is shown once as a warning notification instead.

## Theme behavior

Chip backgrounds are derived from the active Pi theme rather than terminal ANSI defaults:

- model: dark Nord provider segment followed by dark-Nord text on a light Nord-white model segment
- effort: a deliberately distinct semantic ramp — low blue, medium yellow, high orange, xhigh red, max pink (off/minimal remain subdued)
- MCP: magenta and dark Nord, separated with `▌`
- cost: one plain green chip, formatted as `$5.33` with no subscription suffix
- context: darkened `success` below 40%, darkened `warning` below 60%, full `warning` from 60% through 80%, and the high-contrast `text`/`error` pair above 80%
- diff: `success` additions and `error` deletions

Powerline rounded caps and transition dividers are painted with the adjacent chip backgrounds. Provider-to-model keeps the chevron transition; icon-to-label uses a rounded ``; balanced data pairs such as additions/deletions and context percent/window use `▌`. This gives continuity without making unrelated segment types look identical.

## Responsive layout

Configured `topLeft`, `topCenter` and `topRight` groups share the top rail. The bottom row places `bottomLeft`, `bottomCenter`, and `bottomRight` independently. `editorPaddingX` from Pi settings (or the same field inside `editorChips`) preserves that many visible rail cells at both the left and right edges.

When space is constrained, fitting proceeds deterministically:

1. Collapse directory components from left to right until each component reaches one character (for example `~/.cacophony/agents/agent-utils/...` becomes `~/./a/a/...`).
2. Drop the speech hint and the meter's dB label, but only on the row that carries them.
3. Collapse the branch chip to its Git icon.
4. Reduce the speech chip to its state glyph.
5. Remove inter-group rail gaps and allow deterministic overlap/clipping at the terminal boundary.

The renderer always applies Pi's ANSI-aware width clamp after composing the rails, so editor rows never exceed terminal width or corrupt cursor/focus behavior.

## Data refresh

Model, effort, context, cost, and MCP status are read at render time. Speech state arrives on Pi's per-session event bus (`agent-utils:speech-indicator.v1`); the chip claims it so realtime-agent skips its fallback line, and a mount-time request replays the current state after reloads. Meter-only updates are coalesced to ten per second. Git branch and tracked `HEAD` diff totals refresh at session start, after editing/shell tool execution, and at turn completion. Git probing is bounded and failures retain the last stable values.

## Host editor class

The chips decorate Pi's own `CustomEditor` instance, so they must use the
running Pi's class (it carries the app keybindings, abort, focus and
hardware-cursor behaviour). `extensions/editor-chips.js` gets it from
`extensions/lib/pi-host.js`, a two-line bridge whose **static** import of
`@earendil-works/pi-coding-agent` Pi's extension loader maps to Pi's own module
(the documented extension API; a dynamic `import()` is not mapped in Pi's
compiled build). There is no reflection over the live component tree, and the
class follows Pi updates. The behaviour lives in
`extensions/lib/editor-chips-extension.js`, which tests load with an injected
stand-in. `/editor-chips status` reports `CustomEditor=pi-host`.
