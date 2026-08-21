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
  test/editor-chips.test.js \
  test/pi-graphics.test.js
```

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
