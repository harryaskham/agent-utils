// Durable media adaptor tests (bd-647b05).
//
// A fake pi-daemon host implements the Durable tool contract the adaptor
// relies on: `execute(args, api, context)` with `api.callId`,
// `api.conversationId` and `api.env` (cwd + exec), and AHP-MEDIA's handling of
// `details.media` (each item a path or base64 data with a mimeType; the model
// sees only the content). Archives go to temporary roots; capture runs against
// a fake Tendril; playback against a stub player.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDurableMedia, durableEnvExec, normalizeBase64, DEFAULT_CAPTURE_MAX_WIDTH } from "../extensions/lib/durable-media.js";
import { parseWavHeader } from "../extensions/lib/shared-audio.js";

const tmp = mkdtempSync(join(tmpdir(), "durable-media-"));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixture-png-body")]);
const JPEG = Buffer.concat([Buffer.from([255, 216, 255, 224]), Buffer.from("fixture-jpeg")]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(64, 1)]);

let counter = 0;
function fixture() {
  const root = join(tmp, `case-${++counter}`);
  const cwd = join(root, "work");
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    PI_SHARED_IMAGES_DIR: join(root, "images"),
    PI_SHARED_AUDIO_DIR: join(root, "audio"),
    CACO_AGENT_NAME: "durable-test-agent",
    CACO_NODE: "test-host",
  };
  mkdirSync(cwd, { recursive: true });
  return { root, cwd, env };
}

/** The pi-daemon side of AHP-MEDIA: store each item, keep only the text for the model. */
function hostShare(result, cwd) {
  const shared = [];
  for (const item of result.details?.media ?? []) {
    assert.equal(typeof item.mimeType, "string");
    assert.ok((typeof item.path === "string") !== (typeof item.data === "string"), "an item is a path or data");
    const bytes = item.data !== undefined ? Buffer.from(item.data, "base64") : readFileSync(isAbsolute(item.path) ? item.path : join(cwd, item.path));
    shared.push({ ...item, bytes });
  }
  const modelText = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
  const images = result.content.filter((block) => block.type === "image");
  return { shared, modelText, images };
}

function api(cwd, extra = {}) {
  return { callId: `call-${++counter}`, conversationId: "conv-1", env: { cwd }, ...extra };
}

function tool(media, name) {
  const found = media.extension.tools.find((candidate) => candidate.name === name);
  assert.ok(found, `tool ${name}`);
  return found;
}

function sidecar(receipt) {
  return JSON.parse(readFileSync(`${receipt.path}.json`, "utf8"));
}

test("the module exports a Durable extension with plain JSON-schema tools", async () => {
  const module = await import("../extensions/durable/media.mjs");
  assert.equal(module.extension.name, "agent-utils-media");
  assert.deepEqual(module.extension.tools.map((t) => t.name), ["image_share", "audio_share", "tendril_capture"]);
  for (const t of module.extension.tools) {
    assert.equal(t.parameters.type, "object");
    assert.equal(typeof t.description, "string");
    assert.equal(typeof t.execute, "function");
  }
});

test("the module graph imports only relative modules and Node built-ins", () => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']/gm)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("."), `${file} imports ${specifier}`);
      visit(resolve(dirname(file), specifier));
    }
  };
  visit(fileURLToPath(new URL("../extensions/durable/media.mjs", import.meta.url)));
  assert.ok(seen.size > 3);
  for (const file of seen) assert.doesNotMatch(file, /kitty-image-preview|tendril-share\.js|audio-reel\.js$/);
});

test("image_share shares a file as details.media and writes the archive receipt", async () => {
  const { cwd, env } = fixture();
  writeFileSync(join(cwd, "chart.png"), PNG);
  const media = createDurableMedia({ env });
  const result = await tool(media, "image_share").execute({ path: "chart.png", description: "Weekly totals" }, api(cwd));
  assert.deepEqual(result.details.media, [{ path: join(cwd, "chart.png"), mimeType: "image/png", title: "chart.png", description: "Weekly totals" }]);
  const { shared, modelText, images } = hostShare(result, cwd);
  assert.deepEqual(shared[0].bytes, PNG);
  assert.equal(images.length, 0, "the model does not receive the image");
  assert.match(modelText, /Shared image "chart\.png" \(image\/png, 24 B\) with the operator\./);
  assert.match(modelText, /Archived as durable-test-agent\/img-[0-9a-f]+\.png/);
  const receipts = result.details.sharedImages;
  assert.equal(receipts.count, 1);
  assert.deepEqual(readFileSync(receipts.stored[0].path), PNG);
  const meta = sidecar(receipts.stored[0]);
  assert.equal(meta.source.tool, "image_share");
  assert.match(meta.session, new RegExp(`^${basename(cwd)}-[0-9a-f]{8}:conv-1$`));
  assert.equal(meta.host, "test-host");
  assert.equal(meta.source.path, join(cwd, "chart.png"));
});

