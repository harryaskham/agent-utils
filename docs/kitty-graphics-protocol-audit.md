# Kitty graphics protocol audit — 2026-05-24

Bead: `bd-64cf76`.

Harry requested a protocol-focused pass over the Kitty graphics protocol and the `agent-utils` Kitty/Pi graphics implementation. Most of the implementation work from that audit had already landed through `ms-mac-agent-utils-agnt-dev-2`; this note records the consolidated findings and the one narrow remaining correction made in this follow-up.

## Scope checked

- Escape framing and tmux passthrough.
- Direct PNG transmission, chunking, quiet mode, and payload size limits.
- Image ids, placement ids, Unicode-placeholder ids, and truecolor placeholder encoding.
- Virtual Unicode placeholders and relative placements.
- Delete semantics and cleanup safety.
- Animation/APNG claims versus the live path that actually repaints in Pi/tmux.
- Rendering/cache efficiency and repeated upload avoidance.

## Findings

### Already good / already addressed

- **Escape framing and tmux passthrough:** `extensions/kitty-graphics.js` correctly emits APC `ESC_G...ESC\\` and wraps it for tmux as DCS `ESC Ptmux; ... ESC\\`, doubling inner ESC bytes. Existing tests cover this. No passthrough churn is recommended.
- **Chunking:** direct base64 payloads are capped to Kitty's 4096-byte chunk size, non-final chunks are multiples of four, and animation frame continuations keep `a=f` as the protocol requires.
- **Scoped cleanup:** the image-preview extension tracks owned image ids and avoids global delete-all (`d=A`), so it does not erase caco/Pi-owned graphics.
- **Unicode placeholders:** image ids use the 32-bit namespace with the high byte encoded as the third placeholder diacritic, while placeholder placement ids stay in the 24-bit underline-color namespace.
- **Relative placements:** Kitty `H`/`V` relative-placement offsets are terminal-cell offsets; positive values move right/down and negative values move left/up from the parent's top-left cell. Relative placements remain valid for box chrome, footer backgrounds, editor row backgrounds, previews, animated editor borders, and the best-effort live cursor halo. The live cursor now separates the proven anchor from the risky halo: it first renders a direct Unicode-placeholder PNG in the cursor cell (the same text-flow path as trailing workspace), then attaches an 11×5 relative halo with `H=-5,V=-2` to that direct cursor's image id and placement id. The halo uses an under-text z-index above non-default editor cell backgrounds; placing it at the deeper background z-index made it disappear after the editor row repainted during typing. If the relative halo drifts or fails in live Kitty/tmux, the cursor cell remains visible and correctly positioned. Raw relative-placement APC must still stay out of rendered editor text and be emitted through the side-channel writer.
- **Animation:** the docs and implementation now treat terminal-driven APNG/native loops as unreliable in the live Pi/tmux path and prefer explicit current-frame control (`a=a,c=<frame>`) where repainting is confirmed. Live manual animation timers are unref'd so they do not pin the process, stop on scoped graphics reset/session end, and self-stop on write failures; preview-series animation/cycle timers also guard against overlapping async frame prepares.
- **Efficiency:** dev2's follow-up cache work reduced repeated strip/placement rendering and clarified that z-index cleanup is only supplemental for real/relative placements; per-image deletes remain authoritative for placeholder graphics.

### Narrow correction made here

- **Cursor cleanup used the wrong delete selector:** Kitty's `d=p` means "delete placements intersecting a specific cell" and expects `x`/`y`; it is not placement-id deletion. To remove a known placement id for an image, the protocol uses `d=i` with `i=<image id>,p=<placement id>`. The editor cursor cleanup paths now use `deleteMode: "i"` with both the image id and placement id.

## Remaining tracked work

- `bd-bd4f05` — Keep interactive Kitty animation smoke out of default npm test logs. This is the only related open issue seen during this follow-up audit pass.

## Recommendation

Keep future Kitty graphics work narrow and evidence-driven. The passthrough path, Unicode-placeholder encoding, chunking, and scoped cleanup helpers are covered by tests and should not be rewritten without a concrete observed failure. Prefer small protocol-semantic fixes plus source guards over broad graphics rewrites.

---

# Follow-up — 2026-06-14: stored-image-data freeing (macOS WindowServer / IOSurface leak), fixed in bd-b94fa1

Harry reported macOS `WindowServer` RAM growing without bound and suspected the
`agent-utils` kitty plugin transmitted kitty graphics but never freed them,
leaking IOSurface for long-running / backgrounded Pi agents even when kitty
graphics are not displayed in the foreground caco TUI.

## Root cause

The Kitty delete action (`a=d`) selector is **case-sensitive**:

