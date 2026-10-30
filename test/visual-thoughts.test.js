// Visual thoughts: images of the agent's work crossfading behind the screen.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { DEFAULTS, parseSettingChange, resolveVisualThoughtsConfig } from "../extensions/lib/visual-thoughts/config.js";
import { createVisualThoughtsEngine } from "../extensions/lib/visual-thoughts/engine.js";
import { ImageRateLimitError, createImageProvider, maiDimensions, retryAfterMs } from "../extensions/lib/visual-thoughts/image-provider.js";
import { buildImagePromptRequest, createDigest, normalizeImagePrompt, toolCallDigest } from "../extensions/lib/visual-thoughts/prompter.js";
import { backdropRasterSize, blendBackdrops, decodeImage, encodeBackdropPng, prepareBackdrop } from "../extensions/lib/visual-thoughts/raster.js";
import { createRotation } from "../extensions/lib/visual-thoughts/rotation.js";
import { createImageStore } from "../extensions/lib/visual-thoughts/store.js";
import { BACKDROP_Z, createTuiBackdropSurface } from "../extensions/lib/visual-thoughts/tui-surface.js";
import { parseKittyGraphicsCommands } from "../extensions/kitty-graphics.js";

/** A solid-colour opaque image as PNG bytes. */
function solidPng(width, height, [r, g, b]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 4) { rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255; }
  return encodeBackdropPng({ width, height, rgba });
}

