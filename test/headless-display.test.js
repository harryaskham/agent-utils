import assert from "node:assert/strict";
import test from "node:test";

import {
  detectHeadlessDisplay,
  headlessDisplaySummary,
  DISPLAY_NATIVE,
  DISPLAY_WSLG,
  DISPLAY_HEADLESS,
} from "../extensions/lib/headless-display.js";

test("macOS is always treated as having a display regardless of env", () => {
  const info = detectHeadlessDisplay({ env: {}, platform: "darwin" });
  assert.equal(info.kind, DISPLAY_NATIVE);
  assert.equal(info.hasDisplay, true);
  assert.match(info.hint, /macOS/);
});

test("windows is treated as having a display", () => {
  const info = detectHeadlessDisplay({ env: {}, platform: "win32" });
  assert.equal(info.kind, DISPLAY_NATIVE);
  assert.equal(info.hasDisplay, true);
});

test("linux with DISPLAY set is native-display", () => {
  const info = detectHeadlessDisplay({ env: { DISPLAY: ":0" }, platform: "linux" });
  assert.equal(info.kind, DISPLAY_NATIVE);
  assert.equal(info.hasDisplay, true);
  assert.equal(info.display, ":0");
  assert.equal(info.isWslg, false);
});

test("linux with only WAYLAND_DISPLAY (native wayland, no WSL markers) is native-display", () => {
  const info = detectHeadlessDisplay({ env: { WAYLAND_DISPLAY: "wayland-0" }, platform: "linux" });
  assert.equal(info.kind, DISPLAY_NATIVE);
  assert.equal(info.hasDisplay, true);
  assert.equal(info.isWslg, false);
});

test("WSLg detected via XDG_RUNTIME_DIR under /mnt/wslg", () => {
  const info = detectHeadlessDisplay({
    env: { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/mnt/wslg/runtime-dir" },
    platform: "linux",
  });
  assert.equal(info.kind, DISPLAY_WSLG);
  assert.equal(info.hasDisplay, true);
  assert.equal(info.isWslg, true);
  assert.match(info.hint, /WSLg/);
});

test("WSLg detected via WSL_DISTRO_NAME plus WAYLAND_DISPLAY", () => {
  const info = detectHeadlessDisplay({
    env: { WAYLAND_DISPLAY: "wayland-0", WSL_DISTRO_NAME: "Ubuntu" },
    platform: "linux",
  });
  assert.equal(info.kind, DISPLAY_WSLG);
  assert.equal(info.isWslg, true);
});

test("WSL markers without any wayland display are NOT classified as wslg", () => {
  // No WAYLAND_DISPLAY and no DISPLAY -> still headless even under WSL.
  const info = detectHeadlessDisplay({ env: { WSL_DISTRO_NAME: "Ubuntu" }, platform: "linux" });
  assert.equal(info.kind, DISPLAY_HEADLESS);
  assert.equal(info.hasDisplay, false);
});

test("linux with no display env is headless and gives an Xvfb remediation hint", () => {
  const info = detectHeadlessDisplay({ env: {}, platform: "linux" });
  assert.equal(info.kind, DISPLAY_HEADLESS);
  assert.equal(info.hasDisplay, false);
  assert.equal(info.display, "");
  assert.match(info.hint, /Xvfb/);
  assert.match(info.hint, /DISPLAY=:99/);
});

test("empty / whitespace DISPLAY is treated as unset", () => {
  const info = detectHeadlessDisplay({ env: { DISPLAY: "   " }, platform: "linux" });
  assert.equal(info.kind, DISPLAY_HEADLESS);
  assert.equal(info.hasDisplay, false);
});

test("headlessDisplaySummary formats available and missing states", () => {
  const native = headlessDisplaySummary(detectHeadlessDisplay({ env: { DISPLAY: ":0" }, platform: "linux" }));
  assert.match(native, /display available/);
  assert.match(native, /DISPLAY=:0/);

  const headless = headlessDisplaySummary(detectHeadlessDisplay({ env: {}, platform: "linux" }));
  assert.match(headless, /display MISSING/);
  assert.match(headless, /no DISPLAY\/WAYLAND_DISPLAY/);
  assert.match(headless, /Xvfb/);
});
