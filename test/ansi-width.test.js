// Direct unit tests for the pi-graphics ansi-width.js pure helpers (bd-cf194e).
//
// These assert the module's ACTUAL current behavior as a regression net; they
// are not a spec change. ansi-width.js is exercised indirectly through the
// footer-layout / pi-graphics tests, but had no direct coverage of its
// branching width logic (CJK/Hangul/fullwidth/emoji double-width, control /
// combining / variation-selector zero-width, ANSI escape skipping, and
// width-preserving truncation that keeps escapes without splitting a 2-wide
// char across the limit).

import test from "node:test";
import assert from "node:assert/strict";

import {
  readTerminalControlAt,
  charCellWidth,
  approximateVisibleCells,
  truncateAnsiToVisibleWidth,
  clampRenderedLineToWidth,
  clampRenderedRowsToWidth,
} from "../extensions/pi-graphics/ansi-width.js";

const CSI_RED = "\x1b[31m";
const CSI_RESET = "\x1b[0m";

test("charCellWidth: plain ASCII and Latin-1 printable are single width", () => {
  assert.equal(charCellWidth("a"), 1);
  assert.equal(charCellWidth(" "), 1);
  assert.equal(charCellWidth("~"), 1);
  assert.equal(charCellWidth("é"), 1); // precomposed U+00E9
  assert.equal(charCellWidth("\u00a0"), 1); // NBSP (0xa0 is not < 0xa0, so not control)
});

test("charCellWidth: empty / NUL / C0 / C1 control are zero width", () => {
  assert.equal(charCellWidth(""), 0);
  assert.equal(charCellWidth(undefined), 0);
  assert.equal(charCellWidth("\u0000"), 0);
  assert.equal(charCellWidth("\u0007"), 0); // BEL (C0)
  assert.equal(charCellWidth("\u001b"), 0); // ESC (C0)
  assert.equal(charCellWidth("\u007f"), 0); // DEL
  assert.equal(charCellWidth("\u0085"), 0); // NEL (C1, 0x7f..0xa0)
});

test("charCellWidth: combining marks and variation selectors are zero width", () => {
  assert.equal(charCellWidth("\u0301"), 0); // combining acute accent
  assert.equal(charCellWidth("\u036f"), 0); // end of combining diacriticals block
  assert.equal(charCellWidth("\ufe0f"), 0); // variation selector-16
  assert.equal(charCellWidth("\ufe00"), 0); // variation selector-1
});

test("charCellWidth: zero-width formatting / joiner / bidi controls are zero width (bd-15271b)", () => {
  assert.equal(charCellWidth("\u200b"), 0); // ZERO WIDTH SPACE
  assert.equal(charCellWidth("\u200c"), 0); // ZERO WIDTH NON-JOINER
  assert.equal(charCellWidth("\u200d"), 0); // ZERO WIDTH JOINER (emoji ZWJ)
  assert.equal(charCellWidth("\u200e"), 0); // LEFT-TO-RIGHT MARK
  assert.equal(charCellWidth("\u200f"), 0); // RIGHT-TO-LEFT MARK
  assert.equal(charCellWidth("\u202a"), 0); // LEFT-TO-RIGHT EMBEDDING
  assert.equal(charCellWidth("\u202e"), 0); // RIGHT-TO-LEFT OVERRIDE
  assert.equal(charCellWidth("\u2060"), 0); // WORD JOINER
  assert.equal(charCellWidth("\u2064"), 0); // INVISIBLE PLUS
  assert.equal(charCellWidth("\ufeff"), 0); // ZERO WIDTH NO-BREAK SPACE / BOM
});

test("charCellWidth: dedicated all-non-spacing combining-mark blocks are zero width (bd-c7f504)", () => {
  assert.equal(charCellWidth("\u0483"), 0); // Combining Cyrillic titlo
  assert.equal(charCellWidth("\u0489"), 0); // Combining Cyrillic millions sign (enclosing)
  assert.equal(charCellWidth("\u1ab0"), 0); // Combining Diacritical Marks Extended
  assert.equal(charCellWidth("\u1dc0"), 0); // Combining Diacritical Marks Supplement
  assert.equal(charCellWidth("\u20d0"), 0); // Combining mark for symbols (left harpoon)
  assert.equal(charCellWidth("\u20dd"), 0); // Combining enclosing circle
  assert.equal(charCellWidth("\ufe20"), 0); // Combining ligature left half
  assert.equal(charCellWidth("\ufe2f"), 0); // Combining Cyrillic titlo right half
});

