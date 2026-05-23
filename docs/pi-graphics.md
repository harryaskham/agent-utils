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
extensions via `pi.extensions`. The `pi-graphics` extension does **not** copy
`kitty-graphics-nord.json` or `kitty-graphics.json` into user theme directories
by default; leaving the bundled themes package-owned avoids package-plus-local
duplicate theme-name warnings during Pi startup. Use `/gfx themes` to inspect
the running theme registry and identify stale copied files or redundant
`settings.json` `themes[]` entries if Pi reports duplicate theme exposure.

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
or showcase. The default profile is now calm but still unmistakably graphical:
it auto-applies the selected kitty graphics theme, requests a bounded OSC
terminal palette change (reset on shutdown), installs footer/status cues and
editor/input frame widgets, and mounts a bounded APNG **rendered TUI surface**
above the editor. That ambient surface is a TypeScript-rendered mirror of Pi UI
chrome — transcript cards, tool lane, input box, footer beacons, deep Nordic
gradients, radial glow, scanlines, and a pulsing waveform — uploaded once as an
efficient APNG. The huge startup splash, cockpit wall, Braille scene, validation
report, ANSI takeover, photon rain, and lighthouse stay behind
`/pi-graphics-showcase` or their explicit commands.

Example settings:

```json
{
  "theme": "kitty-graphics-nord",
  "piGraphics": {
    "mode": "calm",
    "autoApplyTheme": true,
    "features": {
      "chrome": true,
      "editorFrame": true,
      "footer": true,
      "nativeChrome": true,
      "ambientChrome": false,
      "ambientProof": false,
      "showcaseWidgets": false,
      "startupSplash": false,
      "conversationFrame": false,
      "brailleScene": false,
      "validationReport": false,
      "visualProof": false,
      "cockpitWall": false,
      "ansiScene": false,
      "ansiTakeover": false,
      "terminalPalette": true,
      "transcriptChrome": false,
      "editorSurface": true,
      "rawBootstrap": false,
      "headerChrome": false,
      "heartbeat": false
    },
    "animation": { "targetFps": 60, "ambientFrames": 4, "ambientDelayMs": 90, "showcaseFrames": 32 },
    "cell": { "widthPx": 8, "lineHeightScale": 1.2 }
  }
}
```

