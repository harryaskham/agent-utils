# Pi graphics theme + extension

This package ships a **Pi theme** plus a **Pi extension** that together let
agents draw freeform, kitty-graphics-backed UI affordances inside a
Pi-coding-agent session.

The pieces:

| File | Role |
|------|------|
| `themes/kitty-graphics-nord.json` | Calm default Nord color theme: ordinary Pi remains usable while retaining frost/aurora glow tokens. |
| `themes/kitty-graphics.json` | Maximal cyberpunk/neon color theme registered through `pi.themes` in `package.json`. |
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
pi /settings   # then choose "kitty-graphics-nord" for the calm default
# or choose "kitty-graphics" for the neon/cyberpunk palette
# or, equivalently, in settings.json:
# { "theme": "kitty-graphics-nord" }
```

The companion extension (`./extensions/pi-graphics.js`) is loaded
automatically by Pi when the package is installed. **Theme and graphics mode are
separate controls**: the theme determines Pi's colors; `settings.json` under
`piGraphics` (or env vars) determines whether kitty/PNG graphics are calm, off,
or showcase. The default profile is now calm: it keeps native chrome useful by
installing footer/status cues plus editor/input frame widgets, while the huge
startup splash, cockpit wall, Braille scene, validation report, ANSI takeover,
photon rain, lighthouse, and APNG demo widgets stay behind `/pi-graphics-showcase`
or their explicit commands.

Example settings:

```json
{
  "theme": "kitty-graphics-nord",
  "piGraphics": {
    "mode": "calm",
    "autoApplyTheme": false,
    "features": {
      "chrome": true,
      "editorFrame": true,
      "footer": true,
      "nativeChrome": true,
      "showcaseWidgets": false,
      "startupSplash": false,
      "conversationFrame": false,
      "brailleScene": false,
      "validationReport": false,
      "visualProof": false,
      "cockpitWall": false,
      "ansiScene": false,
      "ansiTakeover": false,
      "terminalPalette": false,
      "heartbeat": false
    },
    "animation": { "targetFps": 60, "showcaseFrames": 32 }
  }
}
```

Set `PI_GRAPHICS_SHOWCASE=1` or use `/pi-graphics-showcase` when you want the
maximal debug/demo mode. Individual env vars such as `PI_GRAPHICS_AUTO_WIDGET=1`
still override settings for one run. Use `/pi-graphics-native-chrome-demo` to preview the intended next direction:
PNG-backed translucent placeholder borders/backgrounds for input, user/assistant
messages, tool output, and info/system surfaces. Use `/pi-graphics-visual-contract` (or the
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
kitty-placeholder, opt-out, and reload diagnostics. Use `/pi-graphics-theme-delta`
or `pi_graphics_theme_delta` to print the exact reload sentinel and quantified
RGB deltas against the built-in dark theme. Use `/pi-graphics-conversation-frame`
or `pi_graphics_conversation_frame` to force normal transcript text through the
high-contrast deep-Nordic conversation frame. Use `/pi-graphics-ansi-takeover`
or `pi_graphics_ansi_takeover` for a raw truecolor terminal banner that does not
depend on Pi theme activation or kitty image placement. Use `/pi-graphics-ansi-scene`
or `pi_graphics_ansi_scene` for a half-block ANSI rendering sampled from the same
TypeScript pixel terminal scene used by kitty/APNG output. Use `/pi-graphics-osc-palette`
or `pi_graphics_osc_palette` to ask compatible terminals to change their actual
foreground/background/cursor/ANSI palette to the deep-Nordic theme. Use
`/pi-graphics-braille-scene` or `pi_graphics_braille_scene` to print a
truecolor Unicode Braille image sampled from the TypeScript rendered terminal
scene, so normal transcript output looks graphical even without kitty placement.
Use `/pi-graphics-validation-report` or `pi_graphics_validation_report` to print real
TypeScript renderer metrics (PNG/APNG sizes, unique color buckets, luminance
range, frame/animation bounds) inspired by the Caco Rust visual validation style.
Use `/pi-graphics-visual-proof` or `pi_graphics_visual_proof` for a transcript-visible
truecolor proof block with palette chips, measured contrast/delta numbers, reload
sentinel text, and remediation hints. Use `/pi-graphics-heartbeat` or `pi_graphics_heartbeat` to inspect the lightweight
always-on status/title ticker that keeps idle sessions visibly pulsing without
resending image payloads. Use `/pi-graphics-cockpit-wall` or
`pi_graphics_cockpit_wall` for the largest normal-output takeover wall combining
ANSI scene art, status panels, rails, and sentinel text. Use `/pi-graphics-lighthouse` or
`pi_graphics_lighthouse` for the deliberately oversized normal-TUI beacon that
should be visible even before image/APNG rendering succeeds.

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
* **Braille pixel scene** — `/pi-graphics-braille-scene` and
  `pi_graphics_braille_scene` map rendered RGBA terminal-scene pixels into
  Unicode Braille cells with truecolor ANSI foregrounds. This gives normal
  transcript output an image-like deep-Nordic cyan/violet scene without relying
  on kitty image placement. It is printed on startup by default unless
  `PI_GRAPHICS_AUTO_BRAILLE_SCENE=0` (or
  `PI_KITTY_GRAPHICS_AUTO_BRAILLE_SCENE=off`) is set.
* **Rendered validation report** — `/pi-graphics-validation-report` and
  `pi_graphics_validation_report` compute metrics from the TypeScript RGBA
  renderer and print them as normal transcript output. The report includes
  component PNG dimensions/bytes, estimated kitty wire bytes, unique color
  buckets, luminance range, terminal-scene metrics, and bounded APNG pulse
  frame/byte totals. It is printed on startup by default unless
  `PI_GRAPHICS_AUTO_VALIDATION_REPORT=0` (or
  `PI_KITTY_GRAPHICS_AUTO_VALIDATION_REPORT=off`) is set.
* **Visual proof block** — `/pi-graphics-visual-proof` and
  `pi_graphics_visual_proof` print normal terminal output with truecolor
  deep-Nordic chips, contrast ratios, RGB deltas, the reload sentinel, and a
  warning for terminals that do not render the chips as cyan/violet/gold. It is
  printed on startup by default unless `PI_GRAPHICS_AUTO_VISUAL_PROOF=0` (or
  `PI_KITTY_GRAPHICS_AUTO_VISUAL_PROOF=off`) is set.
* **Live heartbeat ticker** — `/pi-graphics-heartbeat` and `pi_graphics_heartbeat`
  expose the same lightweight ticker that runs on a bounded interval during the
  session. It updates `pi-gfx-heart` status and the terminal title with rotating
  deep-Nordic glyph phases instead of re-uploading large images, so the session
  visibly pulses even while idle. Disable it with `PI_GRAPHICS_AUTO_HEARTBEAT=0`
  (or `PI_KITTY_GRAPHICS_AUTO_HEARTBEAT=off`); tune the bounded interval with
  `PI_GRAPHICS_HEARTBEAT_MS` / `PI_KITTY_GRAPHICS_HEARTBEAT_MS`.
* **Terminal cockpit wall** — `/pi-graphics-cockpit-wall` and
  `pi_graphics_cockpit_wall` print a large normal-output wall combining the ANSI
  scene shader, truecolor rails, status panels, pulse-bus labels, and reload
  sentinel. It is printed on startup by default unless
  `PI_GRAPHICS_AUTO_COCKPIT_WALL=0` (or `PI_KITTY_GRAPHICS_AUTO_COCKPIT_WALL=off`)
  is set. This is the loudest non-kitty path for terminals that still hide theme
  changes.
* **OSC terminal palette takeover** — `/pi-graphics-osc-palette` and
  `pi_graphics_osc_palette` emit OSC 10/11/12 and OSC 4 palette sequences that
  ask compatible terminals to switch foreground, background, cursor, and ANSI
  palette slots to the deep-Nordic kitty graphics palette. The extension applies
  this on startup by default and sends OSC 110/111/112 reset sequences on
  shutdown; opt out with `PI_GRAPHICS_AUTO_TERMINAL_PALETTE=0` (or
  `PI_KITTY_GRAPHICS_AUTO_TERMINAL_PALETTE=off`).
* **ANSI scene shader** — `/pi-graphics-ansi-scene` and `pi_graphics_ansi_scene`
  sample the TypeScript-rendered terminal scene pixels and convert them into
  truecolor ANSI half-block cells (`▀`) with independent foreground/background
  colors. It is printed on session start by default unless
  `PI_GRAPHICS_AUTO_ANSI_SCENE=0` (or `PI_KITTY_GRAPHICS_AUTO_ANSI_SCENE=off`)
  is set, giving a rendered-gfx fallback even without kitty image placement.
* **Raw ANSI takeover banner** — `/pi-graphics-ansi-takeover` and
  `pi_graphics_ansi_takeover` emit a five-line truecolor ANSI gradient banner
  directly to the terminal. It uses deep-Nordic void, cyan, violet, and aurora
  blocks plus the reload sentinel, and it is written on session start by default
  unless `PI_GRAPHICS_AUTO_ANSI_TAKEOVER=0` (or
  `PI_KITTY_GRAPHICS_AUTO_ANSI_TAKEOVER=off`) is set. This surface is intended as
  the last-resort visibility check because it does not rely on theme APIs,
  message renderers, widgets, or kitty image placement.
* **Conversation frame renderer** — `/pi-graphics-conversation-frame` and
  `pi_graphics_conversation_frame` render ordinary transcript text inside a
  deep-Nordic frame with cyan/violet rails, animated-looking block gradients,
  and the reload sentinel. A startup sample and an assistant-turn completion
  sample are sent by default unless `PI_GRAPHICS_AUTO_CONVERSATION_FRAME=0` (or
  `PI_KITTY_GRAPHICS_AUTO_CONVERSATION_FRAME=off`) is set.
* **Custom message chrome** — a `pi-graphics-message` renderer that returns a
  pure TypeScript TUI component (no external `pi-tui` import) with neon rails,
  themed backgrounds, and bounded viewport rendering for displayed custom
  messages.
* **Lighthouse beacon** — `/pi-graphics-lighthouse` and `pi_graphics_lighthouse`
  render a deliberately oversized five-line beacon with full-width block-gradient
  bars and `PI KITTY GRAPHICS LIGHTHOUSE // GRAPHICAL MODE IS ACTIVE`. It is
  mounted above the editor by default, giving a non-subtle normal-TUI surface that
  does not depend on kitty image placeholders.
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
* **Reload sentinel + theme delta** — `/pi-graphics-theme-delta` and
  `pi_graphics_theme_delta` print `PI-GFX-RELOAD-SENTINEL/2026-05-18/NEON-LIGHTHOUSE`
  and quantified RGB deltas for key `kitty-graphics` tokens versus the built-in
  dark theme. The sentinel is also included in the persistent header/status
  chrome so a stale Pi package/session can be spotted immediately.
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

