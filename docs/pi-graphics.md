# Pi graphics

Agent Utils ships a fullscreen-native Pi graphics extension at
[`extensions/pi-graphics.js`](../extensions/pi-graphics.js), renderer helpers
under [`extensions/pi-graphics/`](../extensions/pi-graphics/), and three themes:

- `kitty-graphics-nord` — calm Nord palette;
- `kitty-graphics-nord-transparent` — Nord foregrounds with transparent surfaces;
- `kitty-graphics` — brighter neon palette;
- `eink` — transparent greyscale tablet theme.

For protocol details, see
[`kitty-graphics-protocol-audit.md`](kitty-graphics-protocol-audit.md). For the
fullscreen ownership model and implementation sequence, see
[`design/pi-graphics-fullscreen-composition.md`](design/pi-graphics-fullscreen-composition.md).

## How graphics are placed (read this first)

Two Kitty mechanisms are used, chosen for portability across Kitty, Ghostty
and Pi's regular *and* fullscreen renderers:

1. **Unicode placeholders** (virtual `U=1` placements). The image is part of
   the text flow — Pi diffs and scrolls it like text. Used for editor rails,
   footer dividers, box-rail rows and fill-mode box edge cells. Transmissions
   always go through a side channel, never into rendered row text (Pi treats
   any line containing `ESC _G` as an image line: full repaint plus
   delete-all-placements every fullscreen frame).
2. **Compositor overlays** (real placements, under text). A component embeds a
   zero-width marker `ESC _ pi:gfx:<key> BEL`; the
   [frame compositor](../extensions/pi-graphics/frame-compositor.js) wraps the
   active renderer's `doRender`, locates markers and Pi's own IME cursor in the
   final composed screen, and injects absolute `CUP + a=p` commands *inside the
   same synchronized update*, cropped at screen edges. Used for the cursor
   halo/beam, the footer underlay, `relative` editor rails and box strips under
   text. After any host clear (`2J`/`3J`, `a=d,d=A`) the compositor replays
   uploads in the same frame — Kitty and Ghostty prune images that lose their
   last placement.

Placements parented to virtual placements (`P/Q/H/V`) are no longer used:
Ghostty places them at the terminal cursor, and Pi fullscreen deletes them.

## Current supported surface

The normal extension deliberately stays smaller than the historical showcase:

- optional theme application;
- composable editor rails and cursor styling;
- optional segmented footer and footer underlay;
- optional box chrome or lighter top/bottom box rails;
- scoped Kitty image and placement ownership;
- bounded working-message/indicator styling;
- `/gfx`, `/eink`, and `pi_graphics_clear` controls;
- optional low-level render tools for diagnostics.

Old startup splash, heartbeat, ambient scene, ANSI/Braille/cockpit/lighthouse,
conversation-frame, terminal-palette, and proof-wall modes are no longer live
extension surfaces. Old documentation for those modes was removed rather than
leaving commands that silently do nothing. Standalone renderer/smoke scripts may
still generate offline artifacts; they are tests and diagnostics, not automatic
fullscreen UI.

## Installation

Install the package and select a bundled theme through Pi settings:

```bash
pi install git:github.com/harryaskham/agent-utils@v1
```

```json
{
  "theme": "kitty-graphics-nord",
  "piGraphics": {
    "mode": "on",
    "autoApplyTheme": true,
    "boxChrome": false,
    "boxRails": false,
    "editor": {
      "style": "unicode",
      "unicodeMode": "fill",
      "animation": false,
      "borderStyle": "gradient",
      "topBorderHeight": 1,
      "bottomBorderHeight": 1,
      "cursorStyle": "glow",
      "trailingWorkspace": false,
      "rowBackground": false,
      "typingImpulse": true
    },
    "footer": {
      "underlay": true,
      "glowToken": "editorBg",
      "lineToken": "borderAccent"
    },
    "cell": {
      "widthPx": 8,
      "lineHeightScale": 1.2
    }
  }
}
```

`mode: "off"` is genuinely quiet: graphics releases only its editor lease,
namespaced widgets, footer/working surfaces it still owns, cursor policy, timers,
and scoped Kitty ids. Independent editor decorators such as editor chips remain
active.

## Editor composition

