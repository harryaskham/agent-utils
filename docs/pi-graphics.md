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
automatically by Pi when the package is installed. On session start it attempts
to switch the active interactive theme to `kitty-graphics`, reports a `pi-theme`
status if that succeeds, and warns with `select /settings → kitty-graphics` if
runtime theme switching is unavailable. Set `PI_GRAPHICS_AUTO_THEME=0` (or
`PI_KITTY_GRAPHICS_AUTO_THEME=off`) to opt out of automatic theme activation.
By default it also shows a small animated kitty pulse widget above
the editor on session start so graphical mode is visible without manually
running a demo command. During normal turns the same widget changes tone/caption
for prompt capture, agent thinking, tool execution, and ready states, giving
regular conversation flow graphical chrome instead of a static startup-only
banner. The lifecycle widget is now a conversation **stage panel**: it wraps the
APNG component with large text chrome (`PI KITTY GFX // ...`) so there is still
an obvious visual cue even when kitty placeholder graphics are unavailable or an
operator is not looking at the animated pixels. The extension also installs a
persistent custom header (`PI KITTY GRAPHICS ONLINE`), a live status-beacon
footer (`KITTY-GFX LIVE FOOTER ⬢◆✦ deep nordic glow`), a real component-backed HUD widget below the
editor, a high-contrast `PI KITTY GRAPHICS FLOODLIGHT` banner above the editor,
an APNG-backed editor aura below the input area, neon editor-frame widgets above
and below the input area, a transcript startup splash message, and replaces the normal streaming row and terminal/window title with branded Pi kitty graphics stage text, hidden-thinking label, and themed neon indicator
(`✧ ✦ ◆ ✺ ⬢ ...`) so the session chrome and active generation both pulse even
between widget redraws. Set `PI_GRAPHICS_AUTO_WIDGET=0` (or
`PI_KITTY_GRAPHICS_AUTO_WIDGET=off`) to opt out of the widget, and set
`PI_GRAPHICS_AUTO_SPLASH=0` (or `PI_KITTY_GRAPHICS_AUTO_SPLASH=off`) to suppress
the startup splash. Use `/pi-graphics-visual-contract` (or the
`pi_graphics_visual_contract` tool) to show an explicit checklist of all expected
visible cues when judging whether the mode is active. Use
`/pi-graphics-theme-swatch` (or `pi_graphics_theme_swatch`) to render actual
runtime theme-token calibration bars; if those bars look ordinary, the running
session has not picked up the `kitty-graphics` theme/package yet. The extension
also sends a transcript-visible `pi-graphics-theme-swatch` message on startup by
default; opt out with `PI_GRAPHICS_AUTO_THEME_SWATCH=0` or
`PI_KITTY_GRAPHICS_AUTO_THEME_SWATCH=off`. Use `/pi-graphics-photon-rain` or
`pi_graphics_photon_rain` for an all-text pulsing high-tech render field that is
visible even when kitty image placeholders are unavailable. Use
`pi_graphics_render_terminal_scene` for the pixel-rendered Cacophony-style
terminal scene: cell grid, aurora glow, status chips, scanlines, and APNG pulse.
When kitty placeholder placement is active, the extension auto-mounts this
rendered terminal scene above the editor on startup; opt out with
`PI_GRAPHICS_AUTO_TERMINAL_SCENE=0` or `PI_KITTY_GRAPHICS_AUTO_TERMINAL_SCENE=off`.
If a running session still looks unchanged, run `/pi-graphics-doctor` (or
`/pi-graphics-takeover`) to re-apply the visible surfaces and report theme,
kitty-placeholder, opt-out, and reload diagnostics.

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
* **Rendered terminal scenes** — `pi_graphics_render_terminal_scene` draws a
  full pixel-level terminal surface (cell grid, deep-Nordic vertical gradient,
  aurora radial glows, status chips, scanlines, and bottom waveform) as PNG or
  APNG. It is auto-mounted above the editor when kitty placeholders are active,
  making the real rendered gfx visible without a manual tool call. This is the
  closest TypeScript mirror of a graphical Cacophony-style TUI surface and is
  covered by pixel-inspection tests.
* **Conversation stage panels** — the lifecycle-visible widget used during
  normal turns. It combines an APNG TUI component with explicit neon text
  chrome and a text-only fallback, making graphical mode noticeable even when
  the theme was not selected or kitty placeholders are unavailable.
* **Persistent session header/footer/HUD/swatch** — pure TypeScript components
  installed via `ctx.ui.setHeader`, `ctx.ui.setFooter`, and `ctx.ui.setWidget`
  factories so the session announces `PI KITTY GRAPHICS ONLINE`
  at the top, an above-editor `PI THEME CALIBRATION SWATCH` made from actual theme tokens, `KITTY-GFX LIVE FOOTER` plus live branch/status beacon text in the bottom chrome, a live `PI GFX HUD` near the
  editor, a full-width `PI KITTY GRAPHICS FLOODLIGHT` banner, an APNG
  `PI KITTY GFX EDITOR AURA`, and `NEON EDITOR FIELD` /
  `INPUT FIELD STABILIZED` rails around the input area with theme-colored rails
  and bounded rendering. During active turns the working row says `PI KITTY GFX`
  with the current stage (`PROMPT CAPTURED`, `AGENT THINKING`, `TOOL EXECUTION`,
  or `READY`), the terminal/window title becomes `⬢ PI KITTY GFX // <STAGE>`,
  and the hidden-thinking label becomes `PI GFX THOUGHTSTREAM`. The custom
  footer reads Pi's runtime `footerData.getGitBranch()` and
  `footerData.getExtensionStatuses()` APIs so it preserves/spotlights the
  extension status cluster instead of hiding it.
