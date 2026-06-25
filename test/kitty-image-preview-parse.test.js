// Direct unit tests for the kitty-image-preview parse.js pure helpers
// (bd-76e0f4). Regression net for the actual behavior; no source changes.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseModelSpec,
  fullResolutionDescribeParams,
  parseJsonEnvelope,
  targetText,
} from "../extensions/kitty-image-preview/parse.js";

test("parseModelSpec: splits provider/model on the first slash", () => {
  assert.deepEqual(parseModelSpec("openai/gpt-4"), { provider: "openai", modelId: "gpt-4" });
  // Only the first slash splits; the remainder (incl. slashes) is the model id.
  assert.deepEqual(parseModelSpec("a/b/c"), { provider: "a", modelId: "b/c" });
});

test("parseModelSpec: returns undefined for falsy spec", () => {
  assert.equal(parseModelSpec(undefined), undefined);
  assert.equal(parseModelSpec(""), undefined);
  assert.equal(parseModelSpec(null), undefined);
});

test("parseModelSpec: throws on missing / leading / trailing slash", () => {
  assert.throws(() => parseModelSpec("noslash"), /provider\/model/);
  assert.throws(() => parseModelSpec("/model"), /provider\/model/);
  assert.throws(() => parseModelSpec("provider/"), /provider\/model/);
});

test("fullResolutionDescribeParams: strips max dimensions without mutating input", () => {
  const input = { maxWidth: 10, maxHeight: 20, model: "x", keep: true };
  const out = fullResolutionDescribeParams(input);
  assert.deepEqual(out, { model: "x", keep: true });
  // Original object is untouched.
  assert.deepEqual(input, { maxWidth: 10, maxHeight: 20, model: "x", keep: true });
  assert.deepEqual(fullResolutionDescribeParams(), {});
});

test("parseJsonEnvelope: parses clean JSON", () => {
  assert.deepEqual(parseJsonEnvelope('{"a":1}', "cmd"), { a: 1 });
  assert.deepEqual(parseJsonEnvelope('  {"a":1}  ', "cmd"), { a: 1 });
});

test("parseJsonEnvelope: falls back to the outermost brace slice amid noise", () => {
  assert.deepEqual(parseJsonEnvelope('log line\n{"a":1} trailing', "cmd"), { a: 1 });
  assert.deepEqual(parseJsonEnvelope('x {"a":{"b":2}} y', "cmd"), { a: { b: 2 } });
});

test("parseJsonEnvelope: throws on empty and on brace-free invalid output", () => {
  assert.throws(() => parseJsonEnvelope("", "cmd"), /returned no JSON output/);
  assert.throws(() => parseJsonEnvelope("   ", "cmd"), /returned no JSON output/);
  assert.throws(() => parseJsonEnvelope("not json at all", "cmd"), /returned invalid JSON/);
});

test("targetText: joins present fields, lowercased; skips falsy", () => {
  assert.equal(
    targetText({ title: "Title", name: "Name", app_name: "App", id: "ID42" }),
    "title name app id42",
  );
  assert.equal(targetText({ id: "OnlyId" }), "onlyid");
  assert.equal(targetText({}), "");
});