Pi graphics and editor chips share the registry in
[`fullscreen-contract.js`](../extensions/pi-graphics/fullscreen-contract.js).
The registry keeps the host editor as a base and applies owner-tagged decorators
in stable priority/registration order. Later `setEditorComponent()` calls replace
the undecorated base rather than erasing the stack. Disabling or reloading Pi
graphics releases only the `pi-graphics` lease; it never reinstalls an obsolete
captured factory over a newer modal/editor owner.

The wrapper forwards focus, input, invalidation, disposal, and unknown host
methods/properties to the base editor. This preserves Pi's editor API and IME
focus behavior while adding graphical rows.

## Editor modes

Canonical fullscreen modes:

| Mode | Behavior |
|---|---|
| `static` | Text-safe/static rails without live placeholder placement. |
| `unicode` | Kitty Unicode-placeholder rails; `unicodeMode` is `fill` or `topLeft`. |
| `relative` | Anchor-relative Kitty rails, intended as an explicit opt-in. |

Animation is independent (`editor.animation`). Cursor styles are `glow`, `cell`,
or `off`. Dynamic heat, workspace fill, and row background default off inside
tmux unless explicitly enabled because frequent placeholder changes can cause
fullscreen repaint/flicker.

Legacy names remain readable for compatibility but produce a one-time warning:

| Legacy | Canonical mapping |
|---|---|
| `joinedUnicode`, `joined-unicode`, `joined_unicode`, `joined` | `unicode` + `topLeft` |
| `placeholder`, `caco` | `unicode` + `fill` |
| `overlay` | `relative` |
| `animated` | `relative` + `animation=true` |

Unknown values fall back to `static`. Runtime normalization does not write
`settings.json`; only explicit `/gfx save` persists canonical values.

## Full pixel canvas (`/gfx full`, experimental)

`/gfx full` is a separate view over the *same* Pi session. Pi keeps composing
its fullscreen screen (transcript, overlays, selection, search, flashes,
editor, footer) but at a virtual cell grid derived from a canvas font size,
independent of the terminal's cells. The frame hook hands each composed screen
to [`canvas/full-canvas.js`](../extensions/pi-graphics/canvas/full-canvas.js),
which rasterizes rows itself and places them as Kitty images.

**Rendering.** Dependency-free TrueType engine (cmap 4/12, simple + composite
glyf, coverage rasterizer with gamma/stem weight, synthetic bold/italic,
fontconfig fallback per codepoint), vector box drawing/blocks/braille, rounded
panels for background runs, an editor card and footer bar from Pi's layout
rects, soft rounded selection, decoded Pi inline images. Rows are
position-independent content-keyed strips: scrolling re-places cached strips
and a keystroke re-uploads about one strip.

**Fonts per role.** Every face sits on the default font's monospace grid.
Defaults: FiraCode Nerd Font Mono everywhere, JetBrains Mono (Nerd) for
thinking, falling back along each chain when not installed (`/gfx full status`
shows what resolved). Roles: `default`, `thinking`, `heading`, `code`, `user`,
`tool`, `editor`, `footer`; set with `/gfx full font thinking JetBrains Mono`
or `piGraphics.full.fonts.<role>` (family name, chain array, or a `.ttf` path).

**Semantic provenance.** Pi exposes the conversation data model (session
entries, `message_*` events, components' `lastMessage` / `isStreaming`) and a
layout tree, but the layout stops at the transcript container — there is no API
for the screen rows of a given thinking block. While the canvas is active the
extension wraps the render of Pi's message components (learned from the live
tree) and prefixes each produced line with a zero-width marker
`ESC _ pi:gfx:@<role>:<block>:<line>[:s] BEL` ([`canvas/semantics.js`](../extensions/pi-graphics/canvas/semantics.js)).
Markers are per row, survive scroll clipping and compositing, and are stripped
before output. Tool rows also carry the tool name and status
(`@tool.bash:…:se` = streaming, failed). They drive per-role fonts, tool panes
and stream-in. Overlays (dialogs, selectors, this settings window) are tagged
the same way (`pi:gfx:ov:<col>:<width>`), so the canvas gives each an opaque
panel and detaches its cells from the block underneath.

**Stream-in.** A streamed glyph's identity is (block, ordinal among the
block's non-space glyphs). Ordinals are invariant under re-wrapping and
scrolling, so only glyphs past a block's previous end are born; a word that
wraps to the next row is not. New glyphs are held out of the row strips and
drawn by per-row overlays rebuilt from current positions on every frame and
tick, so in-flight glyphs follow reflow and auto-scroll; landed glyphs are
baked back in chunks. Large jumps (resume, pastes) appear without animation.
Typed letters get their own effect (`typeIn pop|rise|fade|none`).

