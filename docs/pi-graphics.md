# Pi graphics theme + extension

This package ships a **Pi theme** plus a **Pi extension** that together let
agents draw freeform, kitty-graphics-backed UI affordances inside a
Pi-coding-agent session.

The pieces:

| File | Role |
|------|------|
| `themes/kitty-graphics.json` | High-contrast deep-Nordic color theme registered through `pi.themes` in `package.json`. |
| `extensions/pi-graphics.js` | Pi extension entry point (registers tools + slash commands). |
| `extensions/pi-graphics/affordances.js` | High-level renderers: prompt enclosure rules, gradient borders, accent bars, and glow panels. |
| `extensions/pi-graphics/components.js` | TypeScript-side TUI component mirror: graphical card frames, rails, status chips, skeleton rows, pulse waveforms, and cache keys. |
| `extensions/pi-graphics/auto-widget.js` | Startup-visible APNG pulse widget helpers and opt-out detection. |
| `extensions/pi-graphics/png-renderer.js` | Tiny dependency-free RGBA → PNG/APNG encoder used by the affordance renderers. |
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
required. By default it also shows a small animated kitty pulse widget above
the editor on session start so graphical mode is visible without manually
running a demo command. During normal turns the same widget changes tone/caption
for prompt capture, agent thinking, tool execution, and ready states, giving
regular conversation flow graphical chrome instead of a static startup-only
banner. Set `PI_GRAPHICS_AUTO_WIDGET=0` (or `PI_KITTY_GRAPHICS_AUTO_WIDGET=off`)
to opt out.

## How the extension cooperates with the theme

The theme controls Pi's existing color tokens (borders, message backgrounds,
markdown styles, etc.). It intentionally uses near-black void backgrounds plus
neon cyan, violet, aurora, and acid-green accents so ordinary Pi widgets are
visibly displaced from the built-in `dark` theme even before any kitty image is
rendered. The extension complements those flat colors with graphical affordances:

* **Prompt enclosure rules** — a kitty-graphics gradient strip with a soft
  cyan/violet halo that can replace plain ASCII separators like
  `--------------------`.
* **Translucent gradient borders** — a graphical frame that can be wrapped
  around tables, agent messages, or code blocks.
* **Nordic glow panels** — a full-cell rendered component with deep-blue fill,
  cyan/violet aurora glows, bright corner ticks, scanlines, and a normalized
  `phase` input for efficient pulse animation.
* **Graphical TUI component frames** — a TypeScript mirror of Pi/Caco-style
  component chrome: left activity rails, title strips, status chips, content
  skeleton rows, bottom pulse waveforms, scanlines, tone palettes, and stable
  layout cache keys that deliberately exclude animation phase.
* **Animated APNG pulses** — multiple TUI component phases packaged into one
  kitty-compatible animated PNG, so a continuously glowing/pulsing component
  can be uploaded once instead of re-sending a stream of static frames.
* **Accent bars** — single-cell-tall accent strips suitable for highlighting
  table rows or section headers.

Each rendered affordance is transmitted as an in-memory PNG/APNG via
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

The extension registers six tools through `pi.registerTool`:

* `pi_graphics_render_prompt_enclosure` — render a graphical separator.
* `pi_graphics_render_message_border` — render a gradient frame sized in
  cells.
* `pi_graphics_render_glow_panel` — render a high-tech Nordic glow panel sized
  in cells, optionally at a specific pulse phase.
* `pi_graphics_render_tui_component` — render a high-tech graphical TUI card
  frame, with optional tone/density/phase/caption controls.
* `pi_graphics_render_tui_pulse` — render a looping APNG version of the TUI
  component for efficient continuous pulse animation.
* `pi_graphics_render_contact_sheet` — render a static visual regression sheet
  covering tones and pulse phases for human inspection.
* `pi_graphics_clear` — release every kitty image owned by the extension.

And four slash commands:

* `/pi-graphics-status` — report how many images are owned, whether Unicode
  placeholder placement is active, and whether the automatic pulse is enabled.
* `/pi-graphics-show` — show the automatic APNG pulse widget immediately.
* `/pi-graphics-hide` — hide the automatic APNG pulse widget for this session.
* `/pi-graphics-demo` — print a sample rule, border, glow panel, graphical TUI component frame, and animated APNG pulse into the active UI.

## Example

```
> pi_graphics_render_prompt_enclosure({ columns: 60, leftColor: "#00d8ff", rightColor: "#b48cff" })
> pi_graphics_render_glow_panel({ columns: 48, rows: 9, phase: 0.18 })
> pi_graphics_render_tui_component({ columns: 56, rows: 9, tone: "assistant", phase: 0.2, caption: "graphical TUI" })
> pi_graphics_render_tui_pulse({ columns: 56, rows: 9, tone: "tool", frames: 8, delayMs: 90, caption: "animated APNG pulse" })
> pi_graphics_render_contact_sheet({ columns: 36, rows: 6 })
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

For a standalone visual-regression artefact, run:

```bash
node scripts/render-pi-graphics-contact-sheet.mjs ./pi-graphics-contact-sheet.png
node scripts/render-pi-theme-swatch.mjs ./pi-kitty-theme-swatch.png
```

The test suite under `test/pi-graphics.test.js` covers PNG byte output,
canvas drawing primitives, affordance footprints, kitty graphics command
generation, package manifest discovery, and theme schema completeness. It also
round-trips generated PNGs back to RGBA pixels and asserts visible contrast,
glow coverage, scanline variation, APNG animation chunks, automatic startup and
lifecycle widget wiring, contact-sheet generation, theme swatch wiring, measured deltas from the built-in dark palette, bounded PNG/APNG wire size, tone-palette differences,
phase-independent component cache keys, and stable-layout / different-pixels
pulse frames so graphical changes cannot silently degrade into a theme that
looks the same as plain text.