The extension registers the following tools through `pi.registerTool`:

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
* `pi_graphics_braille_scene` — emit a truecolor Unicode Braille scene sampled from rendered pixels.
* `pi_graphics_validation_report` — emit renderer metrics for graphical components and APNG pulse bounds.
* `pi_graphics_visual_proof` — emit the truecolor palette-chip visual proof block.
* `pi_graphics_heartbeat` — preview the lightweight live heartbeat ticker line.
* `pi_graphics_cockpit_wall` — emit the large truecolor terminal cockpit wall.
* `pi_graphics_osc_palette` — emit OSC terminal palette takeover sequences.
* `pi_graphics_ansi_scene` — emit the truecolor ANSI half-block terminal scene sampled from rendered pixels.
* `pi_graphics_ansi_takeover` — emit the raw truecolor ANSI takeover banner.
* `pi_graphics_conversation_frame` — render ordinary text inside the deep-Nordic
  conversation-frame transcript chrome.
* `pi_graphics_theme_delta` — show the reload sentinel and quantified theme-token
  RGB deltas against the built-in dark theme.
* `pi_graphics_clear` — release every kitty image owned by the extension.

And the discoverability slash commands include:

* `/pi-graphics-status` — report how many images are owned, whether Unicode
  placeholder placement is active, whether the automatic pulse and startup
  splash are enabled, and whether the session header/footer/HUD/editor frame and
  APNG editor aura are installed, and whether the neon working row and lifecycle
  title branding and the high-contrast floodlight banner are enabled.
