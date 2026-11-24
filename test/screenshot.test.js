import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import screenshotExtension, { deliverScreenshot } from "../extensions/screenshot.js";
import { HOST_NOT_INSTALLED, optionalHostModule } from "./helpers/pi-host.js";
import {
  captureScreenshot,
  normalizeScreenshotSend,
  parseScreenshotArgs,
  screenshotPath,
  planScreenshot,
  prepareScreenshotImage,
  screenshotContent,
  screenshotDisplay,
  screenshotSettings,
} from "../extensions/lib/screenshot.js";

// A 1×1 PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const tools = (...names) => async (name) => names.includes(name);

test("/screenshot arguments: mode, delay, send and the text for the agent", () => {
  assert.deepEqual(parseScreenshotArgs(""), { kind: "capture", mode: "region", delaySeconds: 0, text: "" });
  assert.deepEqual(parseScreenshotArgs("full"), { kind: "capture", mode: "full", delaySeconds: 0, text: "" });
  assert.deepEqual(parseScreenshotArgs("full delay=3 send=followup why is this red?"), {
    kind: "capture", mode: "full", delaySeconds: 3, send: "followUp", text: "why is this red?",
  });
  // Words after the text starts are the text, even when they look like options.
  assert.equal(parseScreenshotArgs("what does full mean here").text, "what does full mean here");
  assert.equal(parseScreenshotArgs("region look at full=1").text, "look at full=1");
  assert.deepEqual(parseScreenshotArgs("status"), { kind: "status" });
  assert.throws(() => parseScreenshotArgs("delay=999"), /delay must be/);
  assert.throws(() => parseScreenshotArgs("send=later"), /send must be/);
  assert.equal(normalizeScreenshotSend("follow-up"), "followUp");
  assert.equal(normalizeScreenshotSend("STEER"), "steer");
});

test("the system's own tool directories are searched after PATH (macOS keeps screencapture in /usr/sbin)", () => {
  assert.equal(screenshotPath({ PATH: "/nix/bin:/usr/bin" }), "/nix/bin:/usr/bin:/usr/sbin:/sbin:/bin:/run/current-system/sw/bin");
});

