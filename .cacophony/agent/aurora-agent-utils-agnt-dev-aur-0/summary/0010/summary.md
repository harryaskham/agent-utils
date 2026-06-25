# Session summary — dedicated combining-mark block zero-width (bd-c7f504)

## Goal

Complete the safe, high-confidence portion of the non-Latin combining-mark
width work (the deferred bd-46436b), extending the bd-15271b zero-width fix.
charCellWidth still counted several DEDICATED combining-mark blocks as one cell
even though the entire block is non-spacing, so zeroing them is unambiguous and
safe. The interspersed-spacing scripts (Hebrew/Arabic) remain intentionally
excluded because they need careful per-codepoint ranges.

## Bead(s)

- `bd-c7f504` — charCellWidth: zero-width handling for dedicated combining-mark
  blocks (Cyrillic/extended/supplement/symbols/half-marks) (bug; landed).
- Extends `bd-15271b`; safe subset carved out of `bd-46436b` (Hebrew/Arabic
  remain there).

## Before state

- charCellWidth returned 1 for U+0483-0489, U+1AB0-1AFF, U+1DC0-1DFF,
  U+20D0-20FF, U+FE20-2F (all non-spacing combining marks).
- JS suite: 769 tests passing.

## After state

- Those 5 dedicated blocks are now zero-width; verified U+20DD -> 0 while the
  adjacent spacing letter U+048A stays 1 and ASCII/CJK are unchanged.
- test/ansi-width.test.js: +2 tests (representative codepoints per block; a
  spacing-adjacent negative). ansi-width file 16 -> 18 tests.
- JS suite: 771 tests passing (+2). npm run check green.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: extensions/pi-graphics/ansi-width.js (zero-width branch),
  test/ansi-width.test.js (+2 tests).
- Tests: +2 / -0 / flipped 0.
- Behavioural delta: strings containing dedicated-block combining marks measure
  narrower (more accurate); ASCII/CJK/spacing characters unchanged.

## Operator-takeaway

The zero-width width correctness work is now complete for every unambiguous
(whole-block non-spacing) case; only the interspersed Hebrew/Arabic ranges remain
deferred in bd-46436b, where the risk of wrongly zeroing a spacing punctuation
character justifies leaving it for a careful per-codepoint pass.