test("without an agent name, shares are filed per session directory, not one session-1 folder", async () => {
  const { cwd, env } = fixture();
  delete env.CACO_AGENT_NAME;
  writeFileSync(join(cwd, "chart.png"), PNG);
  const media = createDurableMedia({ env });
  // Every pi-daemon session's root chat is conversation "1".
  const result = await tool(media, "image_share").execute({ path: "chart.png" }, { ...api(cwd), conversationId: "1" });
  const meta = sidecar(result.details.sharedImages.stored[0]);
  assert.equal(meta.agent, `pi-daemon-${basename(cwd)}`);
  assert.match(meta.session, new RegExp(`^${basename(cwd)}-[0-9a-f]{8}:1$`));
  assert.equal(meta.cwd, cwd);
});

test("image_share shares base64 and data: URLs, sniffing the type", async () => {
  const { cwd, env } = fixture();
  const media = createDurableMedia({ env });
  const share = tool(media, "image_share");
  const url = await share.execute({ data: `data:image/jpeg;base64,${JPEG.toString("base64")}`, title: "Photo" }, api(cwd));
  assert.equal(url.details.media[0].mimeType, "image/jpeg");
  assert.equal(url.details.media[0].title, "Photo");
  assert.deepEqual(hostShare(url, cwd).shared[0].bytes, JPEG);
  const plain = await share.execute({ data: PNG.toString("base64url"), label: "render" }, api(cwd));
  assert.equal(plain.details.media[0].mimeType, "image/png");
  assert.equal(plain.details.media[0].title, "render");
  assert.deepEqual(hostShare(plain, cwd).shared[0].bytes, PNG);
  assert.equal(plain.details.sharedImages.count, 1);
  assert.equal(sidecar(plain.details.sharedImages.stored[0]).source.label, "render");
  // A title alone captions the archived image too (ag's gallery shows the label).
  writeFileSync(join(cwd, "chart.png"), PNG);
  const titled = await share.execute({ path: "chart.png", title: "Weekly totals" }, api(cwd));
  assert.equal(sidecar(titled.details.sharedImages.stored[0]).source.label, "Weekly totals");
});

test("image_share refuses ambiguous input and skips the archive when incognito", async () => {
  const { cwd, env } = fixture();
  const share = tool(createDurableMedia({ env }), "image_share");
  await assert.rejects(share.execute({}, api(cwd)), /exactly one of path or data/);
  await assert.rejects(share.execute({ path: "a.png", data: "AAAA" }, api(cwd)), /exactly one of path or data/);
  await assert.rejects(share.execute({ data: "not base64!" }, api(cwd)), /not valid base64/);
  await assert.rejects(share.execute({ data: Buffer.from("plain text").toString("base64") }, api(cwd)), /Unsupported shared image/);
  const incognito = tool(createDurableMedia({ env: { ...env, PI_INCOGNITO: "1" } }), "image_share");
  const result = await incognito.execute({ data: PNG.toString("base64") }, api(cwd));
  assert.equal(result.details.media.length, 1);
  assert.equal(result.details.sharedImages.root, null);
  assert.match(hostShare(result, cwd).modelText, /Archive disabled/);
  assert.equal(existsSync(env.PI_SHARED_IMAGES_DIR), false);
});

test("audio_share wraps raw PCM as WAV for clients and the archive", async () => {
  const { cwd, env } = fixture();
  const media = createDurableMedia({ env });
  const pcm = Buffer.alloc(8000 * 2); // one second of s16le mono silence at 8 kHz
  const result = await tool(media, "audio_share").execute({ data: pcm.toString("base64"), pcm: { sampleRate: 8000 }, title: "Tone" }, api(cwd));
  const [item] = result.details.media;
  assert.equal(item.mimeType, "audio/wav");
  assert.equal(item.title, "Tone");
  const wav = Buffer.from(item.data, "base64");
  const header = parseWavHeader(wav, wav.length);
  assert.equal(header.sampleRate, 8000);
  assert.equal(header.channels, 1);
  assert.equal(header.bitsPerSample, 16);
  assert.equal(header.dataBytes, pcm.length);
  assert.equal(result.details.durationMs, 1000);
  assert.match(hostShare(result, cwd).modelText, /Shared audio "Tone" \(0:01, audio\/wav, 16 KiB\) with the operator\./);
  const receipts = result.details.sharedAudio;
  assert.equal(receipts.count, 1);
  assert.deepEqual(readFileSync(receipts.stored[0].path), wav);
  const meta = sidecar(receipts.stored[0]);
  assert.equal(meta.mimeType, "audio/wav");
  assert.equal(meta.durationMs, 1000);
  assert.equal(meta.title, "Tone");
  assert.equal(meta.source.tool, "audio_share");
});

