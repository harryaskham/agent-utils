# Session summary — bd-470314 (pi-graphics editor-border / read-image kitty namespace)

## Bead
bd-470314 (P1 bug): pi-graphics editor border duplicates above native read-image +
FD-28/29 unmanaged-mode warnings (shared kitty namespace with pi-tui).

## What landed (agent-utils side, headlessly verifiable)
Implemented the bead's stated fix direction #2: reserve a documented high sub-band
for pi-graphics editor-chrome image ids, plus a regression test.

- `extensions/pi-graphics/id-space.js`
  - Added `PI_GRAPHICS_IMAGE_ID_BAND_BASE = 0xc0000000` and
    `PI_GRAPHICS_IMAGE_ID_BAND_SIZE = 0x3ffffffe` (band [0xc0000000, 0xfffffffd]).
  - `piGraphicsImageId()` now folds the stable, pid/namespace-salted FNV hash into
    that reserved band: `(BASE + raw % SIZE) >>> 0`.
  - Guarantees pi-graphics image ids: (a) stay disjoint from the 24-bit Unicode
    placeholder *placement* band [0x800000,0xffffff]; (b) cluster away from
    kitty-image-preview / box-rail image ids to cut intra-extension aliasing;
    (c) always carry a non-zero high byte <= 0xff so Unicode placeholder cells
    encode the full id via the high-byte diacritic (verified: diacritic table max
    index is 255) instead of collapsing to 24 bits.
- `test/pi-graphics-id-space.test.js` (new): asserts band membership, uint32,
  placeholder-band disjointness, high-byte encodability, round-trip through
  `buildKittyUnicodePlaceholderCell` (no throw), determinism + pid/namespace
  salting, and intra-name uniqueness.

## Honest scope / not fixed here (documented in code + acceptance notes)
- A reserved band LOWERS but does not ELIMINATE collisions with pi-tui's
  uniform-random `allocateImageId` (a single uniform draw still aliases any live
  id with ~K/2^32 probability).
- The *repeatable* duplicate-border visual (Unicode placeholder cells scrolling
  into scrollback under pi-tui's `a=T` read image) and the FD-28/29 "unmanaged
  mode" tty warnings originate in Pi / pi-tui core (string not present in
  agent-utils or Pi extension source; we only write through Pi's managed writer).
  These are an upstream Pi/pi-tui report, not fixable from this extension. The
  no-duplicate-border visual outcome also requires a live kitty/ghostty terminal
  to confirm and cannot be verified headlessly.

## Validation (foreground, no backgrounding)
- `node --test test/pi-graphics-id-space.test.js test/kitty-image-preview-id-space.test.js test/kitty-graphics.test.js test/pi-graphics.test.js` → 144/144 pass.
- `node --test test/kitty-*.test.js test/pi-graphics*.test.js` → 219/219 pass.