Set `PI_GRAPHICS_SHOWCASE=1` or use `/pi-graphics-showcase` when you want the
maximal debug/demo mode. Individual env vars such as `PI_GRAPHICS_AUTO_WIDGET=1`
still override settings for one run. Calm mode keeps theme/palette application
and the editor-surface replacement enabled, but leaves transcript/header/raw
bootstrap/ambient proof/showcase surfaces off by default. Use
`PI_GRAPHICS_AUTO_EDITOR_SURFACE=0` to restore the default editor surface, or
set `PI_GRAPHICS_AUTO_AMBIENT_PROOF=1`, `PI_GRAPHICS_AUTO_AMBIENT_CHROME=1`,
`PI_GRAPHICS_AUTO_TRANSCRIPT_CHROME=1`, `PI_GRAPHICS_AUTO_RAW_BOOTSTRAP=1`, or
`PI_GRAPHICS_AUTO_HEADER_CHROME=1` when you explicitly want those verbose proof
surfaces for a run. Editor-surface chrome best-effort wraps any existing custom
input editor and replaces Pi's ASCII separator lines with kitty PNG placeholder
rules; when no editor factory is exposed, the separate above/below editor frame
widgets remain active so the extension still loads without importing Pi
internals. Configure PNG source-cell metrics with `piGraphics.cell.widthPx`,
`piGraphics.cell.heightPx`, and `piGraphics.cell.lineHeightScale` (or the env
vars `PI_GRAPHICS_CELL_WIDTH_PX`, `PI_GRAPHICS_CELL_HEIGHT_PX`, and
`PI_GRAPHICS_LINE_HEIGHT_SCALE`). If `cellHeightPx` is omitted, the renderer uses
`16 * lineHeightScale`; the default line-height scale is `1.2` to match Pi's
120% line spacing. Tune the opt-in ambient APNG with `PI_GRAPHICS_AMBIENT_FRAMES`
and `PI_GRAPHICS_AMBIENT_DELAY_MS`. Use
`/pi-graphics-tui-surface-scene` or `pi_graphics_render_tui_surface_scene` to
force the full TypeScript-rendered Pi TUI scene manually. For an inspectable file
artefact outside Pi, run `npm run pi-graphics:smoke -- --out=artifacts/pi-graphics-smoke.png`.
Use `/pi-graphics-native-chrome-demo` to preview the intended next direction:
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
If a running session still looks unchanged, run `/pi-graphics-live-probe` (or
`pi_graphics_live_probe`) first. It emits the raw/bootstrap/header/editor/status
surfaces and reports package version, configured theme/mode, UI API availability,
settings-derived flags, theme sync counts, Unicode placement status, and the
reload sentinel. Then run `/pi-graphics-doctor` (or
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
  APNG. It is available as an explicit showcase/diagnostic surface; calm mode
  no longer auto-mounts the large scene above the editor. This is the closest
  TypeScript mirror of a graphical Cacophony-style TUI surface and is covered
  by pixel-inspection tests.
* **Conversation stage panels** — the lifecycle-visible widget used during
  normal turns. It combines an APNG TUI component with explicit neon text
  chrome and a text-only fallback, making graphical mode noticeable even when
  the theme was not selected or kitty placeholders are unavailable.
* **Persistent session accents** — pure TypeScript components installed via
  `ctx.ui.setFooter`, `ctx.ui.setWidget`, and the editor component API. Calm
  mode is intentionally quiet: large branded header/HUD/transcript/proof blocks
  are showcase-only by default, the footer is reduced to tiny glyph accents plus
  the branch name, editor rails avoid text labels, and the working row/window
  title use short muted labels. Explicit diagnostics such as
  `/pi-graphics-showcase`, `/pi-graphics-theme-status`, and the opt-in render tools
  still expose the verbose branded proof surfaces when an operator asks for
  them.
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
  "delete all images" command. After session end or the `pi_graphics_clear`
  tool, global placement tracking, editor/upload tracking, and box-chrome
  upload caches are reset so later redraws re-upload their placeholder graphics
  instead of leaving stale placeholder cells behind. This keeps it cooperative with bd-f89780's
  scoped image ownership work.
* Caco-hosted cleanup has a reserved Pi graphics z-index band in
  `extensions/pi-graphics/z-index.js`: `-1073741827..-1073741823` (the explicit
  set exported as `PI_GRAPHICS_RESERVED_Z_INDICES`). Pi-owned kitty placements use
  this band so a host view switch/blur can issue kitty delete-by-z-index commands
  for those values instead of a global clear or a caco↔Pi image registry. The
  `pi_graphics_clear` tool still defaults to per-image scoped deletes; pass
  `hostedBand: true` when a host needs to scrub stale reserved-band placements.
* Pi graphics image ids deliberately use the kitty protocol's full 32-bit
  namespace: Unicode placeholders encode the low 24 bits as foreground
  truecolor and the most-significant byte as the third row/column diacritic.
  Placeholder-selectable virtual placements stay in the high half of the
  24-bit underline-color subspace, while non-placeholder relative placements
  use full 32-bit placement ids. The id scope includes the live process id even
  when `PI_GRAPHICS_ID_NAMESPACE` is configured, because multiple Pi instances
  in tmux share one terminal-global kitty id space. Set
  `PI_GRAPHICS_ID_NAMESPACE_EXACT=1` only for tests/debugging that require exact
  historical ids. This avoids low-id and cross-process collisions with other
  kitty graphics consumers in the same tty.
* Message and TUI box chrome has per-surface effects (`glass`, `aurora`,
  `scanline`, `circuit`, `sparkle`, `cloud`, `facet`, `prism`, `veil`, `scrim`, `frost`, `holo`, `lattice`,
  `contour`, `manuscript`, `tapestry`, `weave`, `glyph`, `blueprint`, `vine`, `dendrite`, `helix`, `braid`,
  `metronome`, `shuttle`, `hourglass`, `signal`, `halo`, `caret`, `bevel`, `chamfer`, `atelier`, `constellation`, `swatch`, `palette`, `satellite`, `orbit`, `emblem`, `crest`,
  `sigil`, `rune`, `panel`, `fold`, `archive`, `lantern`, `choice`, `nebula`, `ticker`, `waveform`, `masthead`, `marquee`, `ribbon`, `ledger`, `lens`, `aperture`, `gauge`, `dial`,
  `slider`, `caliper`, `tile`, `mosaic`, `portal`, `keyring`, `keystone`, `tag`, `badge`, `sextant`, `compass`, `prompt`,
  and `schematic`) and caches both uploads and relative placements so ordinary rerenders do not re-place identical
  box strips. Thinking blocks are detected from assistant message content and get
  warm lantern slats, thinking selector surfaces get stepped choice rails and decision ticks, assistant surfaces get illuminated manuscript margins, skill surfaces get sigil seals, binding ticks, and invocation marks,
  custom-TUI surfaces get docked panel tabs and seams, tool surfaces get schematic bus traces and pads,
  bash surfaces get shell prompt rails, tree surfaces get vine stems, leaf pins, and route joints,
  branch surfaces get helix rails, merge pins, and lineage ticks, loader surfaces get
  shuttle launch rails, docking gates, and progress pips, compaction summaries get archive stack bands and binder tabs,
  agent surfaces get satellite rails, telemetry pips, and signal tags, mascot surfaces get emblem plates, ribbon cuts, and identity studs, custom surfaces
  get atelier drafting tabs, maker marks, and bespoke guide rails, theme surfaces get swatch color cards, sample chips, and calibration ticks, user surfaces get tapestry bands, selvage ticks, and message-thread knots,
  user-selector surfaces get tag tabs, punched holes, and selection stitch ticks, login surfaces get
  portal threshold frames and entry glints, OAuth provider selectors get keyring token-exchange marks,
  selector surfaces get sextant sight lines, index ticks, and navigation pins, image
  surfaces get lens focus brackets, glass glints, and crop-guide ticks, editor surfaces get slim
  caret beams, border surfaces get bevel planes, clipped-corner highlights, and shadow seams, input surfaces get
  sparse angled facets, entry glints, and prompt guide cuts, overlay surfaces get scrim dimmer curtains, focus brackets, and modal edge ticks,
  header surfaces get masthead title rails, cap blocks, and locator ticks, footer surfaces get ticker status rails, beat ticks, and terminal edge markers, session surfaces get ledger binding ticks and index tabs, model surfaces get gauge meter bands, calibration notches, and tiny needle marks, settings surfaces get adjustable slider rails, and widget surfaces get sparse dashboard tiles, corner pins, and pane separators. `aperture` remains available as an explicit shutter variant, `braid` remains available as an explicit interlaced-branch variant, `chamfer` remains available as an explicit cut-corner border variant, `compass` remains available as an explicit directional-selector variant, `constellation` remains available as an explicit star-chart custom variant, `crest` remains available as an explicit mascot-crest variant, `badge` remains available as an explicit identity-card variant, `dendrite` remains available as an explicit branching-tree variant, `dial` remains available as an explicit instrument variant, `frost` remains available as an explicit cold-overlay variant, `hourglass` remains available as an explicit loader-wait variant, `marquee` remains available as an explicit theatre-header variant, `mosaic` remains available as an explicit assembled-tile variant, `orbit` remains available as an explicit agent-orbit variant, `palette` remains available as an explicit broad theme-selector variant, `prism` remains available as an explicit glass-facet variant, `rune` remains available as an explicit compact-rune variant, `waveform` remains available as an explicit footer-signal variant, `weave` remains available as an explicit tactile-thread variant, and `keystone` remains available as an explicit gateway variant. If a box moves or resizes, stale relative
  placements are explicitly deleted before the replacement is placed. Coverage
  includes transcript messages, tool/bash output, skill/custom messages,
  branch/compaction summaries, footer, dynamic borders, loaders, extension
  inputs/editors/selectors, login/OAuth/model/session/settings/theme/thinking
  dialogs, image chooser, tree selector, user-message selector, mascot/agent
  announcement components, notifications (including bounded per-line treatment for multi-line notifications), extension status indicators, hidden
  thinking labels, working messages, working-indicator frames, and generic extension-owned `custom`, widget, footer,
  header, editor, and overlay components returned through Pi's public UI registration APIs. The generic
  wrappers cover components, plain string-array surfaces, and promises resolving
  to either shape. Components/factories/status registrations can opt out with
  `__piGraphicsNoWrap`, `piGraphics: false`, or registration options such as
  `{ piGraphics: false }`; Pi graphics' own internal rail widgets use that opt-out
  so they are not skinned twice. The generic API
  wrappers are restored on session end so reloads do not accumulate nested
  wrappers, and restoration only replaces methods still owned by Pi graphics so
  later extension wrappers are not clobbered. Box chrome widths are capped at
  512 cells before kitty upload/placement to avoid pathological oversized image
  payloads from malformed render widths while still covering ordinary fullscreen
  terminals. Built-in Pi component class patches
  are also reload-safe: reinstallation updates the active graphics runtime rather
  than leaving old box modes/effects captured in global prototypes, and teardown
  restores prototypes only when Pi graphics still owns that runtime. Live `/gfx`
  changes on runtimes without `ctx.reload` force-refresh the wrapper runtime or
  tear it down when graphics/box chrome is disabled, so mode changes do not leave
  stale chrome active.
* Box chrome is enabled by default in caco-compatible `unicode` mode unless
  explicitly disabled with `piGraphics.boxChrome: false` or `/gfx box off`.
  `Ctrl+t` cycles presets across the static editor border, caco-compatible
  `unicode` mode, animated editor border, and every box-effect variant;
  `/gfx` with no arguments opens a Pi-native settings overlay with quick previews;
  `/gfx status` prints the text summary. `/gfx box-effect <name>` can select a
  specific effect or `/gfx box-effect auto` can return to per-message-type effects.
  `/gfx debug` toggles a persistent graphics diagnostics panel and visible `U`
  placeholder cells. `/gfx box preview` emits bounded representative per-surface
  box strips across the current mapped surfaces: assistant, thinking, thinking
  selector, tool, bash, user/user-selector, custom, skill, branch, agent,
  settings, model, oauth, login, selector, tree, image, widget, input, editor,
  border, compaction, footer, header, session, loader, custom-TUI, theme,
  mascot, and overlay. The preview uses compact paired rows with shorter cached
  strips so the expanded surface set stays scannable. It does not change
  `piGraphics.boxEffect`, so the mapped styles can be compared quickly.
  `/gfx cursor preview` emits bounded cool/warm/hot cursor PNG variants so the heat
  glow, directional trail, and frame ticks can be inspected without typing at a
  precise speed. `/gfx box-mode unicode` uses only placeholder-tied graphics for
  box side borders instead of relative placements.
* Box wrapping is ANSI/OSC/APC/DCS-safe: placeholder insertion, unicode side
  borders, width truncation, and padding preserve terminal controls instead of
  slicing inside color/style escapes, Pi IME cursor markers, or tmux/kitty
  passthrough sequences. Unicode box mode also leaves render-width slack for Pi
  containers that pass widths including outer padding, preventing settings and
  selector dialogs from exceeding pi-tui's hard terminal-width guard.
* Editor border chrome spans the full editor/terminal width instead of being
  capped and center-aligned, so fullscreen terminals keep a visible full-width
  input frame. In `unicode` editor mode, trailing empty workspace cells after the
  cursor are filled with Unicode-placeholder glow cells so typed characters
  naturally replace the graphics. The focused editor cursor itself is also
  replaced in every editor graphics style with a one-cell glassy Unicode-placeholder
  cursor, while Pi's zero-width hardware/IME cursor marker is preserved immediately
  before it for terminal input plumbing. When this graphics cursor styling is
  active, the extension asks Pi's TUI to hide the hardware cursor so the terminal
  blink does not fight the styled placeholder; disabling graphics cursor/editor
  styling restores the previous hardware-cursor setting. The cursor anchor remains
  a single Unicode placeholder cell, but the visible cursor art is a larger
  relative kitty placement (roughly 6 columns by 3 rows) centered on that anchor.
  It keeps a bright vertical core in the middle cell while transparent glow extends
  into neighbouring rows. The glow colour/radius is bucketed from inferred recent
  inter-character typing speed and decays after typing stops. Fast cursor motion
  also selects a deterministic left/right heat-trail variant: forward typing leaves
  a short afterimage behind the cursor, while backspacing or leftward movement flips
  the trail to the other side. At medium and high heat, the cursor silhouette gains
  small graphical bracket ticks and ember caps around the vertical core, so the
  frame itself visibly changes rather than only the colour. This is still
  cache-friendly and timer-free: the extension uploads only bucketed PNG variants
  and never attaches a row-wide background that drifts as the cursor moves.
  Placeholder tails still occupy trailing space cells as a caco-compatible fallback
  and as workspace fill after the cursor; those tails are now heat-bucketed too,
  so fast typing warms the otherwise calm trailing workspace into a short scanline
  wake, then cools naturally as the cursor heat decays.
* Box borders are directional: top/bottom caps and left/right side cells render
  different edge-specific PNGs, and unicode mode keeps the same line count as
  the source text to avoid stacked one-line boxes between content rows. Relative
  box mode now leaves textual border rows unwrapped and avoids full-row solid fills,
  so it does not paint top and bottom strokes into the same border line or obscure
  text with a low-z background sheet.
* The built-in footer can be replaced with a compact one-line segmented footer
  (`PI_GRAPHICS_AUTO_FOOTER`, default on with graphics). It preserves the useful
  cwd/branch/context/compaction/model/thinking layout while inserting stable
  Unicode-placeholder divider anchors; each divider anchors a low-z relative
  background behind its segment so the footer remains caco/tmux-compatible and
  width-bounded.
* The `⠼ Working...` indicator receives themed Pi graphics flair via custom
  working-indicator frames while preserving Pi's normal loader lifecycle.

## Tools

The default agent-facing tool surface is intentionally small:

* `pi_graphics_clear` — release every kitty image owned by the extension. It
  also accepts `hostedBand: true` for caco-hosted cleanup, which additionally
  emits delete-by-z-index commands for the reserved Pi graphics z-index band.

Low-level drawing primitives stay client-side by default because their schemas
and raw kitty payloads are noisy in the agent context. Operators who explicitly
want the model to synthesize arbitrary graphics can opt in with
`PI_GRAPHICS_EXPOSE_RENDER_TOOLS=1` or `piGraphics.exposeRenderTools: true`; that
adds:

* `pi_graphics_render_prompt_enclosure` — render a graphical separator.
* `pi_graphics_render_message_border` — render a gradient frame sized in cells.

Normal graphical coverage does **not** depend on those opt-in tools: editor
rails, message/box chrome, dialogs, selectors, notifications, working rows,
status/footer/header/widget/custom surfaces, and extension-owned components are
all handled inside the extension as TUI/client-side details.

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
* `/gfx themes` — print the running Pi theme registry with paths grouped by name so duplicate `kitty-graphics` exposure can be traced without deleting collective/user theme assets.
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
lifecycle widget wiring, high-contrast floodlight rendering, live footer branch/status beacon rendering, theme calibration swatch rendering, photon-rain component phase variation, rendered terminal-scene pixel/APNG validation, doctor/takeover diagnostic rendering, live-probe diagnostics, lighthouse beacon rendering, Braille pixel-scene rendering, rendered validation-report metrics, visual proof block rendering, live heartbeat ticker rendering, terminal cockpit-wall takeover, OSC terminal-palette takeover, ANSI scene-shader rendering, raw ANSI takeover rendering, conversation-frame and bounded transcript-chrome rendering, reload-sentinel/theme-delta diagnostics, visual-contract checklist rendering, component-backed HUD, editor-frame, editor-surface rendering, and raw stdout/stderr/notification bootstrap rendering, APNG editor-aura rendering, neon working-row/hidden-thinking labels, lifecycle terminal title branding, startup splash and transcript theme-swatch message construction, default-on persistent header/footer component rendering, automatic theme activation diagnostics, themed working-indicator frames, custom message renderer chrome, stage-panel text fallback and APNG chrome, contact-sheet generation, theme swatch wiring, measured deltas from the built-in dark palette, bounded PNG/APNG wire size, tone-palette differences,
phase-independent component cache keys, and stable-layout / different-pixels
pulse frames so graphical changes cannot silently degrade into a theme that
looks the same as plain text.