test("charCellWidth: spacing characters adjacent to the combining blocks stay single width (bd-c7f504)", () => {
  assert.equal(charCellWidth("\u048a"), 1); // Cyrillic capital letter Komi Dje (spacing letter)
  assert.equal(charCellWidth("\u2100"), 1); // Account-of sign (just past combining-for-symbols)
  assert.equal(charCellWidth("\u1d00"), 1); // Latin letter small capital A (before supplement block)
});

test("charCellWidth: Hebrew and Arabic non-spacing combining marks are zero width (bd-46436b)", () => {
  // Hebrew points / accents (Mn)
  assert.equal(charCellWidth("\u0591"), 0); // HEBREW ACCENT ETNAHTA
  assert.equal(charCellWidth("\u05bd"), 0); // HEBREW POINT METEG
  assert.equal(charCellWidth("\u05bf"), 0); // HEBREW POINT RAFE
  assert.equal(charCellWidth("\u05c1"), 0); // HEBREW POINT SHIN DOT
  assert.equal(charCellWidth("\u05c5"), 0); // HEBREW MARK LOWER DOT
  assert.equal(charCellWidth("\u05c7"), 0); // HEBREW POINT QAMATS QATAN
  // Arabic harakat / marks (Mn)
  assert.equal(charCellWidth("\u0610"), 0); // ARABIC SIGN SALLALLAHOU ALAYHE WASSALLAM
  assert.equal(charCellWidth("\u064b"), 0); // ARABIC FATHATAN
  assert.equal(charCellWidth("\u0670"), 0); // ARABIC LETTER SUPERSCRIPT ALEF
  assert.equal(charCellWidth("\u06d6"), 0); // ARABIC SMALL HIGH LIGATURE SAD WITH LAM
  assert.equal(charCellWidth("\u06e7"), 0); // ARABIC SMALL HIGH YEH
  assert.equal(charCellWidth("\u06ed"), 0); // ARABIC SMALL LOW MEEM
});

test("charCellWidth: interspersed Hebrew/Arabic SPACING punctuation/format chars keep their width (bd-46436b)", () => {
  // Hebrew spacing punctuation interleaved with the Mn ranges -> must NOT be zeroed.
  assert.equal(charCellWidth("\u05be"), 1); // HEBREW PUNCTUATION MAQAF
  assert.equal(charCellWidth("\u05c0"), 1); // HEBREW PUNCTUATION PASEQ
  assert.equal(charCellWidth("\u05c3"), 1); // HEBREW PUNCTUATION SOF PASUQ
  assert.equal(charCellWidth("\u05c6"), 1); // HEBREW PUNCTUATION NUN HAFUKHA
  assert.equal(charCellWidth("\u05d0"), 1); // HEBREW LETTER ALEF (spacing)
  // Arabic non-Mn chars interleaved with the harakat ranges -> must NOT be zeroed.
  assert.equal(charCellWidth("\u06dd"), 1); // ARABIC END OF AYAH (format Cf)
  assert.equal(charCellWidth("\u06de"), 1); // ARABIC START OF RUB EL HIZB (symbol)
  assert.equal(charCellWidth("\u06e5"), 1); // ARABIC SMALL WAW (modifier letter Lm)
  assert.equal(charCellWidth("\u06e6"), 1); // ARABIC SMALL YEH (modifier letter Lm)
  assert.equal(charCellWidth("\u06e9"), 1); // ARABIC PLACE OF SAJDAH (symbol)
  assert.equal(charCellWidth("\u0627"), 1); // ARABIC LETTER ALEF (spacing)
});

test("approximateVisibleCells: emoji ZWJ sequences do not over-count the joiners (bd-15271b)", () => {
  // U+1F468 ZWJ U+1F469 ZWJ U+1F467 — three 2-wide emoji joined by two ZWJ.
  // The ZWJ now contribute 0, so the estimate is 2+0+2+0+2 = 6 rather than 8.
  const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
  assert.equal(approximateVisibleCells(family), 6);
  // A zero-width space between letters does not consume a cell.
  assert.equal(approximateVisibleCells("a\u200bb"), 2);
});

