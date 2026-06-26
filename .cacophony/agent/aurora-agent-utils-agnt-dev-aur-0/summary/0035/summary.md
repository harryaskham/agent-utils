# Session summary — pi-graphics.md phantom env-var fix (bd-e509ca)

## Goal

Continue the doc-accuracy audit into pi-graphics.md by diffing its documented
PI_GRAPHICS_* env vars against the code. Found two that do not exist.

## Bead(s)

- `bd-e509ca` — Fix pi-graphics.md: phantom PI_GRAPHICS_AMBIENT_FRAMES/DELAY_MS env
  vars (real ones are EDITOR_*) (bug; landed).

## Before state

- pi-graphics.md said to tune the ambient APNG with PI_GRAPHICS_AMBIENT_FRAMES /
  PI_GRAPHICS_AMBIENT_DELAY_MS — neither exists anywhere in extensions/, crates/,
  or scripts/; setting them silently does nothing.

## After state

- Replaced with the real controls PI_GRAPHICS_EDITOR_FRAMES (default 24, max 256)
  and PI_GRAPHICS_EDITOR_DELAY_MS (default 17ms), read in pi-graphics.js:322/328,
  and clarified ambient chrome toggles via PI_GRAPHICS_AUTO_AMBIENT_CHROME. All
  three documented vars verified present in code. npm run check green. Doc-only.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: docs/pi-graphics.md.
- Tests: +0 (doc-only); npm run check green.
- Behavioural delta: none — documentation accuracy only.

## Operator-takeaway

Third doc-accuracy fix this run (after the tool-schemas table and the
execute-signature). Grepping documented env-var/identifier names against the code
is a cheap, high-signal staleness check: two phantom PI_GRAPHICS_* vars that would
have silently no-op'd are now the real EDITOR_FRAMES/DELAY_MS controls.
