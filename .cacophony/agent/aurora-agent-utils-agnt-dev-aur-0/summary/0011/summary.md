# Session summary — Hebrew/Arabic combining-mark zero-width (bd-46436b)

## Goal

Complete the non-Latin combining-mark width correctness work by handling the
interspersed-spacing scripts (Hebrew, Arabic) that were deferred from bd-46436b
because their blocks interleave spacing punctuation that must NOT be zeroed. The
deferral concern (wrongly zeroing a spacing char) is directly addressed by
explicit negative tests for every interspersed spacing/format character, making
the per-codepoint Mn ranges safe and verifiable.

## Bead(s)

- `bd-46436b` — charCellWidth still over-counts non-Latin combining marks
  (Hebrew/Arabic) (bug; promoted from draft, claimed, landed).
- Completes the series: bd-15271b (ZWJ/ZWSP/bidi), bd-c7f504 (dedicated blocks),
  bd-46436b (Hebrew/Arabic).

## Before state

- charCellWidth returned 1 for Hebrew/Arabic non-spacing combining marks, so
  e.g. Arabic "beh + fatha" measured 2 cells instead of 1.
- JS suite: 771 tests passing.

## After state

- charCellWidth zeroes the Mn ranges of Hebrew (U+0591-05BD, 05BF, 05C1-05C2,
  05C4-05C5, 05C7) and Arabic (U+0610-061A, 064B-065F, 0670, 06D6-06DC,
  06DF-06E4, 06E7-06E8, 06EA-06ED), excluding interspersed spacing/format chars.
- test/ansi-width.test.js: +2 tests (positive Mn coverage + a critical negative
  test asserting U+05BE/05C0/05C3/05C6 and U+06DD/06DE/06E5/06E6/06E9 plus
  Hebrew/Arabic letters stay width 1). ansi-width 18 -> 20 tests.
- Verified: Arabic beh+fatha now approximateVisibleCells = 1. JS suite 773 (+2).
  npm run check green; ASCII/CJK/spacing unchanged.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: extensions/pi-graphics/ansi-width.js (Hebrew/Arabic Mn ranges),
  test/ansi-width.test.js (+2 tests).
- Tests: +2 / -0 / flipped 0.
- Behavioural delta: Hebrew/Arabic text with combining marks measures narrower
  (correct); interspersed spacing/format chars and all other text unchanged.

## Operator-takeaway

The Unicode width-correctness work is now complete across Latin, emoji/ZWJ,
zero-width formatting, dedicated combining blocks, and the interspersed Hebrew/
Arabic scripts. The earlier "rabbit hole" concern was resolved by pinning every
interleaved spacing character with explicit negative tests, so RTL text with
harakat/points no longer truncates too aggressively in the footer/status.