* **Startup splash** — on `session_start`, the extension sends a bounded
  `pi-graphics-message` into the transcript so graphics mode leaves a visible
  neon block in normal conversation history even if terminal theme changes are
  subtle.
* **Custom message chrome** — a `pi-graphics-message` renderer that returns a
  pure TypeScript TUI component (no external `pi-tui` import) with neon rails,
  themed backgrounds, and bounded viewport rendering for displayed custom
  messages.
* **Photon rain text renderer** — `/pi-graphics-photon-rain` and
  `pi_graphics_photon_rain` render a phase-shifting TypeScript TUI component
  made from deep-Nordic glyph rows (`⬢◆✦✺▰▱◢◣`) and runtime theme tokens. It is
  also mounted above the editor by default so the session has an unmistakable
  high-tech text surface even without kitty image support.
* **Theme calibration swatch** — `/pi-graphics-theme-swatch` and
  `pi_graphics_theme_swatch` render block bars using the runtime theme's
  `selectedBg`, `customMessageBg`, `toolPendingBg`, `borderAccent`,
  `thinkingXhigh`, and semantic success/warning/error tokens, making theme
  activation auditable in ordinary text UI chrome. `pi_graphics_send_theme_swatch`
  and `/pi-graphics-theme-swatch-message` send the same swatch into the transcript,
  and session start does this automatically unless disabled by env.
* **Doctor / takeover diagnostics** — `/pi-graphics-doctor`,
  `/pi-graphics-takeover`, and `pi_graphics_doctor` report the active theme,
  kitty placeholder state, auto-surface opt-outs, and remediation steps. The
  command also re-applies the visible surfaces and sends the transcript theme
  swatch, giving a single in-session check when graphics mode appears unchanged.
* **Visual contract self-test** — `/pi-graphics-visual-contract` and
  `pi_graphics_visual_contract` render a checklist covering theme request,
  kitty placeholder state, header/footer/HUD/floodlight, editor frame + APNG
  aura, working row + terminal title, and startup splash state.
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

The extension registers nine tools through `pi.registerTool`:

* `pi_graphics_render_prompt_enclosure` — render a graphical separator.
* `pi_graphics_render_message_border` — render a gradient frame sized in
  cells.
* `pi_graphics_render_glow_panel` — render a high-tech Nordic glow panel sized
  in cells, optionally at a specific pulse phase.
* `pi_graphics_render_tui_component` — render a high-tech graphical TUI card
  frame, with optional tone/density/phase/caption controls.
* `pi_graphics_render_tui_pulse` — render a looping APNG version of the TUI
  component for efficient continuous pulse animation.
* `pi_graphics_render_stage_panel` — render the always-visible conversation
  stage panel used by lifecycle chrome, including text fallback.
* `pi_graphics_render_contact_sheet` — render a static visual regression sheet
  covering tones and pulse phases for human inspection.
* `pi_graphics_send_message` — send a displayed custom message through the
  `pi-graphics-message` renderer for validating normal conversation chrome.
* `pi_graphics_clear` — release every kitty image owned by the extension.

And five slash commands:

* `/pi-graphics-status` — report how many images are owned, whether Unicode
  placeholder placement is active, whether the automatic pulse and startup
  splash are enabled, and whether the session header/footer/HUD/editor frame and
  APNG editor aura are installed, and whether the neon working row and lifecycle
  title branding and the high-contrast floodlight banner are enabled.
* `/pi-graphics-show` — show the automatic APNG pulse widget immediately.
* `/pi-graphics-hide` — hide the automatic APNG pulse widget for this session.
* `/pi-graphics-message [text]` — display a custom message rendered with Pi kitty graphics message chrome.
* `/pi-graphics-demo` — print a sample rule, border, glow panel, graphical TUI component frame, and animated APNG pulse into the active UI.

## Example

```
> pi_graphics_render_prompt_enclosure({ columns: 60, leftColor: "#00d8ff", rightColor: "#b48cff" })
> pi_graphics_render_glow_panel({ columns: 48, rows: 9, phase: 0.18 })
> pi_graphics_render_tui_component({ columns: 56, rows: 9, tone: "assistant", phase: 0.2, caption: "graphical TUI" })
> pi_graphics_render_tui_pulse({ columns: 56, rows: 9, tone: "tool", frames: 8, delayMs: 90, caption: "animated APNG pulse" })
> pi_graphics_render_stage_panel({ tone: "assistant", caption: "agent thinking", columns: 58, rows: 7 })
> pi_graphics_send_message({ content: "render this message with neon chrome", title: "visible message" })
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
lifecycle widget wiring, high-contrast floodlight rendering, live footer branch/status beacon rendering, theme calibration swatch rendering, photon-rain component phase variation, rendered terminal-scene pixel/APNG validation, doctor/takeover diagnostic rendering, visual-contract checklist rendering, component-backed HUD and editor-frame rendering, APNG editor-aura rendering, neon working-row/hidden-thinking labels, lifecycle terminal title branding, startup splash and transcript theme-swatch message construction, persistent header/footer component rendering, automatic theme activation diagnostics, themed working-indicator frames, custom message renderer chrome, stage-panel text fallback and APNG chrome, contact-sheet generation, theme swatch wiring, measured deltas from the built-in dark palette, bounded PNG/APNG wire size, tone-palette differences,
phase-independent component cache keys, and stable-layout / different-pixels
pulse frames so graphical changes cannot silently degrade into a theme that
looks the same as plain text.