* `/pi-graphics-show` — show the automatic APNG pulse widget immediately.
* `/pi-graphics-hide` — hide the automatic APNG pulse widget for this session.
* `/pi-graphics-message [text]` — display a custom message rendered with Pi kitty graphics message chrome.
* `/pi-graphics-braille-scene [label]` — write an image-like truecolor Braille rendering of the terminal scene.
* `/pi-graphics-validation-report` — write rendered-pixel metrics proving the TypeScript graphical renderer is active.
* `/pi-graphics-visual-proof [label]` — write the visual proof block with color chips and measured deltas.
* `/pi-graphics-heartbeat` — refresh and show the live heartbeat ticker line.
* `/pi-graphics-cockpit-wall [label]` — write the full truecolor terminal cockpit wall.
* `/pi-graphics-osc-palette` — apply the OSC terminal palette takeover.
* `/pi-graphics-ansi-scene [label]` — write the truecolor ANSI scene shader sampled from rendered pixels.
* `/pi-graphics-ansi-takeover [label]` — write the raw truecolor terminal banner.
* `/pi-graphics-conversation-frame [text]` — send a graphical conversation-frame transcript message.
* `/pi-graphics-theme-delta` — print the reload sentinel and theme delta report.
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
lifecycle widget wiring, high-contrast floodlight rendering, live footer branch/status beacon rendering, theme calibration swatch rendering, photon-rain component phase variation, rendered terminal-scene pixel/APNG validation, doctor/takeover diagnostic rendering, lighthouse beacon rendering, Braille pixel-scene rendering, rendered validation-report metrics, visual proof block rendering, live heartbeat ticker rendering, terminal cockpit-wall takeover, OSC terminal-palette takeover, ANSI scene-shader rendering, raw ANSI takeover rendering, conversation-frame transcript rendering, reload-sentinel/theme-delta diagnostics, visual-contract checklist rendering, component-backed HUD and editor-frame rendering, APNG editor-aura rendering, neon working-row/hidden-thinking labels, lifecycle terminal title branding, startup splash and transcript theme-swatch message construction, persistent header/footer component rendering, automatic theme activation diagnostics, themed working-indicator frames, custom message renderer chrome, stage-panel text fallback and APNG chrome, contact-sheet generation, theme swatch wiring, measured deltas from the built-in dark palette, bounded PNG/APNG wire size, tone-palette differences,
phase-independent component cache keys, and stable-layout / different-pixels
pulse frames so graphical changes cannot silently degrade into a theme that
looks the same as plain text.