**Tool panes.** Bash (the `bash` tool and user `!` commands) renders as a
terminal pane — near-black fill, title band with window dots, status-tinted
border; other tools render as cards with a status stripe (pending, done,
failed). The panes absorb Pi's per-cell tool background and draw their own
rounded fill.

**Effects** (all configurable): a caret with styles `bloom` (light bleeding
over neighbouring text, widening and warming with typing speed), `glow`,
`beam`, `block`, `underline`, `off`; keystroke impulses (expanding ring and
sparks); eased caret glide; an editor-card glow that reacts to typing heat,
thinking, working and agent speech (`agent-utils:speech` events from TTS
narration) plus a flare that pulses with every streamed token; stream-in for
thinking/assistant/tool glyphs (`float` up from a fraction of a row, or
`fade`).

**Backgrounds.** `aurora`, `nebula`, `waves`, `grid`, `stars`, `static`,
`transparent`, `none`, or `auto`, which picks a type and palette from the
theme name (nord → aurora, dracula/synth → grid, ocean → waves, forest →
nebula, …) and its brightness (light themes get a quiet static backdrop).
`backgroundPalette` recolours only the backdrop and tint: `theme` (the theme's
accent tokens), `auto`, `nord`, `ocean`, `sunset`, `forest`, `synthwave`,
`ember`, `mono`. Animated backgrounds are a fixed function of a loop
phase in which every time term is a whole-number harmonic, so one period
(`backgroundPeriod`, default 24 s) loops seamlessly. Frames are rendered
lazily into a ring of cached terminal images during the first pass (about one
per tick, 3–6 ms each at 1/N resolution — soft backdrops upscale smoothly);
after that playback only re-places cached images (~70 bytes/frame). The frame
count is `period × backgroundFps`, capped by `backgroundBudgetMB` of terminal
image memory. With `backgroundReact` the playback speed follows agent activity
(free: the ring is cached) and a tint layer rising from the editor crossfades
to the activity colour, flaring as tokens arrive.

**Surfaces and lighting.** Panels (tool panes, dialogs, the classic editor
card) are drawn with signed distances — anti-aliased edges and corners at any
size, continuous across row strips — with `paneStyle glass` translucency
(`paneOpacity`), a top sheen, gradient borders and soft drop shadows
(`panelShadow`) that fall only outside the panel. The editor gets its own
smooth surface layer (`editorStyle glass|card|neon|minimal|classic|none`,
`editorOpacity`); when Pi lays the editor out flush with the window edge its
text is indented inside the surface (caret, overlays and mouse follow).
Glyphs can cast soft shadows away from a light (`textShadow`, `lightAngle`,
`shadowDistance`) and glow (`textGlow`), from blurred masks cached per glyph.
Screen-space `vignette` and `scanlines` sit above the text. The canvas uses its
own spaced z ladder (background < tint < glow < flare < editor surface < rows
< overlays < vignette/scanlines < caret).

**Frost.** With `frost` > 0, dialogs and toasts are frosted glass: the
transcript row each overlay row covers is remembered when Pi composites it
(content-keyed, so unchanged rows keep cached strips) and drawn blurred under
a more translucent fill. Panes and the editor surface, behind which only the
soft background shows, get a milky fill with fine grain instead.

**Caret light.** `caretLight` relights the glyphs within `caretLightRadius`
cells of the caret in a lamp tint that warms and widens with typing speed (an
overlay above the rows, re-rendered only when the caret, heat level or nearby
text change).

**Running tools.** With `panePulse`, a light sweeps along the top edge (or the
bottom, when the top is scrolled off) of every pending tool pane. Frames
depend only on the pane width, so streaming output does not re-render them.

**Inside gfxsh.** gfxsh already draws the terminal as a pixel canvas and
draws Pi — a full-screen program — on it with its own background and
effects. Pi's canvas would be decoded and re-composited by gfxsh every frame
(slow, rows go missing), so `/gfx full on` declines inside gfxsh
(`TERM_PROGRAM=gfxsh`) with a message; `PI_GRAPHICS_FULL_IN_GFXSH=1` forces
it.