test("the display decides the tools: macOS, Wayland, X11, Android, none", () => {
  assert.equal(screenshotDisplay({ platform: "darwin", env: {} }), "macos");
  assert.equal(screenshotDisplay({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" } }), "wayland");
  assert.equal(screenshotDisplay({ platform: "linux", env: { DISPLAY: ":0" } }), "x11");
  assert.equal(screenshotDisplay({ platform: "linux", env: { ANDROID_ROOT: "/system" } }), "android");
  assert.equal(screenshotDisplay({ platform: "linux", env: {} }), "none");
});

test("each platform's own picker, in order of preference", async () => {
  const plan = (mode, platform, env, has, settings = screenshotSettings({})) => planScreenshot(mode, "/tmp/out.png", { platform, env, has, settings });

  assert.deepEqual(await plan("region", "darwin", {}, tools("screencapture")), { backend: "macos", command: "screencapture", args: ["-i", "-x", "/tmp/out.png"] });
  assert.deepEqual(await plan("full", "darwin", {}, tools("screencapture")), { backend: "macos", command: "screencapture", args: ["-x", "/tmp/out.png"] });

  const wayland = { WAYLAND_DISPLAY: "wayland-1", DISPLAY: ":0" };
  const grim = await plan("region", "linux", wayland, tools("grim", "slurp", "maim"));
  assert.equal(grim.backend, "grim");
  assert.match(grim.args[1], /slurp/);
  assert.deepEqual(await plan("full", "linux", wayland, tools("grim", "slurp")), { backend: "grim", command: "grim", args: ["/tmp/out.png"] });
  // grim without slurp cannot pick; X11's maim cannot see Wayland windows.
  assert.equal((await plan("region", "linux", wayland, tools("grim", "maim", "spectacle"))).backend, "spectacle");
  await assert.rejects(plan("region", "linux", wayland, tools("maim")), /no screenshot tool found for wayland.*agentUtils\.screenshot\.region/);

  const x11 = { DISPLAY: ":0" };
  assert.deepEqual(await plan("region", "linux", x11, tools("maim", "import")), { backend: "maim", command: "maim", args: ["-s", "/tmp/out.png"] });
  assert.deepEqual(await plan("full", "linux", x11, tools("import")), { backend: "import", command: "import", args: ["-window", "root", "/tmp/out.png"] });
  assert.equal((await plan("region", "linux", x11, tools("flameshot", "scrot"))).backend, "flameshot");

  await assert.rejects(plan("region", "linux", { ANDROID_ROOT: "/system" }, tools()), /Android.*adb exec-out screencap/);
  await assert.rejects(plan("full", "linux", {}, tools("maim")), /no display here/);
});

test("settings name a command for anything else, or pick the backend", async () => {
  const settings = screenshotSettings({ agentUtils: { screenshot: { full: "adb exec-out screencap -p > {file}", backend: "flameshot", send: "followup" } } });
  assert.equal(settings.send, "followUp");
  const full = await planScreenshot("full", "/tmp/out.png", { platform: "linux", env: { ANDROID_ROOT: "/system" }, has: tools(), settings });
  assert.deepEqual(full, { backend: "settings", command: "sh", args: ["-c", 'adb exec-out screencap -p > "$1"', "sh", "/tmp/out.png"] });
  const region = await planScreenshot("region", "/tmp/out.png", { platform: "linux", env: { DISPLAY: ":0" }, has: tools("flameshot", "maim"), settings });
  assert.equal(region.backend, "flameshot");
  await assert.rejects(
    planScreenshot("region", "/tmp/out.png", { platform: "linux", env: { DISPLAY: ":0" }, has: tools("maim"), settings }),
    /backend flameshot needs flameshot/,
  );
  await assert.rejects(
    planScreenshot("region", "/tmp/out.png", { platform: "linux", env: {}, has: tools(), settings: screenshotSettings({ agentUtils: { screenshot: { backend: "paint" } } }) }),
    /is not one of/,
  );
  assert.equal(screenshotSettings({ agentUtils: { screenshot: { backend: "auto" } } }).backend, undefined);
  assert.equal(screenshotSettings({}).send, "steer");
});

test("capture: the picker's image, a cancel, a failed full capture, and no file left behind", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "screenshot-test-"));
  try {
    const darwin = { platform: "darwin", env: { PATH: "" }, has: tools("screencapture"), settings: screenshotSettings({}), tmp };
    const writes = (bytes) => async ({ args, spawnOptions }) => {
      assert.equal(spawnOptions.env.PI_SCREENSHOT_FILE, args.at(-1));
      if (bytes) await writeFile(args.at(-1), bytes);
      return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    };
    let waited = 0;
    const shot = await captureScreenshot("full", { ...darwin, delaySeconds: 2, wait: async (ms) => { waited = ms; }, run: writes(PNG) });
    assert.equal(waited, 2000);
    assert.equal(shot.cancelled, false);
    assert.equal(shot.mimeType, "image/png");
    assert.deepEqual(shot.bytes, PNG);

    // Escape in the picker writes nothing: a cancel, not an error.
    assert.deepEqual(await captureScreenshot("region", { ...darwin, run: writes(undefined) }), { cancelled: true, backend: "macos" });
    // A full capture that writes nothing is an error with what the tool said.
    await assert.rejects(
      captureScreenshot("full", { ...darwin, run: async () => ({ code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("could not create image from display") }) }),
      /macos wrote no image \(exit 1\): could not create image from display/,
    );
    assert.deepEqual(readdirSync(tmp), [], "each capture's temporary directory is removed");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("capture end to end through a real shell and a configured command", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "screenshot-e2e-"));
  try {
    const source = path.join(tmp, "source.png");
    await writeFile(source, PNG);
    const settings = screenshotSettings({ agentUtils: { screenshot: { region: `cp '${source}' {file}` } } });
    const shot = await captureScreenshot("region", { settings, platform: "linux", env: process.env, tmp });
    assert.equal(shot.backend, "settings");
    assert.deepEqual(shot.bytes, PNG);
    // A configured picker that exits without writing (Escape) is a cancel.
    const cancelled = await captureScreenshot("region", { settings: screenshotSettings({ agentUtils: { screenshot: { region: "exit 1" } } }), platform: "linux", env: process.env, tmp });
    assert.equal(cancelled.cancelled, true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

// Pi's own package is there on a machine with Pi installed beside this repository, not on a CI runner (which
// installs none): the test of the real resizer is skipped there, as the other tests of the real host are (bd-096f6e).
const piSdk = await optionalHostModule("@earendil-works/pi-coding-agent");

test("Pi's real resizer leaves a small image as it is, with no note", { skip: !piSdk && HOST_NOT_INSTALLED }, async () => {
  const real = await prepareScreenshotImage(PNG, "image/png");
  assert.equal(real.mimeType, "image/png");
  assert.equal(real.width, 1);
  assert.equal(real.note, undefined);
});

test("the image is sized by Pi's own resizer, with its scale note", async () => {
  const calls = [];
  const fakePi = {
    resizeImage: async (bytes, mimeType, options) => {
      calls.push({ size: bytes.length, mimeType, options });
      return { data: "c21hbGw=", mimeType: "image/jpeg", originalWidth: 4000, originalHeight: 2000, width: 2000, height: 1000, wasResized: true };
    },
    formatDimensionNote: (resized) => `[Image: original ${resized.originalWidth}x${resized.originalHeight}, displayed at ${resized.width}x${resized.height}.]`,
  };
  const image = await prepareScreenshotImage(PNG, "image/png", { maxWidth: 1600, loadPi: async () => fakePi });
  assert.deepEqual(calls, [{ size: PNG.length, mimeType: "image/png", options: { maxWidth: 1600 } }]);
  assert.deepEqual(image, { data: "c21hbGw=", mimeType: "image/jpeg", width: 2000, height: 1000, note: "[Image: original 4000x2000, displayed at 2000x1000.]" });

  // Without Pi's resizer the image goes as it is.
  assert.deepEqual(await prepareScreenshotImage(PNG, "image/png", { loadPi: async () => { throw new Error("no pi"); } }), { data: PNG.toString("base64"), mimeType: "image/png" });


  assert.deepEqual(screenshotContent({ data: "AA==", mimeType: "image/png", note: "[scaled]" }, { mode: "full" }), [
    { type: "text", text: "Screenshot of my screen.\n[scaled]" },
    { type: "image", data: "AA==", mimeType: "image/png" },
  ]);
  assert.equal(screenshotContent({ data: "AA==", mimeType: "image/png" }, { text: "why?" })[0].text, "why?");
});

function harness({ chord = false, idle = true, shot, settings = {} } = {}) {
  const commands = new Map();
  const sent = [];
  const notes = [];
  const chordCalls = [];
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    sendUserMessage(content, options) { sent.push({ content, options }); },
  };
  const pane = {
    isIdle: () => idle,
    ui: { notify: (message, level) => notes.push({ pane: "pinned", message, level }) },
    ...(chord ? { chord: { call: async (method, params) => { chordCalls.push({ method, params }); return { submissionId: 1 }; } } } : {}),
  };
  const ctx = chord
    ? { pinned: () => pane, isIdle: () => idle, ui: { notify: (message, level) => notes.push({ pane: "focused", message, level }) } }
    : pane;
  const captured = [];
  screenshotExtension(pi, {
    readSettings: () => settings,
    capture: async (mode, options) => { captured.push({ mode, ...options }); return shot ?? { cancelled: false, backend: "macos", bytes: PNG, mimeType: "image/png" }; },
    prepare: async (bytes, mimeType) => ({ data: bytes.toString("base64"), mimeType, width: 1, height: 1 }),
  });
  return { command: commands.get("screenshot"), ctx, sent, notes, chordCalls, captured };
}

test("TUI Pi: the screenshot is a user message, a follow-up or steer while the agent works", async () => {
  const idle = harness();
  await idle.command.handler("full what is this?", idle.ctx);
  assert.equal(idle.captured[0].mode, "full");
  assert.deepEqual(idle.sent, [{ content: [{ type: "text", text: "what is this?" }, { type: "image", data: PNG.toString("base64"), mimeType: "image/png" }], options: undefined }]);
  assert.match(idle.notes.at(-1).message, /Screenshot sent 1×1 \(macos\)/);

  const busy = harness({ idle: false, settings: { agentUtils: { screenshot: { send: "followup" } } } });
  await busy.command.handler("", busy.ctx);
  assert.deepEqual(busy.sent[0].options, { deliverAs: "followUp" });
  await busy.command.handler("send=steer", busy.ctx);
  assert.deepEqual(busy.sent[1].options, { deliverAs: "steer" });
});

test("pi-client: the screenshot goes to the pane it was asked in, over /chord, with its image", async () => {
  const client = harness({ chord: true, idle: false });
  await client.command.handler("look", client.ctx);
  assert.equal(client.sent.length, 0, "pi-client's sendUserMessage would drop the image");
  assert.equal(client.chordCalls.length, 1);
  const { method, params } = client.chordCalls[0];
  assert.equal(method, "conversation.submit");
  assert.match(params.requestId, /^screenshot-/);
  assert.equal(params.whenBusy, "steer");
  assert.deepEqual(params.content.map((block) => block.type), ["text", "image"]);
  assert.ok(client.notes.every((note) => note.pane === "pinned"), "notices go to the pane that asked");

  const idle = { chord: { call: async (method, params) => { idle.calls.push(params); } }, isIdle: () => true, calls: [] };
  await deliverScreenshot({}, idle, [{ type: "text", text: "x" }], "followUp");
  assert.equal(idle.calls[0].whenBusy, undefined, "an idle session takes it as a prompt");
});

test("a cancelled picker sends nothing; status says which tool each mode uses", async () => {
  const cancelled = harness({ shot: { cancelled: true, backend: "macos" } });
  await cancelled.command.handler("", cancelled.ctx);
  assert.equal(cancelled.sent.length, 0);
  assert.equal(cancelled.notes.at(-1).message, "Screenshot cancelled.");

  const status = harness({ settings: { agentUtils: { screenshot: { region: "my-picker {file}", full: "my-full {file}" } } } });
  await status.command.handler("status", status.ctx);
  const message = status.notes.at(-1).message;
  assert.match(message, /region: settings · sh -c my-picker "\$1" sh \{file\}/);
  assert.match(message, /full: settings · sh -c my-full/);
  assert.deepEqual(status.command.getArgumentCompletions("f").map((item) => item.value), ["full"]);
  assert.deepEqual(status.command.getArgumentCompletions("send=").map((item) => item.value), ["send=steer", "send=followup"]);
  assert.equal(existsSync("{file}"), false);
});
