import test from "node:test";
import assert from "node:assert/strict";

import { parseEnvStyleArgs } from "../extensions/lib/env-args.js";

// Dedicated unit tests for the shared env/shell-like arg parser (bd-c18f9e).
// NOTE on escapes: a JS string literal "a\\ b" is the 4-char runtime input
// `a\ b` that the parser sees, so the backslash assertions below account for
// both the source-level and parser-level escaping.

test("empty or nullish input yields an empty parse", () => {
  for (const input of ["", "   ", null, undefined]) {
    assert.deepEqual(parseEnvStyleArgs(input), { tokens: [], positionals: [], values: {} });
  }
});

test("whitespace separates positionals", () => {
  const r = parseEnvStyleArgs("alpha   beta\tgamma");
  assert.deepEqual(r.positionals, ["alpha", "beta", "gamma"]);
  assert.deepEqual(r.values, {});
  assert.deepEqual(r.tokens, ["alpha", "beta", "gamma"]);
});

test("KEY=VALUE goes to values with the key lowercased and value case preserved", () => {
  const r = parseEnvStyleArgs("Foo=Bar BAZ=qux");
  assert.deepEqual(r.values, { foo: "Bar", baz: "qux" });
  assert.deepEqual(r.positionals, []);
});

test("a value may itself contain '=' (split on the first '=')", () => {
  assert.deepEqual(parseEnvStyleArgs("k=a=b").values, { k: "a=b" });
});

test("positionals and assignments mix", () => {
  const r = parseEnvStyleArgs("run mode=fast extra");
  assert.deepEqual(r.tokens, ["run", "mode=fast", "extra"]);
  assert.deepEqual(r.positionals, ["run", "extra"]);
  assert.deepEqual(r.values, { mode: "fast" });
});

test("single and double quotes group tokens, including inside a value", () => {
  assert.deepEqual(parseEnvStyleArgs('say "hello world"').positionals, ["say", "hello world"]);
  assert.deepEqual(parseEnvStyleArgs("say 'hello world'").positionals, ["say", "hello world"]);
  assert.deepEqual(parseEnvStyleArgs("msg='a b c'").values, { msg: "a b c" });
});

test("backslash escapes the next char, including space and trailing backslash", () => {
  // `a\ b` -> the escaped space joins one token.
  assert.deepEqual(parseEnvStyleArgs("a\\ b").positionals, ["a b"]);
  // `a\\b` (backslash-backslash) -> a single literal backslash.
  assert.deepEqual(parseEnvStyleArgs("a\\\\b").positionals, ["a\\b"]);
  // A trailing backslash is appended literally.
  assert.deepEqual(parseEnvStyleArgs("ab\\").positionals, ["ab\\"]);
});

test("an unclosed quote throws with a descriptive message", () => {
  assert.throws(() => parseEnvStyleArgs("say 'hi"), /Unclosed single quote/);
  assert.throws(() => parseEnvStyleArgs('x="y'), /Unclosed double quote/);
});

test("invalid assignment keys throw; a leading '=' is a positional; special-char keys pass", () => {
  assert.throws(() => parseEnvStyleArgs("1bad=x"), /Invalid argument key: 1bad/);
  // eq <= 0 (no key before '=') is treated as a positional, not an assignment.
  assert.deepEqual(parseEnvStyleArgs("=val").positionals, ["=val"]);
  // Allowed key characters: leading letter/underscore then [A-Za-z0-9_.-].
  assert.deepEqual(parseEnvStyleArgs("my.key-1=v").values, { "my.key-1": "v" });
  assert.deepEqual(parseEnvStyleArgs("_x=y").values, { _x: "y" });
});