test("charCellWidth: CJK / Hangul / fullwidth / emoji are double width", () => {
  assert.equal(charCellWidth("中"), 2); // U+4E2D CJK
  assert.equal(charCellWidth("한"), 2); // U+D55C Hangul syllable
  assert.equal(charCellWidth("Ａ"), 2); // U+FF21 fullwidth A
  assert.equal(charCellWidth("😀"), 2); // U+1F600 emoji
  assert.equal(charCellWidth("〇"), 2); // U+3007 (in 0x2e80..0xa4cf, != 0x303f)
});

test("charCellWidth: U+303F is the documented single-width hole in the CJK range", () => {
  // The wide branch explicitly excludes 0x303f.
  assert.equal(charCellWidth("\u303f"), 1);
});

test("readTerminalControlAt: returns a CSI sequence only when it starts at the index", () => {
  assert.equal(readTerminalControlAt(`${CSI_RED}X`, 0), CSI_RED);
  assert.equal(readTerminalControlAt("X\x1b[0m", 0), null); // 'X' is at index 0
  assert.equal(readTerminalControlAt("X\x1b[0m", 1), CSI_RESET);
});

test("readTerminalControlAt: recognizes OSC sequences terminated by BEL or ST", () => {
  assert.equal(readTerminalControlAt("\x1b]0;title\x07rest", 0), "\x1b]0;title\x07");
  assert.equal(readTerminalControlAt("\x1b]8;;https://x\x1b\\rest", 0), "\x1b]8;;https://x\x1b\\");
});

test("approximateVisibleCells: counts visible cells and ignores ANSI escapes", () => {
  assert.equal(approximateVisibleCells(""), 0);
  assert.equal(approximateVisibleCells("hello"), 5);
  assert.equal(approximateVisibleCells(`${CSI_RED}red${CSI_RESET}`), 3);
  assert.equal(approximateVisibleCells("中文"), 4); // two double-width
  assert.equal(approximateVisibleCells("e\u0301"), 1); // base + zero-width combining
  assert.equal(approximateVisibleCells("😀"), 2);
});

test("approximateVisibleCells: coerces nullish input to an empty string", () => {
  assert.equal(approximateVisibleCells(null), 0);
  assert.equal(approximateVisibleCells(undefined), 0);
});

test("truncateAnsiToVisibleWidth: truncates visible content to the limit", () => {
  assert.equal(truncateAnsiToVisibleWidth("hello", 3), "hel");
  assert.equal(truncateAnsiToVisibleWidth("hello", 0), "");
  assert.equal(truncateAnsiToVisibleWidth("hello", 10), "hello");
});

test("truncateAnsiToVisibleWidth: preserves leading and trailing escapes around the cut", () => {
  assert.equal(
    truncateAnsiToVisibleWidth(`${CSI_RED}hello${CSI_RESET}`, 3),
    `${CSI_RED}hel${CSI_RESET}`,
  );
});

test("truncateAnsiToVisibleWidth: never splits a double-width char across the limit", () => {
  // '中' is 2 wide; with limit 3 the second '文' (also 2) would reach 4 > 3, so
  // it is dropped, leaving a single 2-wide char (visible width 2, under 3).
  assert.equal(truncateAnsiToVisibleWidth("中文", 3), "中");
  assert.equal(truncateAnsiToVisibleWidth("中文", 4), "中文");
});

test("clampRenderedLineToWidth: passes through within width, truncates when over", () => {
  assert.equal(clampRenderedLineToWidth("hello", 10), "hello");
  assert.equal(clampRenderedLineToWidth("hello", 3), "hel");
  // width <= 0 is clamped to a minimum of 1 column.
  assert.equal(clampRenderedLineToWidth("hello", 0), "h");
  assert.equal(clampRenderedLineToWidth(null, 5), "");
});

test("clampRenderedRowsToWidth: maps over arrays, passes through non-arrays", () => {
  assert.deepEqual(clampRenderedRowsToWidth(["ab", "中文"], 3), ["ab", "中"]);
  assert.equal(clampRenderedRowsToWidth(null, 4), null);
  assert.equal(clampRenderedRowsToWidth("notarray", 4), "notarray");
});