const pixel = (raster, x, y) => [...raster.rgba.subarray((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4)];

test("raster: PNG round trip, fit, feathered edges and opacity", () => {
  const png = solidPng(64, 32, [200, 100, 50]);
  const decoded = decodeImage(png);
  assert.equal(decoded.width, 64);
  assert.deepEqual([...decoded.rgba.subarray(0, 4)], [200, 100, 50, 255]);

  // Cover fills the raster; the centre has the opacity's alpha, the edge fades out.
  const cover = prepareBackdrop(decoded, { width: 40, height: 40, fit: "cover", feather: 0.2, opacity: 0.5 });
  assert.deepEqual(pixel(cover, 20, 20), [200, 100, 50, 127]);
  assert.ok(pixel(cover, 0, 20)[3] < 10, "the left edge is feathered");
  assert.ok(pixel(cover, 3, 20)[3] < pixel(cover, 6, 20)[3], "the fade rises inwards");

  // Contain letterboxes a wide image: the top rows are empty.
  const contain = prepareBackdrop(decoded, { width: 40, height: 40, fit: "contain", feather: 0, opacity: 1 });
  assert.equal(pixel(contain, 20, 2)[3], 0);
  assert.deepEqual(pixel(contain, 20, 20), [200, 100, 50, 255]);

  // Stretch with no feather fills every pixel.
  const stretch = prepareBackdrop(decoded, { width: 10, height: 30, fit: "stretch", feather: 0, opacity: 1 });
  assert.equal(pixel(stretch, 0, 0)[3], 255);

  // The raster's size follows the screen, bounded.
  assert.deepEqual(backdropRasterSize({ cols: 100, rows: 30, detail: 2, cellAspect: 2 }), { width: 200, height: 120 });
  const big = backdropRasterSize({ cols: 1000, rows: 300, detail: 4, cellAspect: 2, maxPixels: 100_000 });
  assert.ok(big.width * big.height <= 100_000);
});

test("raster: crossfades blend premultiplied, and from nothing fade in", () => {
  const red = prepareBackdrop(decodeImage(solidPng(8, 8, [255, 0, 0])), { width: 8, height: 8, fit: "stretch", feather: 0, opacity: 1 });
  const blue = prepareBackdrop(decodeImage(solidPng(8, 8, [0, 0, 255])), { width: 8, height: 8, fit: "stretch", feather: 0, opacity: 1 });
  assert.deepEqual(pixel(blendBackdrops(red, blue, 0.5), 4, 4), [127, 0, 127, 255]);
  assert.deepEqual(pixel(blendBackdrops(red, blue, 1), 4, 4), [0, 0, 255, 255]);
  assert.deepEqual(pixel(blendBackdrops(null, blue, 0.5), 4, 4), [0, 0, 255, 127]);
  // A transparent side keeps the other's colour as it fades.
  const clear = { width: 8, height: 8, rgba: new Uint8Array(8 * 8 * 4) };
  assert.deepEqual(pixel(blendBackdrops(clear, red, 0.5), 1, 1), [255, 0, 0, 127]);
  // The encoder's Sub filter decodes back exactly.
  const frame = blendBackdrops(red, blue, 0.25);
  assert.deepEqual([...decodeImage(encodeBackdropPng(frame)).rgba], [...frame.rgba]);
});

test("rotation: fades in, holds, cycles the newest batch, and shows a new image after minShow", () => {
  const r = createRotation({ holdMs: 1000, fadeMs: 100, minShowMs: 300, minSet: 2, maxImages: 4 });
  assert.equal(r.tick(0), null);
  assert.equal(r.wakeIn(0), Infinity);
  r.newBatch();
  assert.deepEqual(r.add({ id: "a" }, 0), { from: null, to: "a", t: 0 });
  assert.deepEqual(r.tick(50), { from: null, to: "a", t: 0.5 });
  assert.deepEqual(r.tick(100), { id: "a" });
  // A new image waits for minShow, then fades from the current one.
  r.add({ id: "b" }, 200);
  assert.deepEqual(r.tick(200), { id: "a" });
  assert.equal(r.wakeIn(200), 200);
  assert.deepEqual(r.tick(400), { from: "a", to: "b", t: 0 });
  assert.deepEqual(r.tick(500), { id: "b" });
  // Holding: after holdMs the cycle moves on (a, b alternate).
  assert.deepEqual(r.tick(1400), { id: "b" }, "held for holdMs from when it was fully shown");
  assert.deepEqual(r.tick(1500), { from: "b", to: "a", t: 0 });
  assert.deepEqual(r.tick(1600), { id: "a" });

  // A new run's first image takes over; the cycle keeps minSet with the latest older image.
  r.newBatch();
  r.add({ id: "c" }, 1700);
  assert.deepEqual(r.tick(1800), { id: "a" }, "a waits out minShow");
  assert.deepEqual(r.tick(1900), { from: "a", to: "c", t: 0 });
  r.tick(2000);
  assert.deepEqual(r.status().cycle, ["b", "c"]);
  r.add({ id: "d" }, 2100);
  r.tick(2300); r.tick(2400);
  assert.deepEqual(r.status().cycle, ["c", "d"], "the new batch alone once it has minSet images");
  // maxImages drops the oldest.
  r.add({ id: "e" }, 2500);
  assert.deepEqual(r.ids(), ["b", "c", "d", "e"]);
  r.add({ id: "f" }, 2600);
  assert.deepEqual(r.ids(), ["c", "d", "e", "f"]);
});

test("rotation: skip goes to the next image, and removal of the shown one recovers", () => {
  const r = createRotation({ holdMs: 10_000, fadeMs: 0, minShowMs: 0, minSet: 3 });
  r.add({ id: "a" }, 0); r.tick(0);
  r.add({ id: "b" }, 1); r.tick(1);
  assert.deepEqual(r.tick(2), { id: "b" });
  r.skip(3);
  assert.deepEqual(r.tick(3), { id: "a" });
  r.remove("a");
  assert.deepEqual(r.tick(4), { id: "b" });
});

test("digest and prompts: bounded, labelled, redacted; replies normalized", () => {
  const digest = createDigest({ maxChars: 200 });
  digest.add("thinking", "Planning the ");
  digest.add("thinking", "migration.");
  digest.add("tool", toolCallDigest("bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' x", token: "s3cret" }));
  digest.add("text", "x".repeat(300));
  const snapshot = digest.snapshot(1_000);
  assert.match(snapshot, /\[reply\] x+$/);
  assert.ok(snapshot.length < 260, "bounded by maxChars");
  assert.equal(digest.pending > 300, true);
  digest.mark();
  assert.equal(digest.pending, 0);
  const tool = toolCallDigest("bash", { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' x", token: "s3cret" });
  assert.doesNotMatch(tool, /abcdefghijklmnop|s3cret/);

  const request = buildImagePromptRequest({ digest: "[reply] done", recentPrompts: ["a lighthouse", "a forest"], style: "ink wash" });
  assert.match(request.systemPrompt, /Never depict text/);
  const text = request.messages[0].content[0].text;
  assert.match(text, /House style to keep to: ink wash/);
  assert.match(text, /- a lighthouse/);
  assert.match(text, /<<<\n\[reply\] done\n>>>/);

  assert.equal(normalizeImagePrompt('Prompt: "A quiet harbour at dusk"'), "A quiet harbour at dusk");
  assert.equal(normalizeImagePrompt("A quiet harbour", { style: "ink wash" }), "A quiet harbour. ink wash");
  assert.equal(normalizeImagePrompt("  "), "");
  assert.ok(normalizeImagePrompt("word ".repeat(400)).length <= 600);
});

test("config: defaults, settings, environment, incognito and runtime changes", () => {
  const base = resolveVisualThoughtsConfig({}, {});
  assert.equal(base.enabled, false);
  assert.equal(base.imageModel, DEFAULTS.imageModel);
  const set = resolveVisualThoughtsConfig({ agentUtils: { visualThoughts: { enabled: true, opacity: 2, fit: "contain", provider: "mai", bogus: 1 } } }, { PI_VISUAL_THOUGHTS_PROMPT_MODEL: "github-copilot/gpt-5.4-nano" });
  assert.equal(set.enabled, true);
  assert.equal(set.opacity, 1, "clamped");
  assert.equal(set.fit, "contain");
  assert.equal(set.size, "1344x768", "MAI's landscape minimum");
  assert.equal(set.imageModel, "MAI-Image-2.5-Flash");
  assert.equal(set.promptModel, "github-copilot/gpt-5.4-nano");
  assert.equal(resolveVisualThoughtsConfig({ agentUtils: { visualThoughts: { enabled: true } } }, { PI_INCOGNITO: "1" }).enabled, false);
  assert.deepEqual(parseSettingChange("hold", "20"), { key: "holdMs", value: 20_000 });
  assert.deepEqual(parseSettingChange("opacity", "0.4"), { key: "opacity", value: 0.4 });
  assert.deepEqual(parseSettingChange("fit", "stretch"), { key: "fit", value: "stretch" });
  assert.match(parseSettingChange("fit", "zoom").error, /invalid/);
  assert.match(parseSettingChange("enabled", "1").error, /unknown/);
});

test("image provider: LiteLLM and MAI requests, image data, and rate limits", async () => {
  const png = solidPng(4, 4, [1, 2, 3]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/limited")) return new Response("{}", { status: 429 });
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
  };
  const litellm = createImageProvider({ provider: "litellm", imageModel: "gpt-image-2.5-flare", size: "1536x1024", quality: "low", apiKeyEnv: "KEY" }, { fetchImpl, env: { LITELLM_BASE_URL: "http://proxy:4000/v1", KEY: "k" } });
  const result = await litellm.generate("a harbour");
  assert.deepEqual(result.png, png);
  assert.equal(calls[0].url, "http://proxy:4000/v1/images/generations");
  assert.equal(calls[0].init.headers.Authorization, "Bearer k");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "gpt-image-2.5-flare", prompt: "a harbour", n: 1, size: "1536x1024", quality: "low" });

  const mai = createImageProvider({ provider: "mai", imageModel: "MAI-Image-2.5-Flash", size: "1344x768", maiEndpoint: "https://mai.example/" }, {
    fetchImpl, env: {}, tokenBroker: { getToken: async (options) => { assert.equal(options.resource, "https://cognitiveservices.azure.com/"); return "tok"; } },
  });
  await mai.generate("a harbour");
  assert.equal(calls[1].url, "https://mai.example/mai/images/generations");
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: "MAI-Image-2.5-Flash", prompt: "a harbour", n: 1, width: 1344, height: 768 });
  assert.deepEqual(maiDimensions("512x512"), { width: 768, height: 768 });
  assert.deepEqual(maiDimensions("1024x576"), { width: 1360, height: 768 });

  const limited = createImageProvider({ provider: "mai", maiEndpoint: "https://x/limited" }, { fetchImpl: async () => new Response("{\"error\":{\"message\":\"slow down\"}}", { status: 429, headers: { "x-ratelimit-reset-requests": "42" } }), env: {}, tokenBroker: { getToken: async () => "t" } });
  await assert.rejects(limited.generate("p"), (error) => error instanceof ImageRateLimitError && error.retryAfterMs === 42_000 && /slow down/.test(error.message));
  assert.equal(retryAfterMs({ "retry-after": "3" }), 3_000);
  assert.equal(retryAfterMs({}), 60_000);
});

