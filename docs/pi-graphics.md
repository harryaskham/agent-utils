# Pi graphics theme + extension

This package ships a **Pi theme** plus a **Pi extension** that together let
agents draw freeform, kitty-graphics-backed UI affordances inside a
Pi-coding-agent session.

The pieces:

| File | Role |
|------|------|
| `themes/kitty-graphics.json` | Nord-flavoured color theme registered through `pi.themes` in `package.json`. |
| `extensions/pi-graphics.js` | Pi extension entry point (registers tools + slash commands). |
| `extensions/pi-graphics/affordances.js` | High-level renderers: prompt enclosure rules, gradient borders, accent bars. |
| `extensions/pi-graphics/png-renderer.js` | Tiny dependency-free RGBA → PNG encoder used by the affordance renderers. |
| `extensions/pi-graphics/runtime.js` | Pi-runtime-agnostic placement helpers (kept testable without `@sinclair/typebox`). |

## Installation

Install agent-utils as a Pi package per the repo README. Pi auto-discovers
themes via the `pi.themes` entry in [`package.json`](../package.json) and
extensions via `pi.extensions`.

To activate the theme:

```bash
pi /settings   # then choose "kitty-graphics"
# or, equivalently, in settings.json:
# { "theme": "kitty-graphics" }
```

The companion extension (`./extensions/pi-graphics.js`) is loaded
automatically by Pi when the package is installed; no further setup is
required.

## How the extension cooperates with the theme

The theme controls Pi's existing color tokens (borders, message backgrounds,
markdown styles, etc.). The extension complements those flat colors with
graphical affordances:

* **Prompt enclosure rules** — a kitty-graphics gradient strip that can
  replace plain ASCII separators like `--------------------`.
* **Translucent gradient borders** — a graphical frame that can be wrapped
  around tables, agent messages, or code blocks.
* **Accent bars** — single-cell-tall accent strips suitable for highlighting
  table rows or section headers.

Each rendered affordance is transmitted as an in-memory PNG via
`buildPngVirtualPlacementCommand` (see `extensions/kitty-graphics.js`) and
displayed using kitty Unicode placeholder cells, so:

* Placement does not move the real terminal cursor (Pi's differential
  redraw remains intact).
* Placement is tmux-safe — escape sequences are wrapped in tmux DCS
  passthrough automatically.
* All image ids are tracked in extension-owned state and freed via
  `buildScopedDeleteCommand`. The extension never issues a global
  "delete all images" command. This keeps it cooperative with bd-f89780's
  scoped image ownership work.

## Tools

The extension registers three tools through `pi.registerTool`:

* `pi_graphics_render_prompt_enclosure` — render a graphical separator.
* `pi_graphics_render_message_border` — render a gradient frame sized in
  cells.
* `pi_graphics_clear` — release every kitty image owned by the extension.

And two slash commands:

* `/pi-graphics-status` — report how many images are owned and whether
  Unicode placeholder placement is currently active.
* `/pi-graphics-demo` — print a sample rule and border into the active UI.

## Example

```
> pi_graphics_render_prompt_enclosure({ columns: 60, leftColor: "#5e81ac", rightColor: "#88c0d0" })
```

The returned tool output text contains both the kitty-graphics transmit
sequence (an APC escape) and the Unicode placeholder cells that anchor it
into the line.

## Falling back outside kitty/tmux

If the active terminal does not support Unicode placeholder placement, the
extension reports a textual fallback (e.g. `pi-graphics: Unicode placeholder
placement is not active in this terminal; falling back to plain '─' rule.`)
instead of emitting raw escape sequences. This keeps tool output readable in
non-graphical terminals.

## Testing

```bash
npm test
```

The test suite under `test/pi-graphics.test.js` covers PNG byte output,
canvas drawing primitives, affordance footprints, kitty graphics command
generation, package manifest discovery, and theme schema completeness.
