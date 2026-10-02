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
which rasterizes rows itself and places them as Kitty images:

- dependency-free TrueType renderer (cmap 4/12, simple + composite glyf,
  coverage rasterizer, synthetic bold/italic, fontconfig fallback per
  codepoint) at any pixel size — DPI independent; the default size follows the
  terminal's physical cell height;
- vector box drawing, rounded corners, blocks, braille; rounded panels for
  background runs; an editor card and footer bar from Pi's layout rects;
  soft rounded selection; a gradient/vignette background layer; Pi inline
  images decoded and composited; an eased glowing caret;
- rows are position-independent, content-keyed strips: scrolling re-places
  cached strips, only changed rows are rasterized and uploaded (a keystroke is
  ~1 strip, ~4 ms, a few KiB), each frame is one synchronized update;
- input keeps Pi's behaviour: keys/paste/IME untouched (the hidden hardware
  cursor is parked under the caret), SGR mouse is remapped from real pixels
  (SGR-Pixels 1016 on Kitty/Ghostty/WezTerm) or real cells to virtual cells
  before Pi's handlers, so wheel scrolling, drag selection, copy, links and
  the scrollbar work at canvas resolution.

Requires Pi's fullscreen TUI mode (`/settings` → TUI mode or `--tui-mode
fullscreen`) and a Kitty-graphics terminal; refused inside tmux unless
`PI_GRAPHICS_FULL_TMUX=1`. It is independent of `piGraphics.mode` (works with
decorations off). The canvas needs the terminal's cell size in pixels: it asks
with `CSI 16 t` and `CSI 14 t` (deriving cells from the text area if only that
answers). If neither answers it probes Kitty graphics (`a=q`) and either says
the terminal cannot show images (e.g. Termux) or asks for an explicit size via
`/gfx full cell <w>x<h>` / `piGraphics.full.cell` / `PI_GRAPHICS_FULL_CELL`.

```text
/gfx full [on|off|toggle|status]
/gfx full zoom 1.25            # scale the canvas font relative to the terminal cell
/gfx full font-size 16         # absolute canvas font px
/gfx full line-height 1.3
/gfx full font /path/Face.ttf  # or piGraphics.full.font / PI_GRAPHICS_FULL_FONT
/gfx full caret glow|beam
/gfx full pixel-mouse auto|on|off
/gfx full transport png|zlib   # zlib (f=32,o=z) is opt-in: Ghostty 1.3.1 crashes on some zlib streams
/gfx full cell 10x22           # explicit cell px for terminals that never report it
```

Settings live under `piGraphics.full` (`fontSizePx`, `zoom`, `lineHeight`,
`padding`, `font`, `family`, `caret`, `pixelMouse`, `transport`, `cell`).

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
