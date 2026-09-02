import assert from "node:assert/strict";
import test from "node:test";

import { openMacosAppOnAlternateDisplay, selectAlternateDisplay } from "../extensions/lib/macos-native.js";

const displays = [
  { x: 0, y: 0, width: 1000, height: 800 },
  { x: 1000, y: 50, width: 800, height: 600 },
];

test("alternate display selection avoids the display containing focused-window center", () => {
  assert.equal(selectAlternateDisplay(displays, { x: 20, y: 20, width: 400, height: 300 }), displays[1]);
  assert.equal(selectAlternateDisplay(displays, { x: 1100, y: 100, width: 300, height: 300 }), displays[0]);
  assert.equal(selectAlternateDisplay([displays[0]], { x: 0, y: 0, width: 1, height: 1 }), null);
});

test("macOS app opener validates bundles before invoking native automation", async () => {
  await assert.rejects(() => openMacosAppOnAlternateDisplay("/tmp/not-an-app"), /\.app bundle/);
});

test("package advertises the macOS native extension", async () => {
  const pkg = await import("../package.json", { with: { type: "json" } });
  assert.ok(pkg.default.pi.extensions.includes("./extensions/macos-native.js"));
});