test("audio_share shares a file by path and plays on the host only when asked", async () => {
  const { cwd, env } = fixture();
  writeFileSync(join(cwd, "song.mp3"), MP3);
  const plays = [];
  const playback = { async play(item, options) { plays.push({ item, options }); return { status: "playing", output: { backend: "pulse", sink: "desk", server: null } }; }, dispose() {} };
  const media = createDurableMedia({ env, playback });
  const share = tool(media, "audio_share");
  const quiet = await share.execute({ path: "~/work/song.mp3", label: "Demo" }, api(cwd));
  assert.deepEqual(quiet.details.media, [{ path: join(cwd, "song.mp3"), mimeType: "audio/mpeg", title: "Demo" }]);
  assert.equal(plays.length, 0);
  assert.equal(quiet.details.sharedAudio.count, 1);
  assert.equal(sidecar(quiet.details.sharedAudio.stored[0]).source.label, "Demo");

  const loud = await share.execute({ path: "song.mp3", play: true, output: { sink: "desk" } }, api(cwd));
  assert.equal(plays.length, 1);
  assert.equal(plays[0].item.path, join(cwd, "song.mp3"));
  assert.deepEqual(plays[0].options.output, { sink: "desk" });
  assert.equal(loud.details.playing, "pulse · sink desk · server local");
  assert.match(hostShare(loud, cwd).modelText, /Playing on the host via pulse · sink desk/);

  const inline = await share.execute({ data: Buffer.alloc(32).toString("base64"), pcm: {}, play: true }, api(cwd));
  assert.equal(plays.length, 2);
  assert.ok(isAbsolute(plays[1].item.path) && existsSync(plays[1].item.path), "inline audio is materialized for playback");
  assert.equal(inline.details.media[0].mimeType, "audio/wav");

  const failing = createDurableMedia({ env, playback: { async play() { throw new Error("pacat not found"); } } });
  const failed = await tool(failing, "audio_share").execute({ path: "song.mp3", play: true }, api(cwd));
  assert.equal(failed.details.playError, "pacat not found");
  assert.equal(failed.details.media.length, 1, "a playback failure still shares the clip");
});

/** Fake Tendril: `list --json` and `capture --output <file>` that writes a PNG. */
function fakeTendril(targets) {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(args);
    const sub = args.find((arg) => arg === "list" || arg === "capture");
    if (sub === "list") return { code: 0, stdout: JSON.stringify({ status: "ok", data: { targets } }), stderr: "" };
    const output = args[args.indexOf("--output") + 1];
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, PNG);
    return { code: 0, stdout: JSON.stringify({ status: "ok", data: { path: output } }), stderr: "" };
  };
  return { exec, calls };
}

const TARGETS = [
  { kind: "window", id: "w7", title: "Build log", app_name: "Terminal", capabilities: { capture: true } },
  { kind: "display", id: "d0", name: "Off", capabilities: { capture: false } },
  { kind: "display", id: "d1", name: "Main", capabilities: { capture: true } },
];

test("tendril_capture returns image content to look and details.media to share", async () => {
  const { cwd, env } = fixture();
  const tendril = fakeTendril(TARGETS);
  const media = createDurableMedia({ env: { ...env, TENDRIL_SHARE_SCREENSHOT_DIR: "shots" }, exec: tendril.exec });
  const capture = tool(media, "tendril_capture");

  const look = await capture.execute({ target: "build" }, api(cwd));
  const seen = hostShare(look, cwd);
  assert.equal(seen.images.length, 1);
  assert.equal(seen.images[0].mimeType, "image/png");
  assert.deepEqual(Buffer.from(seen.images[0].data, "base64"), PNG);
  assert.equal(seen.shared.length, 0);
  assert.match(seen.modelText, /Captured Tendril window w7 \(Build log — Terminal\)\./);
  assert.equal(look.details.mode, "look");
  assert.ok(look.details.outputPath.startsWith(join(cwd, "shots")));
  assert.equal(look.details.sharedImages.count, 1, "captures are archived like TUI tool-result images");
  const captureArgs = tendril.calls.find((args) => args.includes("capture"));
  assert.deepEqual(captureArgs.slice(captureArgs.indexOf("--window"), captureArgs.indexOf("--window") + 2), ["--window", "w7"]);
  assert.equal(captureArgs[captureArgs.indexOf("--max-width") + 1], String(DEFAULT_CAPTURE_MAX_WIDTH));

  const share = await capture.execute({ mode: "share", title: "Main screen", maxWidth: 800 }, api(cwd));
  const shown = hostShare(share, cwd);
  assert.equal(shown.images.length, 0, "a shared capture stays out of the model's context");
  assert.equal(shown.shared.length, 1);
  assert.equal(shown.shared[0].mimeType, "image/png");
  assert.equal(shown.shared[0].title, "Main screen");
  assert.deepEqual(shown.shared[0].bytes, PNG);
  assert.match(shown.modelText, /Captured Tendril display d1 \(Main\)\./);
  assert.match(shown.modelText, /Shared it with the operator as "Main screen"\./);
  const lastCapture = tendril.calls.filter((args) => args.includes("capture")).at(-1);
  assert.ok(lastCapture.includes("--display") && lastCapture.includes("d1"), "no target selects the first capture-capable display");
  assert.equal(lastCapture[lastCapture.indexOf("--max-width") + 1], "800");

  const both = await capture.execute({ kind: "screen", target: "d1", mode: "both" }, api(cwd));
  const all = hostShare(both, cwd);
  assert.equal(all.images.length, 1);
  assert.equal(all.shared.length, 1);
  assert.equal(all.shared[0].title, "Tendril display Main");
});