**Finished tools.** With `paneFlash`, when a tool pane goes from running to
done its border lights up in the outcome colour — green for success, red for
a failure — with a bright crest travelling once round it, then fades (about
three quarters of a second; frames are rendered off-thread and cached per
pane size).

**Pinned headers.** With `stickyHeaders`, while a tool pane's title row (the
`$ command` of a Bash pane, the tool name of a card) is scrolled out of view,
the remembered title is drawn as a floating card over the pane's first
visible row, so long output keeps its context.

**Thinking shimmer.** With `thinkingShimmer`, a soft diagonal band of light
sweeps across reasoning while it streams. The band is one image per block
size; animating it only moves its placement.

**Grain.** `grain` overlays animated film grain: one 256 px noise tile tiled
over the window, swapping among four tiles at `grainFps` (0 = static).

**Caret.** The beam is an anti-aliased capsule that spills past its row
(`caretSpill`) and grows with typing speed; fast typing drags a comet smear
in the direction of travel (`caretSmear`). Typing heat is measured by the
canvas from the editor rows it renders, so it works with classic graphics
off, decays between Pi renders (a stored-up heat no longer flashes when the
agent finishes), and clearing the editor on submit is not counted as typing.

**Frame budget.** Effects never stall input: per frame/tick at most one heavy
cache miss (a background frame, glow frame, flare or tint) is rendered; others
catch up on the following ticks. Glow band geometry is cached per editor size,
so a glow frame is a single pass over the band (~1–3 ms). Background loop
frames and editor-glow frames are rendered and PNG-encoded on a worker thread
(`renderWorker`), a few frames ahead of playback; the main thread only uploads
them. Reactive layers (glow, flare, tint) take the per-tick budget before the
background loop, so a long first pass never delays them.

**Window padding.** Images cannot draw outside the cell grid, so the canvas
sets the terminal background to its edge colour (OSC 11, restored with OSC
111) and fades the background layer's alpha to zero at the border: the canvas
blends into Ghostty/Kitty padding without a seam (`edgeBlend`). `transparent`
draws on the terminal's own (possibly translucent/blurred) background.

**Geometry.** Cell size comes from `CSI 16 t` / `14 t` and DECSET 2048 in-band
resize reports, so a font-size change (Ctrl+= / Ctrl+-) re-detects the cell
size and rebuilds the grid live. Terminals that never answer get a precise
error and `/gfx full cell <w>x<h>`.

**HiDPI.** `resolution 2|3` renders strips at 2–3× and places them as
cell-aligned scaled boxes (line pitch snapped to terminal rows), in Kitty and
Ghostty alike. Strips are content-keyed and reused at any row, so a box's size
and sub-cell phase belong to the cached image but its position is always
computed from the row it is placed on (an earlier build cached the position
too, which misplaced scrolled rows — it was not a terminal bug). The 1× path
places images at the terminal's native pixel size.

**Input.** Keys/paste/IME untouched (the hidden hardware cursor is parked under
the caret). SGR mouse is remapped from real pixels (SGR-Pixels 1016, enabled
only when XTVERSION reports Kitty/Ghostty/WezTerm) or real cells to virtual
cells before Pi's handlers: wheel, drag-select, copy, links and the scrollbar
work at canvas resolution.

**Multiplexers and tiling.** The canvas identifies what it is talking to with
XTVERSION (environment variables leak into nested shells, so they are only a
fallback when nothing answers):

- *Plain terminal* (Ghostty, Kitty, WezTerm): free sub-cell grid at the canvas
  font size; layers sit just below text but above cell backgrounds.
- *herdr* (answers `libghostty`): herdr parses each pane's Kitty graphics
  with libghostty-vt and re-places them on the host translated to the pane,
  clipped, and cut around its popups — so positioning in split panes is
  handled for us. It re-places every image with an explicit cell box covering
  the cells it touches, so the canvas switches to `grid aligned`: rows snap to
  terminal rows and strips/overlays are padded to whole cells (offsets baked
  in), making the box equal the natural size (no resampling). Layers must sit
  above cell backgrounds because herdr paints its theme background into every
  cell. Pixel mouse is off (cell mouse reports are translated).
