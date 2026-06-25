// Direct unit tests for the kitty-image-preview session-paths.js resolvers
// (bd-061993). Regression net for the actual behavior; no source changes.
// KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR is saved/restored so the env branch is
// deterministic, and assertions are built from os.tmpdir()/path.join so they
// stay host-portable.

import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  getSessionScreenshotDir,
  buildScreenshotOutputPath,
  sessionTempId,
  getStreamDir,
  getDescribeTempDir,
} from "../extensions/kitty-image-preview/session-paths.js";

const ENV_KEY = "KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR";
let savedEnv;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

const ctxWithSession = (sessionFile, cwd = "/work") => ({
  cwd,
  sessionManager: { getSessionFile: () => sessionFile },
});

test("getSessionScreenshotDir: explicit outputDir wins (absolute and relative-to-cwd)", () => {
  assert.equal(getSessionScreenshotDir(ctxWithSession("/s/a.jsonl"), "/abs/out"), "/abs/out");
  assert.equal(getSessionScreenshotDir(ctxWithSession("/s/a.jsonl"), "shots"), path.resolve("/work", "shots"));
});

test("getSessionScreenshotDir: env override is used when no outputDir is given", () => {
  process.env[ENV_KEY] = "/env/shots";
  assert.equal(getSessionScreenshotDir(ctxWithSession("/s/a.jsonl")), "/env/shots");
});

test("getSessionScreenshotDir: derives a dir from the session file basename", () => {
  assert.equal(
    getSessionScreenshotDir(ctxWithSession("/sessions/my.session.jsonl")),
    path.join("/sessions", "kitty-image-preview-screenshots", "my.session"),
  );
});

test("getSessionScreenshotDir: falls back to a tmpdir/pid path with no session", () => {
  const dir = getSessionScreenshotDir({ cwd: "/work" });
  assert.equal(dir, path.join(os.tmpdir(), "pi-kitty-image-preview", `pid-${process.pid}`));
});

test("buildScreenshotOutputPath: explicit filename is sanitized and .png-suffixed", () => {
  const { dir, path: out } = buildScreenshotOutputPath(
    { cwd: "/work" },
    { outputDir: "/out", filename: "shot.png" },
    { kind: "display", id: "d1" },
  );
  assert.equal(dir, "/out");
  assert.equal(out, path.join("/out", "shot.png"));
});

test("buildScreenshotOutputPath: default filename is timestamp-kind-id", () => {
  const date = new Date("2020-01-02T03:04:05.006Z");
  const { path: out } = buildScreenshotOutputPath(
    { cwd: "/work" },
    { outputDir: "/out" },
    { kind: "window", id: "w 7" },
    date,
  );
  // ':' and '.' -> '-' in the timestamp; the space in the id -> '-' via sanitize.
  assert.equal(out, path.join("/out", "2020-01-02T03-04-05-006Z-window-w-7.png"));
});

test("sessionTempId: sanitized session basename, or pid fallback", () => {
  assert.equal(sessionTempId(ctxWithSession("/s/abc.jsonl")), "abc");
  assert.equal(sessionTempId(ctxWithSession("/s/x.json")), "x"); // .jsonl? matches .json too
  assert.equal(sessionTempId({ cwd: "/work" }), `pid-${process.pid}`);
});

test("getStreamDir / getDescribeTempDir: tmpdir namespaced by sessionTempId", () => {
  const ctx = ctxWithSession("/s/abc.jsonl");
  assert.equal(getStreamDir(ctx), path.join(os.tmpdir(), "pi-kitty-image-preview-stream", "abc"));
  assert.equal(getDescribeTempDir(ctx), path.join(os.tmpdir(), "pi-kitty-image-preview-describe", "abc"));
});