test("tendril_capture validates its arguments and reports Tendril failures", async () => {
  const { cwd, env } = fixture();
  const capture = tool(createDurableMedia({ env, exec: fakeTendril([]).exec }), "tendril_capture");
  await assert.rejects(capture.execute({ mode: "stream" }, api(cwd)), /mode must be one of look, share, both/);
  await assert.rejects(capture.execute({ kind: "window" }, api(cwd)), /window capture needs a target/);
  await assert.rejects(capture.execute({}, api(cwd)), /no capture-capable display/);
  const broken = tool(createDurableMedia({ env, exec: async () => ({ code: 2, stdout: "", stderr: "no bridge" }) }), "tendril_capture");
  await assert.rejects(broken.execute({ target: "x" }, api(cwd)), /tendril capture failed: no bridge/);
});

test("tendril_capture runs Tendril through the session's ExecutionEnv", async () => {
  const { cwd, env } = fixture();
  const runs = [];
  const executionEnv = {
    cwd,
    async exec(command, options, context) {
      runs.push({ command, options, context });
      const output = command[command.indexOf("--output") + 1];
      if (command.includes("list")) {
        options.onOutput(JSON.stringify({ status: "ok", data: { targets: TARGETS } }), context, { stream: "stdout" });
      } else {
        mkdirSync(dirname(output), { recursive: true });
        writeFileSync(output, PNG);
        options.onOutput("{\"status\":\"ok\"}", context, { stream: "stdout" });
        options.onOutput("warming up\n", context, { stream: "stderr" });
      }
      return { ok: true, value: { exitCode: 0 } };
    },
  };
  const context = { abortSignal: undefined };
  const media = createDurableMedia({ env });
  const result = await tool(media, "tendril_capture").execute({ target: "d1", kind: "display", mode: "share" }, { ...api(cwd), env: executionEnv }, context);
  assert.equal(result.details.media.length, 1);
  assert.equal(runs.length, 2);
  assert.ok(Array.isArray(runs[0].command), "commands run without a shell");
  assert.equal(runs[0].command[0], "tendril");
  assert.equal(runs[0].options.cwd, cwd);
  assert.equal(runs[1].options.timeout, 35, "timeouts are seconds");
  assert.equal(runs[1].context, context);
});

test("durableEnvExec maps ExecutionEnv results to pi.exec's shape", async () => {
  const exec = durableEnvExec({
    async exec(command, options, context) {
      options.onOutput("out", context, { stream: "stdout" });
      options.onOutput("err", context, { stream: "stderr" });
      return command[0] === "fail" ? { ok: false, error: new Error("spawn failed") } : { ok: true, value: { exitCode: 3 } };
    },
  }, {});
  assert.deepEqual(await exec("tool", ["a"], { timeout: 1500 }), { code: 3, stdout: "out", stderr: "err" });
  assert.deepEqual(await exec("fail", []), { code: 127, stdout: "out", stderr: "err" });
  const fallback = async () => ({ code: 0, stdout: "fallback", stderr: "" });
  assert.equal(durableEnvExec(undefined, {}, fallback), fallback);
});

test("normalizeBase64 accepts base64url, padding-free and data: URLs", () => {
  assert.deepEqual(normalizeBase64("data:image/png;base64,iVBO R w0="), { data: "iVBORw0=", declared: "image/png" });
  assert.equal(normalizeBase64("-_8").data, "+/8=");
  assert.throws(() => normalizeBase64(""), /nonempty/);
  assert.throws(() => normalizeBase64("abcde"), /not valid base64/);
});
