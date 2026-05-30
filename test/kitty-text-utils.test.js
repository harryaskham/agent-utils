import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  shellQuote,
  normalizeMaybeAtPath,
  expandHome,
  resolveUserPath,
  relativeLabel,
  sanitizeFilenamePart,
  timestampForFilename,
  clampInteger,
} from "../extensions/kitty-image-preview/text-utils.js";

test("shellQuote single-quotes and escapes embedded quotes", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
  assert.equal(shellQuote(42), "'42'");
});

test("normalizeMaybeAtPath strips a leading @ and passes non-strings through", () => {
  assert.equal(normalizeMaybeAtPath("@/tmp/x.png"), "/tmp/x.png");
  assert.equal(normalizeMaybeAtPath("/tmp/x.png"), "/tmp/x.png");
  assert.equal(normalizeMaybeAtPath("@@double"), "@double");
  assert.equal(normalizeMaybeAtPath(undefined), undefined);
  assert.equal(normalizeMaybeAtPath(7), 7);
});

test("expandHome expands ~/ and leaves other paths untouched", () => {
  assert.equal(expandHome("~/pics/a.png"), path.join(os.homedir(), "pics/a.png"));
  assert.equal(expandHome("/abs/path"), "/abs/path");
  assert.equal(expandHome("relative"), "relative");
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome("~nothome"), "~nothome", "only ~/ is expanded");
});

test("resolveUserPath strips @, expands home, and resolves against cwd", () => {
  const cwd = "/work/dir";
  assert.equal(resolveUserPath(cwd, "sub/a.png"), path.resolve(cwd, "sub/a.png"));
  assert.equal(resolveUserPath(cwd, "@sub/a.png"), path.resolve(cwd, "sub/a.png"));
  assert.equal(resolveUserPath(cwd, "/abs/a.png"), "/abs/a.png");
  assert.equal(resolveUserPath(cwd, "~/a.png"), path.join(os.homedir(), "a.png"));
});

test("relativeLabel returns a relative path inside cwd and absolute outside", () => {
  const cwd = "/work/dir";
  assert.equal(relativeLabel(cwd, "/work/dir/sub/a.png"), path.join("sub", "a.png"));
  assert.equal(relativeLabel(cwd, "/other/place/a.png"), "/other/place/a.png");
});

test("sanitizeFilenamePart replaces, trims, caps, and falls back", () => {
  assert.equal(sanitizeFilenamePart("hello world!.png"), "hello-world-.png");
  assert.equal(sanitizeFilenamePart("  --weird--  "), "weird");
  assert.equal(sanitizeFilenamePart(""), "item");
  assert.equal(sanitizeFilenamePart(null), "item");
  assert.equal(sanitizeFilenamePart("***"), "item", "all-invalid collapses to fallback");
  assert.ok(sanitizeFilenamePart("a".repeat(200)).length <= 80);
});

test("timestampForFilename replaces colons and dots for filesystem safety", () => {
  const fixed = new Date("2026-05-30T20:01:23.456Z");
  assert.equal(timestampForFilename(fixed), "2026-05-30T20-01-23-456Z");
  assert.match(timestampForFilename(), /^\d{4}-\d{2}-\d{2}T[\d-]+Z$/);
});

test("clampInteger parses and clamps within bounds, falling back on NaN", () => {
  assert.equal(clampInteger("5", 0, 1, 10), 5);
  assert.equal(clampInteger("100", 0, 1, 10), 10);
  assert.equal(clampInteger("-4", 0, 1, 10), 1);
  assert.equal(clampInteger("abc", 7, 1, 10), 7);
  assert.equal(clampInteger(undefined, 3, 1, 10), 3);
  assert.equal(clampInteger("8.9", 0, 1, 10), 8, "parseInt truncates");
});