- **lowercase** (`d=i` / `d=z` / `d=a`) deletes only the *placement* (the
  displayed image) and **keeps the transmitted image DATA resident** in the
  terminal so it can be re-placed without re-upload.
- **UPPERCASE** (`d=I` / `d=Z` / `d=A`) deletes the placements **and frees the
  stored image data** once it is unreferenced.
  (kitty docs: "the uppercase variant of each value will also delete the actual
  image data" — https://sw.kovidgoyal.net/kitty/graphics-protocol/.)

Every delete site used the lowercase form, so image *data* was never freed —
only placements. On macOS the terminal image backing store is an IOSurface
accounted to `WindowServer`, and image-id churn (box-chrome strips per
width/colour, screenshot/preview stream frames, gallery eviction) made the
resident set grow without bound for long-lived agents. `/image-clear` and
`session_shutdown` even forgot the owned ids, so the data could not be freed
afterwards.

## Fix (landed in bd-b94fa1)

Added a `freeData` option (uppercase free selector, `d=I` / `d=Z`) to the
`kitty-graphics.js` delete builders and wired it into the genuine
*permanent-removal* paths only — `/image-clear`, `session_shutdown`,
box-chrome teardown and per-anchor-row strip eviction (also pruning the
`uploadedStrips` cache so a future identical strip re-uploads), stale-startup
reclamation, `session_end`, and the `pi_graphics_clear` tool — while keeping the
lowercase placement-only form for *transient hide / re-show* (`/image-hide`,
preview navigation) so that data stays cached for an instant re-placement.
Scoping is unchanged: deletes remain per-owned-image-id, never a global
delete-all. Covered by `test/kitty-graphics-free-data.test.js` and source guards
in `test/pi-graphics.test.js` / `test/box-chrome.test.js`.

## Measuring on macOS

`WindowServer` RSS reads 0 via plain `ps` (entitlement trap). Use
`footprint WindowServer`, `vmmap`, or Activity Monitor for the real figure
(per picasso-dev-1, 2026-06-14).

## Note

A second worker (agnt-dev-1) independently implemented the same fix in the same
session; bd-b94fa1 (agnt-dev-0) landed first, so the duplicate was stood down
and only this audit-doc record was retained.

---

# Follow-up — 2026-06-14: cross-pid image-id orphaning is the DOMINANT WindowServer leak (fixed in bd-ad43f8)

The free-on-removal fix above (bd-b94fa1) is necessary but not sufficient. The
**dominant** driver of unbounded macOS `WindowServer` growth for long-running /
restarting managed agents is **cross-pid image-id orphaning**, fixed separately
in bd-ad43f8.

## Mechanism

`extensions/pi-graphics/id-space.js` `piGraphicsIdScope()` previously salted the
kitty image-id namespace with the process pid. A managed Cacophony agent owns a
persistent tmux pane and restarts **in place** (`caco agent restart` / `recreate`
/ `resume`), so every restart minted a **fresh** pid-salted id namespace. A
terminal can only delete/free image ids it still knows about, so every image the
*previous* process generation transmitted became an **orphan** — unreachable to
any scoped delete, including `pi_graphics_clear` (which only knows the live
process's owned ids). Those orphaned images stayed resident as IOSurface
accounted to WindowServer for the life of the terminal, accumulating one full
generation of images per restart. This is why the leak grew over time even
though each individual process scoped-deleted its own images, and why
`pi_graphics_clear` could not reclaim it.

## Fix (landed in bd-ad43f8)

For managed agents (`CACO_AGENT_ID` / `CACOPHONY_AGENT` present, and no explicit
operator-configured `PI_GRAPHICS_ID_NAMESPACE` / `*_EXACT`), `piGraphicsIdScope`
now drops the pid salt and keys to a **stable** `caco-agent:<id>` namespace. A
restart therefore **reuses and overwrites** the prior generation's image ids —
which frees their data — instead of orphaning them. Distinct agents still have
distinct `CACO_AGENT_ID`, so removing the pid salt does not introduce cross-pane
id collisions, and an explicit operator namespace still takes precedence.
Covered by `test/pi-graphics-id-space.test.js` and
`test/kitty-image-preview-id-space.test.js`. Full suite green (635 tests).

## Combined picture

- **bd-b94fa1** (within-process): permanent-removal paths now emit the uppercase
  free selector (`d=I` / `d=Z`) so a live process actually reclaims its image
  data instead of only hiding placements.
- **bd-ad43f8** (cross-process, dominant): a stable per-agent id namespace makes
  a restart reuse+overwrite+free the prior generation's images instead of
  orphaning unreclaimable cross-pid IOSurfaces.

Together they bound WindowServer image memory both within a process and across
restarts. Two non-critical refinements remain tracked as a P3 draft by
agnt-dev-0 (screenshot/preview stream-frame id reuse; preview headless-free).