/** A manual clock with timers the test advances. */
function fakeTime() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function engineHarness(overrides = {}) {
  const time = fakeTime();
  const config = { ...DEFAULTS, minIntervalMs: 1_000, firstChars: 10, minChars: 50, maxPerRun: 3, holdMs: 5_000, fadeMs: 100, fadeSteps: 2, minShowMs: 0, ...overrides };
  const prompts = [];
  const shown = [];
  let painted = 0;
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  const engine = createVisualThoughtsEngine({
    config,
    now: time.now,
    timers: time.timers,
    promptTurn: async (request) => { prompts.push(request.messages[0].content[0].text); return `scene ${prompts.length}`; },
    provider: { describe: () => "fake", generate: async (prompt) => ({ png: solidPng(16, 9, colours[painted++ % colours.length]), model: "fake", ms: 5, prompt }) },
    surface: { size: () => ({ cols: 20, rows: 6 }), show: (frame) => shown.push(frame), clear: () => shown.push("clear") },
    warn: (message) => { throw new Error(`unexpected warning: ${message}`); },
  });
  return { engine, time, config, prompts, shown, painted: () => painted };
}

test("engine: paints from a run's output past the thresholds, spaced by the interval, capped per run", async () => {
  const h = engineHarness();
  h.engine.setEnabled(true);
  h.engine.output("text", "ignored before a run");
  await settle();
  assert.equal(h.prompts.length, 0, "only during runs");
  h.engine.runStart();
  h.engine.output("user", "make it fast");
  await settle();
  assert.equal(h.prompts.length, 1, "the first image needs only firstChars");
  assert.match(h.prompts[0], /\[prompt\] make it fast/);
  await settle();
  assert.equal(h.painted(), 1);
  // Shown: a fade-in frame at once (decodes as the backdrop raster).
  const first = h.shown.find((frame) => frame !== "clear");
  assert.ok(first?.png && first.width > 0);
  // More output, but the interval holds the next one back until it passes.
  h.engine.output("text", "y".repeat(60));
  await settle();
  assert.equal(h.prompts.length, 1);
  await h.time.advance(1_000);
  assert.equal(h.prompts.length, 2);
  assert.match(h.prompts[1], /Recent prompts[\s\S]*scene 1/);
  // The per-run cap.
  for (let i = 0; i < 5; i += 1) { h.engine.output("text", "z".repeat(60)); await h.time.advance(1_000); }
  assert.equal(h.prompts.length, 3);
  // After the run, the cycle keeps crossfading the images.
  h.engine.runEnd();
  const before = h.shown.length;
  await h.time.advance(6_000);
  assert.ok(h.shown.length > before, "the rotation keeps going between runs");
  assert.equal(h.engine.status().images, 3);
});

