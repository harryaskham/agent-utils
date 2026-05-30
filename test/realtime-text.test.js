import test from "node:test";
import assert from "node:assert/strict";

import {
  isAuthFailure,
  isMicPermissionFailure,
  stripAnsi,
  truncateDiagnostic,
  truncateVisible,
} from "../extensions/lib/realtime-text.js";

const ESC = "\x1b";

test("stripAnsi removes CSI color/style sequences", () => {
  assert.equal(stripAnsi(`${ESC}[31mred${ESC}[0m`), "red");
  assert.equal(stripAnsi(`${ESC}[1m${ESC}[32mok${ESC}[0m`), "ok");
  assert.equal(stripAnsi("plain"), "plain");
  assert.equal(stripAnsi(""), "");
});

test("truncateDiagnostic collapses whitespace and ellipsizes past the limit", () => {
  assert.equal(truncateDiagnostic("  a\n\n b   c  "), "a b c");
  assert.equal(truncateDiagnostic(null), "");
  // strict comparison: length exactly at the limit is not truncated.
  assert.equal(truncateDiagnostic("abc", 3), "abc");
  assert.equal(truncateDiagnostic("abcdef", 3), "abc…");
});

test("truncateVisible counts visible width, ignoring ANSI escapes", () => {
  // plain string within width is unchanged.
  assert.equal(truncateVisible("hello", 10), "hello");
  // an ANSI-wrapped string whose VISIBLE width fits is returned untouched,
  // even though its raw length exceeds the width.
  const wrapped = `${ESC}[31mhello${ESC}[0m`;
  assert.ok(wrapped.length > 10);
  assert.equal(truncateVisible(wrapped, 10), wrapped);
});

test("truncateVisible truncates to plain text with an ellipsis when over width", () => {
  assert.equal(truncateVisible("hello world", 5), "hell…");
  // ANSI is dropped once truncation happens.
  assert.equal(truncateVisible(`${ESC}[31mhelloworld${ESC}[0m`, 5), "hell…");
  // width 0 leaves only the ellipsis.
  assert.equal(truncateVisible("abc", 0), "…");
});

test("isAuthFailure detects auth-related error text", () => {
  for (const t of [
    "HTTP 401",
    "Error 403 Forbidden",
    "Unauthorized",
    "invalid_api_key",
    "invalid api key",
    "incorrect api key",
    "authentication failed",
    "permission denied",
  ]) {
    assert.equal(isAuthFailure(t), true, `expected auth failure: ${t}`);
  }
  for (const t of ["connection established", "200 OK", "", null]) {
    assert.equal(isAuthFailure(t), false, `expected no auth failure: ${t}`);
  }
});

test("isMicPermissionFailure detects mic/permission and OS-level audio errors", () => {
  for (const t of [
    "coreaudio: permission denied",
    "microphone access was denied",
    "avfoundation input device not authorized",
    "EACCES",
    "Operation not permitted",
    "Input/output error",
  ]) {
    assert.equal(isMicPermissionFailure(t), true, `expected mic failure: ${t}`);
  }
  for (const t of ["audio stream started", "401 unauthorized", "", null]) {
    assert.equal(isMicPermissionFailure(t), false, `expected no mic failure: ${t}`);
  }
});
