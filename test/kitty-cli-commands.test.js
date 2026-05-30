import test from "node:test";
import assert from "node:assert/strict";

import {
  buildTendrilCaptureArgs,
  buildPlaywrightCliScreenshotArgs,
  buildPlaywrightCliScreenshotCommand,
} from "../extensions/kitty-image-preview/cli-commands.js";

test("buildTendrilCaptureArgs builds minimal window-capture argv with default timeout", () => {
  const args = buildTendrilCaptureArgs({}, { kind: "window", id: 5 }, "/out.png");
  assert.deepEqual(args, [
    "capture",
    "--json",
    "--format",
    "png",
    "--output",
    "/out.png",
    "--timeout-ms",
    "30000",
    "--window",
    "5",
  ]);
});

test("buildTendrilCaptureArgs uses the display flag, clamps timeout/sizes, and appends optional flags", () => {
  const args = buildTendrilCaptureArgs(
    { timeoutMs: 500, maxWidth: 99_999_999, maxHeight: 0, compression: "6" },
    { kind: "display", id: "D1" },
    "/out.png",
  );
  assert.deepEqual(args, [
    "capture",
    "--json",
    "--format",
    "png",
    "--output",
    "/out.png",
    "--timeout-ms",
    "1000", // clamped up to the 1000ms floor
    "--display",
    "D1",
    "--max-width",
    "100000", // clamped down to the 100000 ceiling
    "--max-height",
    "1", // 0 is defined, clamps up to the min of 1
    "--compression",
    "6",
  ]);
});

test("buildTendrilCaptureArgs omits size/compression flags when not provided", () => {
  const args = buildTendrilCaptureArgs({ maxWidth: 640 }, { kind: "window", id: 1 }, "/o.png");
  assert.ok(args.includes("--max-width"));
  assert.ok(!args.includes("--max-height"));
  assert.ok(!args.includes("--compression"));
});

test("buildPlaywrightCliScreenshotArgs builds minimal argv", () => {
  assert.deepEqual(buildPlaywrightCliScreenshotArgs({}, "/s.png"), [
    "screenshot",
    "--filename",
    "/s.png",
  ]);
});

test("buildPlaywrightCliScreenshotArgs adds session, ref, and full-page toggles", () => {
  assert.deepEqual(
    buildPlaywrightCliScreenshotArgs({ session: "main", ref: "e3", fullPage: true }, "/s.png"),
    ["-s=main", "screenshot", "e3", "--filename", "/s.png", "--full-page"],
  );
  // fullPage only triggers on strict true.
  assert.ok(!buildPlaywrightCliScreenshotArgs({ fullPage: false }, "/s.png").includes("--full-page"));
  assert.ok(!buildPlaywrightCliScreenshotArgs({ fullPage: "yes" }, "/s.png").includes("--full-page"));
});

test("buildPlaywrightCliScreenshotCommand shell-quotes its arguments", () => {
  assert.equal(
    buildPlaywrightCliScreenshotCommand({}, "/s.png"),
    "playwright-cli screenshot --filename '/s.png'",
  );
  assert.equal(
    buildPlaywrightCliScreenshotCommand({ session: "main", ref: "e3", fullPage: true }, "/a b.png"),
    "playwright-cli -s='main' screenshot 'e3' --filename '/a b.png' --full-page",
  );
  // embedded single quotes are escaped.
  assert.equal(
    buildPlaywrightCliScreenshotCommand({ ref: "it's" }, "/s.png"),
    "playwright-cli screenshot 'it'\\''s' --filename '/s.png'",
  );
});