test("engine: rate limits wait their reset; failures back off and are reported", async () => {
  const time = fakeTime();
  const warnings = [];
  let attempt = 0;
  const config = { ...DEFAULTS, minIntervalMs: 0, firstChars: 1, minChars: 1, maxPerRun: 10 };
  const engine = createVisualThoughtsEngine({
    config, now: time.now, timers: time.timers,
    promptTurn: async () => "scene",
    provider: { generate: async () => { attempt += 1; if (attempt === 1) throw new ImageRateLimitError("limited", 30_000); throw new Error("boom"); } },
    surface: { size: () => ({ cols: 10, rows: 4 }), show() {}, clear() {} },
    warn: (message) => warnings.push(message),
  });
  engine.setEnabled(true);
  engine.runStart();
  engine.output("text", "a");
  await settle();
  assert.equal(attempt, 1);
  assert.equal(warnings.length, 0, "a rate limit is not a warning");
  engine.output("text", "b");
  await time.advance(29_000);
  assert.equal(attempt, 1, "waits for the reset");
  await time.advance(1_000);
  assert.equal(attempt, 2);
  assert.match(warnings[0], /boom/);
  assert.ok(engine.status().waitMs >= 14_000, "a failure backs off");
  engine.setEnabled(false);
});

test("engine: restored images show at once; turning off clears the surface", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vt-store-"));
  try {
    const store = createImageStore({ root: dir, sessionId: "s/1" });
    await store.save({ id: "vt-1", prompt: "a", model: "m", batch: 0, at: 1 }, solidPng(8, 8, [9, 9, 9]));
    await store.save({ id: "vt-2", prompt: "b", model: "m", batch: 0, at: 2 }, solidPng(8, 8, [7, 7, 7]));
    const records = await store.recent(5);
    assert.deepEqual(records.map((record) => record.id), ["vt-1", "vt-2"]);
    assert.ok(records[0].path.startsWith(join(dir, "s_1")));
    await store.prune(1);
    assert.deepEqual((await store.recent(5)).map((record) => record.id), ["vt-2"]);
    assert.equal(existsSync(join(dir, "s_1", "vt-1.png")), false);

    const h = engineHarness();
    h.engine.setEnabled(true);
    h.engine.restore(await store.recent(5));
    assert.ok(h.shown.some((frame) => frame.png), "drawn from the stored file");
    assert.equal(h.engine.status().images, 1);
    h.engine.setEnabled(false);
    assert.equal(h.shown.at(-1), "clear");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Pi's terminal, recording what reaches the screen. */
function fakeTerminal() {
  const writes = [];
  class Terminal { write(data) { writes.push(String(data)); } }
  const terminal = new Terminal();
  terminal.columns = 80;
  terminal.rows = 24;
  return { terminal, writes };
}

test("TUI surface: double-buffered frames at the top-left, put back after Pi clears them", () => {
  const { terminal, writes } = fakeTerminal();
  const tui = { mode: "fullscreen", terminal };
  let resized = 0;
  const surface = createTuiBackdropSurface({ tui, env: {}, options: () => ({ layer: "over", transport: "stream" }), onResize: () => { resized += 1; }, ids: [11, 22] });
  assert.deepEqual(surface.size(), { cols: 80, rows: 24 });
  const png = solidPng(4, 4, [1, 2, 3]);
  surface.show({ png });
  const first = parseKittyGraphicsCommands(writes[0]);
  assert.match(writes[0], /^\x1b\[\?2026h\x1b7/);
  assert.match(writes[0], /\x1b8\x1b\[\?2026l$/);
  assert.deepEqual(first.map((c) => c.control.a), ["t", "p"]);
  assert.equal(first[0].control.i, "11");
  assert.deepEqual(Buffer.from(first[0].payloadBase64, "base64"), png);
  assert.equal(first[1].control.z, String(BACKDROP_Z.over));
  assert.equal(first[1].control.c, "80");
  assert.equal(first[1].control.r, "24");
  // The next frame uses the other id and deletes the first.
  surface.show({ png });
  const second = parseKittyGraphicsCommands(writes[1]);
  assert.deepEqual(second.map((c) => `${c.control.a}${c.control.i}`), ["t22", "p22", "d11"]);

  // Pi deleted every placement in a frame: the backdrop is placed again before the frame ends.
  terminal.write("\x1b[?2026h\x1b_Ga=d,d=a,q=2\x1b\\rows\x1b[?2026l");
  const replaced = writes.at(-1);
  assert.match(replaced, /rows\x1b7\x1b\[1;1H\x1b_Ga=p,i=22,[^\x1b]*\x1b\\\x1b8\x1b\[\?2026l$/);
  assert.equal(parseKittyGraphicsCommands(replaced).filter((c) => c.control.a === "t").length, 0, "data kept: no re-send");
  // Pi freed the images (a full redraw at a new size): data re-sent, placed at the new size.
  terminal.columns = 100;
  terminal.write("\x1b[?2026h\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J\x1b[?2026l");
  const freed = parseKittyGraphicsCommands(writes.at(-1));
  assert.deepEqual(freed.map((c) => c.control.a), ["d", "t", "p"]);
  assert.equal(freed[2].control.c, "100");
  // Ordinary output passes through untouched.
  terminal.write("plain");
  assert.equal(writes.at(-1), "plain");
  surface.dispose();
  assert.deepEqual(parseKittyGraphicsCommands(writes.at(-1)).map((c) => `${c.control.a}${c.control.d}${c.control.i}`), ["dI11", "dI22"]);
  terminal.write("after");
  assert.equal(writes.at(-1), "after", "unhooked");
  return new Promise((resolve) => queueMicrotask(() => { assert.equal(resized, 1); resolve(); }));
});

test("TUI surface: frames as files when local; layer under in tmux; nothing outside fullscreen", () => {
  const { terminal, writes } = fakeTerminal();
  const surface = createTuiBackdropSurface({ tui: { mode: "fullscreen", terminal }, env: {}, options: () => ({ transport: "auto" }), ids: [1, 2] });
  surface.show({ png: solidPng(2, 2, [5, 5, 5]) });
  const [transmit, place] = parseKittyGraphicsCommands(writes[0]);
  assert.equal(transmit.control.t, "f");
  const path = Buffer.from(transmit.payloadBase64, "base64").toString();
  assert.deepEqual(readFileSync(path), solidPng(2, 2, [5, 5, 5]));
  assert.equal(place.control.z, String(BACKDROP_Z.over));
  surface.dispose();
  assert.equal(existsSync(path), false, "frame files removed");

  const tmux = createTuiBackdropSurface({ tui: { mode: "fullscreen", terminal }, env: { TMUX: "/tmp/tmux" }, options: () => ({}), ids: [1, 2] });
  writes.length = 0;
  tmux.show({ png: solidPng(2, 2, [5, 5, 5]) });
  assert.match(writes[0], /\x1bPtmux;/, "passthrough");
  assert.equal(parseKittyGraphicsCommands(writes[0]).find((c) => c.control.a === "p").control.z, String(BACKDROP_Z.under));
  assert.notEqual(parseKittyGraphicsCommands(writes[0])[0].control.t, "f", "streamed inside tmux");
  tmux.dispose();

  const regular = createTuiBackdropSurface({ tui: { mode: "regular", terminal }, env: {}, options: () => ({}), ids: [1, 2] });
  assert.equal(regular.size(), null);
  writes.length = 0;
  regular.show({ png: solidPng(2, 2, [5, 5, 5]) });
  assert.equal(writes.length, 0);
});

test("the encoded backdrop is a valid RGBA PNG", () => {
  const png = encodeBackdropPng({ width: 3, height: 2, rgba: new Uint8Array(24).fill(200) });
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  const idat = png.indexOf("IDAT");
  const length = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.equal(raw.length, 2 * (3 * 4 + 1));
});
