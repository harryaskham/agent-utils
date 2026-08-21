import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  EDITOR_CURSOR_GLOW_COLUMNS,
  EDITOR_CURSOR_GLOW_ROWS,
  EDITOR_CURSOR_H_OFFSET,
  EDITOR_CURSOR_V_OFFSET,
  locateEditorCursorAnchor,
  replaceLocatedEditorCursor,
} from "../extensions/pi-graphics/cursor-anchor.js";

const cursor = (value = " ") => `\x1b[7m${value}\x1b[27m`;

test("cursor anchor measures visible cells through ANSI and wide Unicode", () => {
  const line = `\x1b[31mab界🙂e\u0301\x1b[0m${cursor()}`;
  const anchor = locateEditorCursorAnchor(line, 40);
  assert.equal(anchor.cursorCol, 2 + 2 + 2 + 1, "ANSI is zero-width; CJK and emoji are two cells; combining mark is zero");
  assert.equal(anchor.columns, 11);
  assert.equal(anchor.rows, 5);
  assert.equal(anchor.hOffset, -5);
  assert.equal(anchor.vOffset, -2);
});

test("wrapped and multiline editor rows are located independently", () => {
  const rows = [
    "first wrapped row without cursor",
    `  界x${cursor("x")} trailing`,
    "third row",
  ];
  assert.equal(locateEditorCursorAnchor(rows[0], 24), null);
  assert.equal(locateEditorCursorAnchor(rows[1], 24).cursorCol, 5);
  assert.equal(locateEditorCursorAnchor(rows[2], 24), null);
});

test("centred 11x5 geometry remains stable at narrow and wide widths", () => {
  assert.equal(EDITOR_CURSOR_GLOW_COLUMNS, 11);
  assert.equal(EDITOR_CURSOR_GLOW_ROWS, 5);
  assert.equal(EDITOR_CURSOR_H_OFFSET, -5);
  assert.equal(EDITOR_CURSOR_V_OFFSET, -2);

  const centred = locateEditorCursorAnchor(`12345${cursor()}`, 11);
  assert.equal(centred.clippedLeftCells, 0);
  assert.equal(centred.clippedRightCells, 0);

  const narrowLeft = locateEditorCursorAnchor(cursor(), 8);
  assert.equal(narrowLeft.clippedLeftCells, 5);
  assert.equal(narrowLeft.clippedRightCells, 0);

  const narrowRight = locateEditorCursorAnchor(`1234567${cursor()}`, 8);
  assert.equal(narrowRight.clippedLeftCells, 0);
  assert.equal(narrowRight.clippedRightCells, 5);

  const wide = locateEditorCursorAnchor(`${"x".repeat(60)}${cursor()}`, 120);
  assert.equal(wide.cursorCol, 60);
  assert.equal(wide.clippedLeftCells, 0);
  assert.equal(wide.clippedRightCells, 0);
});

test("replacement moves the placeholder with the rendered cursor cell", () => {
  const left = `a${cursor()}bc`;
  const right = `abc${cursor()}`;
  assert.equal(replaceLocatedEditorCursor(left, locateEditorCursorAnchor(left, 8), "ANCHOR"), "aANCHORbc");
  assert.equal(replaceLocatedEditorCursor(right, locateEditorCursorAnchor(right, 8), "ANCHOR"), "abcANCHOR");
});

test("fullscreen cursor path uses row-relative anchors, not absolute terminal probing", () => {
  const source = readFileSync(new URL("../extensions/pi-graphics.js", import.meta.url), "utf8");
  assert.match(source, /locateEditorCursorAnchor\(text, rowWidth\)/);
  assert.match(source, /hOffset: -Math\.floor\(GLOW_COLS \/ 2\)/);
  assert.match(source, /vOffset: -Math\.floor\(GLOW_ROWS \/ 2\)/);
  assert.doesNotMatch(source, /\x1b\[6n|cursor position report|absoluteCursor/i);
});