- *tmux* (answers `tmux x.y`): tmux does not track images; passthrough bytes
  reach the outer terminal wherever tmux's own cursor is. So every placement
  moves the **outer** cursor to the pane's absolute origin + cell (from
  `tmux display-message`, including a top status line) inside the same
  passthrough, restores it, and is cropped to the pane. A poller (300 ms, plus
  focus events) tracks the pane: switching windows, zooming another pane or
  detaching removes the canvas; returning, moving or resizing re-places it
  (and every 5 s, in case tmux cleared the screen). tmux drops passthrough
  from invisible panes unless `allow-passthrough all`, so the canvas sets that
  on its own pane only and restores it on stop. Layers sit below cell
  backgrounds so tmux's status line, popups and menus cover them, and the
  OSC 11 edge blend is skipped (it would recolour the pane).

Window managers (i3, sway, AeroSpace, …) need nothing special: each terminal
window is its own canvas. Requires Pi's fullscreen TUI mode and a
Kitty-graphics terminal; independent of `piGraphics.mode`.

```text
/gfx full [on|off|toggle|status|settings]
/gfx full zoom 1.25 | font-size 16 | line-height 1.3 | resolution 2 | gamma 1.5
/gfx full font JetBrains Mono          # default face
/gfx full font thinking Victor Mono    # per role: default thinking heading code user tool terminal editor footer
/gfx full caret bloom|glow|beam|block|underline|off | bloom 1.5 | impulse on|off | glide on|off
/gfx full type pop|rise|fade|none | type-ms 170
/gfx full stream float|fade|none | stream-ms 380 | rise 1 | stagger 8 | stream-roles thinking,assistant,tool
/gfx full tools on|off                 # Bash terminal panes and tool cards
/gfx full background aurora|nebula|waves|grid|stars|static|transparent|none
/gfx full period 24 | bg-fps 20 | bg-scale 8 | bg-budget 64 | react on|off | edge on|off
/gfx full glow on|off | flare on|off | glow-intensity 1.5 | panels on|off | fps 30
/gfx full padding 0 | line-height 1
/gfx full editor glass|card|neon|minimal|classic|none | editor-opacity 0.55
/gfx full pane glass|solid | pane-opacity 0.72 | panel-shadow 0.6
/gfx full shadow 0.35 | text-glow 0.3 | light 45 | shadow-distance 1.2
/gfx full vignette 0.3 | scanlines 0.2 | spill 0.35 | smear 1
/gfx full frost 0.5 | lamp 0.5 | lamp-radius 6 | beacon on|off | grain 0.3 | grain-fps 12
/gfx full background auto | palette auto|theme|nord|ocean|sunset|forest|synthwave|ember|mono
/gfx full pixel-mouse auto|on|off | transport png|zlib | cell 10x22 | grid auto|free|aligned
/gfx save                              # persist to piGraphics.full
```

`/gfx` opens a tabbed settings window (**Pi graphics** / **Full canvas**;
Tab or `[` `]` switches; arrows work under the Kitty keyboard protocol).
Full-canvas changes reconfigure the running canvas in place — no restart;
font/grid changes are coalesced and repaint once — and Enter saves them to
`piGraphics.full`. Saving or switching classic graphics off leaves the canvas
running. Numeric rows step through presets; any value can be set with
`/gfx full <key> <value>` (e.g. `padding 0` when the terminal has its own
padding, `line-height 1`).

### Renderer: `typescript` or `gfx` (gfx-core)

