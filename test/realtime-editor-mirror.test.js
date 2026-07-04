import test from "node:test";
import assert from "node:assert/strict";

import { makeEditorTranscriptMirror } from "../extensions/lib/realtime-editor-mirror.js";

function fakeUi(initial = "") {
  const state = { value: String(initial) };
  return {
    state,
    setEditorText(t) { state.value = String(t ?? ""); },
    getEditorText() { return state.value; },
  };
}

test("showPartial streams into the editor and takeFinal returns + clears it (bd-0c008d)", () => {
  const ui = fakeUi();
  const m = makeEditorTranscriptMirror(ui);
  assert.equal(m.showPartial("hello"), true);
  assert.equal(ui.state.value, "hello");
  assert.equal(m.showPartial("hello world"), true);
  assert.equal(ui.state.value, "hello world");
  assert.equal(m.owns(), true);
  const final = m.takeFinal("fallback");
  assert.equal(final, "hello world");
  assert.equal(ui.state.value, "", "editor cleared after takeFinal");
  assert.equal(m.owns(), false);
});

test("showPartial never clobbers a manual edit (bd-0c008d)", () => {
  const ui = fakeUi();
  const m = makeEditorTranscriptMirror(ui);
  m.showPartial("hel");
  // Operator edits the box themselves.
  ui.setEditorText("hello there, fixed");
  // A later partial must NOT overwrite the operator's edit.
  assert.equal(m.showPartial("hell"), false);
  assert.equal(ui.state.value, "hello there, fixed");
  // takeFinal returns the operator's edited text, not the raw transcript.
  assert.equal(m.takeFinal("hell"), "hello there, fixed");
  assert.equal(ui.state.value, "");
});

test("takeFinal falls back to the transcript when the editor is empty (bd-0c008d)", () => {
  const ui = fakeUi();
  const m = makeEditorTranscriptMirror(ui);
  assert.equal(m.takeFinal("  raw transcript  "), "raw transcript");
  // Empty editor + empty fallback -> "".
  assert.equal(m.takeFinal(""), "");
});

test("release relinquishes ownership without touching the editor (bd-0c008d / bd-4daaf5)", () => {
  const ui = fakeUi();
  const m = makeEditorTranscriptMirror(ui);
  m.showPartial("partial so far");
  m.release();
  assert.equal(ui.state.value, "partial so far", "text stays for the operator to edit/send");
  assert.equal(m.owns(), false);
  // After release, a new partial writes again (fresh ownership) only if the box
  // still matches; here it doesn't, so it defers to the operator's text.
  assert.equal(m.showPartial("new"), false);
  assert.equal(ui.state.value, "partial so far");
});

test("guards missing editor APIs (bd-0c008d)", () => {
  const m = makeEditorTranscriptMirror({}); // no setEditorText/getEditorText
  assert.doesNotThrow(() => m.showPartial("x"));
  assert.equal(m.takeFinal("fallback"), "fallback");
  assert.doesNotThrow(() => m.release());
});
