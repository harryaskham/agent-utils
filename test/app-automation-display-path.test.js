// Direct unit tests for the app-automation display-path.js path-redaction
// helper (bd-76e0f4). Regression net for the actual behavior; no source
// changes. HOME is overridden to a sentinel and restored so the home-redaction
// cases are deterministic regardless of the runner's environment.

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { displayPath } from "../extensions/app-automation/display-path.js";

const HOME_SENTINEL = "/home/display-path-sentinel";
let savedHome;

beforeEach(() => {
  savedHome = process.env.HOME;
  process.env.HOME = HOME_SENTINEL;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
});

test("displayPath: empty / nullish input returns an empty string", () => {
  assert.equal(displayPath(""), "");
  assert.equal(displayPath(null), "");
  assert.equal(displayPath(undefined), "");
  assert.equal(displayPath("   "), "");
});

test("displayPath: paths under root render as [state-root]/rel", () => {
  assert.equal(displayPath("/srv/state/a/b", { root: "/srv/state" }), "[state-root]/a/b");
  assert.equal(displayPath("/srv/state", { root: "/srv/state" }), "[state-root]");
});

test("displayPath: a custom rootLabel is honored", () => {
  assert.equal(displayPath("/srv/state/x", { root: "/srv/state", rootLabel: "[R]" }), "[R]/x");
});

test("displayPath: paths under HOME render as ~/rel", () => {
  assert.equal(displayPath(`${HOME_SENTINEL}/docs/file.txt`), "~/docs/file.txt");
  assert.equal(displayPath(HOME_SENTINEL), "~");
});

test("displayPath: root takes precedence over HOME when root is itself under HOME", () => {
  const root = `${HOME_SENTINEL}/state`;
  assert.equal(displayPath(`${root}/x`, { root }), "[state-root]/x");
});

test("displayPath: other absolute paths are redacted to [local-path]", () => {
  assert.equal(displayPath("/etc/hosts"), "[local-path]");
  assert.equal(displayPath("/var/log/syslog", { root: "/srv/state" }), "[local-path]");
});

test("displayPath: relative paths pass through unchanged", () => {
  assert.equal(displayPath("foo/bar"), "foo/bar");
  assert.equal(displayPath("notes.txt"), "notes.txt");
});
