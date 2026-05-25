import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import androidCliExtension from "../extensions/android.js";

function makeHarness() {
  const tools = new Map();
  const commands = new Map();
  const notifications = [];
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
  };
  const ctx = { cwd: process.cwd(), ui: { notify(message, type) { notifications.push({ message, type }); } } };
  androidCliExtension(pi);
  return { tools, commands, notifications, ctx };
}

test("android extension registers install, update, doctor, screenshot, and stream tools", () => {
  const { tools, commands } = makeHarness();
  for (const name of [
    "android_cli_doctor",
    "android_cli_help",
    "android_cli_install",
    "android_cli_update",
    "android_emulator_screenshot",
    "android_emulator_stream",
  ]) {
    assert.ok(tools.has(name), `${name} should be registered`);
  }
  assert.ok(commands.has("android"));
});

test("android install and update tools are dry-run unless confirmed", async () => {
  const { tools } = makeHarness();
  const install = await tools.get("android_cli_install").execute("call-1", {}, null, null, { cwd: process.cwd() });
  assert.match(install.content[0].text, /curl -fsSL https:\/\/dl\.google\.com\/android\/cli\/latest\/linux_x86_64\/install\.sh \| bash/);
  assert.equal(install.details.dryRun, true);

  const update = await tools.get("android_cli_update").execute("call-2", {}, null, null, { cwd: process.cwd() });
  assert.match(update.content[0].text, /Dry run only/);
  assert.equal(update.details.dryRun, true);
});

test("android help advertises screenshot stream and kitty preview handoff", async () => {
  const { tools } = makeHarness();
  const result = await tools.get("android_cli_help").execute("call-1", {}, null, null, { cwd: process.cwd() });
  const text = result.content[0].text;
  assert.match(text, /android_emulator_screenshot/);
  assert.match(text, /android_emulator_stream/);
  assert.match(text, /kitty_image_preview_add/);
});

test("package.json advertises android extension and packaged android skill docs", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("android"));
  assert.ok(pkg.pi.extensions.includes("./extensions/android.js"));
  const skill = await readFile(new URL("../android/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /android_cli_doctor/);
  assert.match(skill, /adb exec-out screencap -p/);
});