`/gfx full renderer gfx` (setting `piGraphics.full.renderer`) draws the
canvas with **gfx-core**, the Rust renderer shared with
[gfxsh](https://github.com/harryaskham/tools/tree/main/cli/gfxsh), compiled
to WebAssembly; `typescript` (the default) is this extension's own renderer.
Settings are not shared: gfx-core takes the background, caret style and
lighting from this canvas's settings and otherwise its own defaults. Any
gfx-core effect can be set directly with `piGraphics.full.gfx`, an object
of gfx-core option names (as in gfxsh's `[effects]`), for example
`{"card_style": "neon", "caret": "comet", "caret_trail": 0.6,
"scanlines": 0.5, "crt_frame": 0.6, "light_sweep": 0.8}`; invalid values
are reported in `/gfx full status` and the canvas falls back to
`typescript`.

- Pi's frame is mapped, not emulated: rows of styled runs plus blocks from
  the semantic markers — every message and tool call is a glass pane (tools
  with a header row, a running beacon while streaming, ✓/✗ when done) and
  the editor is the live input card with gfx-core's caret.
- `gfx_wasm.wasm` comes from gfxsh, which carries it in its binary: the
  `piGraphics.full.gfxWasm` setting, `$PI_GFX_WASM`,
  `share/gfxsh/gfx_wasm.wasm` beside the `gfxsh` on `PATH` (Nix), else
  `gfxsh wasm` (any install, `cargo install` included: it writes the
  embedded module to `~/.cache/gfxsh/` once per gfxsh build and prints the
  path). When none is found (or inside tmux/herdr, not supported yet) the
  canvas falls back to `typescript` and says so in `/gfx full status`.
- Loader: `canvas/gfx-core-engine.js` (Node builtins only; provides the few
  system calls gfx-core makes itself, fonts passed as bytes).

## Commands

`/gfx` with no arguments opens the settings UI. Useful direct forms include:

```text
/gfx status
/gfx mode on|off|debug
/gfx editor static|unicode|relative
/gfx editor-animation on|off
/gfx unicode-mode fill|topLeft
/gfx border-style gradient|glass|chrome|geometric
/gfx border-height 1
/gfx cursor-style glow|cell|off
/gfx trailing-workspace on|off
/gfx row-background on|off
/gfx typing-impulse on|off
/gfx box on|off
/gfx box-rails on|off
/gfx box-mode unicode|relative
/gfx box-effect <name|auto>
/gfx footer-underlay on|off
/gfx presets
/gfx next
/gfx prev
/gfx themes
/gfx save
```

Box inspection commands are read-only unless named `preview`:

```text
/gfx box audit
/gfx box status
/gfx box summary
/gfx box effects
/gfx box tokens
/gfx box doctor
/gfx box preview
/gfx cursor audit
/gfx cursor status
/gfx cursor doctor
/gfx cursor preview
/gfx cursor clear
```

`/eink on|off|status` applies a low-motion, one-cell-cursor profile at runtime.
Changes remain runtime-only until `/gfx save`.

## Cursor-relative fullscreen placement

The `glow` cursor does not query or guess an absolute terminal row/column. The
editor decorator locates Pi's reverse-video cursor span in each rendered editor
row, measures the visible cells before it (ANSI controls and combining marks are
zero-width; wide glyphs occupy two cells), and replaces that span with a
transparent one-cell Kitty placeholder. A persistent `11×5` child image is
parented to that cell at `H=-5,V=-2`. Pi therefore moves the physical anchor as
it repaints wrapped lines, while Kitty keeps the child centred and clips it at
terminal edges.

This is deliberately a render-sequence contract, not a first-class Pi cursor
coordinate API. A future host cursor-location hook would be cleaner, but the
current path still avoids terminal cursor-position reports, absolute screen
math, and forced fullscreen redraws. Kitty honours offsets from a virtual
parent; Ghostty currently drops those offsets, so centred multi-cell glow is a
Kitty-targeted feature and the one-cell cursor remains the portable fallback.

**Superseded:** the halo is now a compositor overlay placed at Pi's own IME
cursor cell each frame (clipped at edges, drawn under text) and works in
Ghostty; the glyph under the cursor stays readable (bold) instead of being
replaced by a placeholder.

Bounded live smoke in a direct Kitty window:

1. Run `/gfx mode on`, `/gfx cursor-style glow`, then `/gfx cursor preview`.
2. Type across short, CJK/emoji, wrapped, and multiline prompts; resize between
   narrow and wide layouts.
3. Confirm the halo follows the reverse-video edit cursor, remains centred away
   from edges, and clips rather than shifting at the first/last columns.

Inside tmux, first set `PI_GRAPHICS_TMUX_LIVE_EDITOR=1` for the Pi process, then
repeat the same steps. Tmux live editor graphics are opt-in because placeholder
repaints may flicker on some terminal/tmux combinations. `/gfx cursor status`
shows whether a live placement exists; `/gfx cursor clear` deletes only that
placement after the smoke run.

## Runtime-only policy

`/gfx` and `/eink` mutations are in-memory by default. Successive commands
compose against the pending runtime settings. They never rewrite
`settings.json` implicitly. Use `/gfx save` (or Enter in the settings UI) to
persist intentionally; Escape/q closes without saving.

Environment variables override settings for one process. Important controls:

- `PI_GRAPHICS_AUTO_THEME`
- `PI_GRAPHICS_AUTO_EDITOR_SURFACE`
- `PI_GRAPHICS_AUTO_EDITOR_CURSOR`
- `PI_GRAPHICS_AUTO_FOOTER`
- `PI_GRAPHICS_AUTO_BOX_CHROME`
- `PI_GRAPHICS_AUTO_BOX_RAILS`
- `PI_GRAPHICS_EDITOR_STYLE`
- `PI_GRAPHICS_EDITOR_UNICODE_MODE`
- `PI_GRAPHICS_EDITOR_ANIMATION`
- `PI_GRAPHICS_TMUX_LIVE_EDITOR`
- `PI_GRAPHICS_EXPOSE_RENDER_TOOLS`

## Kitty ownership and fullscreen lifecycle

Every image uses a process-scoped id and every placement uses a scoped placement
id. Unicode virtual placements are deleted by owned image id. Relative/real
placements also use the reserved z-index band from `z-index.js`; z-index cleanup
is supplemental and never replaces image-id deletion.

Teardown runs on Pi's documented `session_shutdown` event, covering quit,
reload, new, resume, and fork. It is idempotent and:

1. releases the graphics editor lease;
2. clears namespaced graphics widgets;
3. clears footer and working surfaces only if graphics still owns them;
4. restores cursor policy only if its wrapper is still current;
5. restores conditional UI/component wrappers;
6. drains animation, heat, context, discovery, and deferred-write timers;
7. deletes owned Kitty image data and resets upload/placement caches.

Decorative updates request coalescible redraws. Forced fullscreen redraw remains a
diagnostic opt-in only.

## Tools

The default agent-facing surface contains one tool:

- `pi_graphics_clear` — deletes every image owned by this extension. Pass
  `hostedBand: true` only when a Cacophony host must additionally clear stale
  real/relative placements in the reserved z-index band.

Set `PI_GRAPHICS_EXPOSE_RENDER_TOOLS=1` or
`piGraphics.exposeRenderTools: true` to expose low-level prompt-enclosure and
message-border render tools for diagnostics. Normal editor/footer/box behavior
does not depend on those tools.

## Fallbacks

Without Kitty Unicode placement, textual rails remain readable and raw escape
payloads are not emitted into normal content. Inside tmux, escape commands use
DCS passthrough and high-frequency editor dynamics default off.

## Testing

Focused deterministic coverage:

```bash
node --test --test-reporter=spec \
  test/pi-graphics-fullscreen-contract.test.js \
  test/pi-graphics-cursor-anchor.test.js \
  test/editor-chips.test.js \
  test/pi-graphics.test.js
```

Real-terminal lab (Xvfb + Ghostty or Kitty, screenshots and pty capture;
never part of `npm test`, isolated agent dir):

```bash
node scripts/pi-graphics-ghostty-lab.mjs --out=/tmp/gfx --tui=fullscreen --fixture=4 \
  --settings='{"piGraphics":{"mode":"on","boxChrome":true}}' --record \
  --steps='wait:6500,shot:start,type:hello,wait:800,shot:typed,scroll:500;300;up;6,shot:scrolled'
node scripts/pi-graphics-ghostty-lab.mjs --terminal=kitty --out=/tmp/gfx-full --tui=fullscreen \
  --fixture=4 --steps='wait:7000,cmd:/gfx full on,wait:3000,drag:60;560;300;620,shot:canvas'
```

`--record` tees the exact pty byte stream to `pty.log` for protocol audits;
`PI_GRAPHICS_TRACE=/path` (via `--env`) logs host discovery, compositor
frames and canvas frame timings.

Optional visual artifacts and terminal smoke checks:

```bash
npm run pi-graphics:smoke -- --out=artifacts/pi-graphics-smoke.png
npm run pi-graphics:animation-smoke
npm run pi-graphics:tmux-smoke
```

`test/pi-graphics-fullscreen-matrix.test.js` is the compact fullscreen matrix:
it snapshots deterministic renderer hashes across narrow/wide widths, multiple
themes/styles, and tmux/direct policies; checks resize width bounds, theme
invalidation, overlay/editor replacement, reload teardown, and repeated on/off
resource draining. The broader pure suite covers editor lease ordering,
exact-owner release, mode migration, quiet-off invariants, scoped protocol
commands, and renderer pixels. Live Kitty smoke checks are explicit because
terminal/tmux rendering is environment-dependent.
