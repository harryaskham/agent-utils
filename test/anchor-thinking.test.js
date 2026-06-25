// Direct unit tests for the pi-graphics anchor-thinking.js pure classifiers
// (bd-590f81). Regression net for the actual behavior; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizeUnicodeAnchorMode,
  valueLooksLikeThinking,
} from "../extensions/pi-graphics/anchor-thinking.js";

test("normalizeUnicodeAnchorMode: maps the known aliases to topLeft", () => {
  for (const raw of ["topleft", "top-left", "top_left", "anchor", "single", "joined", "joinedunicode"]) {
    assert.equal(normalizeUnicodeAnchorMode(raw), "topLeft", raw);
  }
});

test("normalizeUnicodeAnchorMode: trims and lowercases before matching", () => {
  assert.equal(normalizeUnicodeAnchorMode("  TopLeft "), "topLeft");
  assert.equal(normalizeUnicodeAnchorMode("JoinedUnicode"), "topLeft");
});

test("normalizeUnicodeAnchorMode: unknown / empty / nullish default to fill", () => {
  assert.equal(normalizeUnicodeAnchorMode("fill"), "fill");
  assert.equal(normalizeUnicodeAnchorMode("whatever"), "fill");
  assert.equal(normalizeUnicodeAnchorMode(""), "fill");
  assert.equal(normalizeUnicodeAnchorMode(null), "fill");
  assert.equal(normalizeUnicodeAnchorMode(undefined), "fill");
});

test("valueLooksLikeThinking: matches object type / stage / phase markers", () => {
  assert.equal(valueLooksLikeThinking({ type: "thinking" }), true);
  assert.equal(valueLooksLikeThinking({ stage: "thinking" }), true);
  assert.equal(valueLooksLikeThinking({ phase: "thinking" }), true);
});

test("valueLooksLikeThinking: matches thinking/reasoning/responding words in strings and labels/text", () => {
  assert.equal(valueLooksLikeThinking("thinking..."), true);
  assert.equal(valueLooksLikeThinking("reasoning now"), true);
  assert.equal(valueLooksLikeThinking("responding"), true);
  assert.equal(valueLooksLikeThinking("THINKING"), true); // case-insensitive
  assert.equal(valueLooksLikeThinking({ label: "Reasoning" }), true);
  assert.equal(valueLooksLikeThinking({ text: "responding" }), true);
});

test("valueLooksLikeThinking: false for unrelated values and word-boundary non-matches", () => {
  assert.equal(valueLooksLikeThinking("idle"), false);
  assert.equal(valueLooksLikeThinking(""), false);
  assert.equal(valueLooksLikeThinking(null), false);
  assert.equal(valueLooksLikeThinking(undefined), false);
  assert.equal(valueLooksLikeThinking({ type: "other" }), false);
  assert.equal(valueLooksLikeThinking("rethinking"), false); // no \b before "thinking"
});
