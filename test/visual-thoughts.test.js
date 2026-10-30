// Visual thoughts: images of the agent's work crossfading behind the screen.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { createHash } from "node:crypto";

import { DEFAULTS, parseSettingChange, resolveVisualThoughtsConfig } from "../extensions/lib/visual-thoughts/config.js";
import { createVisualThoughtsEngine } from "../extensions/lib/visual-thoughts/engine.js";
import { ImageRateLimitError, createImageProvider, maiDimensions, retryAfterMs } from "../extensions/lib/visual-thoughts/image-provider.js";
import { buildImagePromptRequest, createDigest, normalizeImagePrompt, toolCallDigest } from "../extensions/lib/visual-thoughts/prompter.js";
import { decodeImage, encodeBackdropPng, prepareBackdrop } from "../extensions/lib/visual-thoughts/raster.js";
import { EFFECTS, createTransitionRenderer, planTransition } from "../extensions/lib/visual-thoughts/effects.js";
import { createRenderCore, holdSize, transitionSize } from "../extensions/lib/visual-thoughts/render-core.js";
import { createRenderer } from "../extensions/lib/visual-thoughts/renderer.js";
import { createRotation } from "../extensions/lib/visual-thoughts/rotation.js";
import { createImageStore } from "../extensions/lib/visual-thoughts/store.js";
import { BACKDROP_Z, CANVAS_BLEND_Z, createTuiBackdropSurface } from "../extensions/lib/visual-thoughts/tui-surface.js";
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

  // Hold images: the screen's shape, no more pixels than the screen or the source's visible part.
  assert.deepEqual(holdSize({ width: 1536, height: 1024 }, { width: 3000, height: 2000 }), { width: 1536, height: 1024 });
  assert.deepEqual(holdSize({ width: 1536, height: 1024 }, { width: 900, height: 1000 }), { width: 900, height: 1000 });
  const portrait = holdSize({ width: 1536, height: 1024 }, { width: 2700, height: 3000 });
  assert.equal(portrait.width, 922, "cover shows 922 source columns of a 1536×1024 image on a 0.9 aspect screen");
  const small = transitionSize({ width: 2700, height: 3000 }, 400_000);
  assert.ok(small.width * small.height <= 400_000 && Math.abs(small.width / small.height - 0.9) < 0.01);
});

test("effects: every transition starts at the old image, ends at the new, and is deterministic", () => {
  const red = prepareBackdrop(decodeImage(solidPng(24, 16, [255, 0, 0])), { width: 24, height: 16, fit: "stretch", feather: 0, opacity: 1 });
  const blue = prepareBackdrop(decodeImage(solidPng(24, 16, [0, 0, 255])), { width: 24, height: 16, fit: "stretch", feather: 0, opacity: 1 });
  for (const effect of EFFECTS) {
    const plan = planTransition({ width: 24, height: 16, effect, seed: 5 });
    assert.equal(plan.effect, effect);
    const renderer = createTransitionRenderer(plan, red, blue);
    const start = renderer.frame(0);
    const end = renderer.frame(1);
    const mid = renderer.frame(0.5);
    assert.deepEqual([...start.subarray(4 * 50, 4 * 50 + 4)], [255, 0, 0, 255], `${effect} starts at the old image`);
    assert.deepEqual([...end.subarray(4 * 50, 4 * 50 + 4)], [0, 0, 255, 255], `${effect} ends at the new one`);
    assert.ok([...mid].some((v, i) => i % 4 === 2 && v > 0) && [...mid].some((v, i) => i % 4 === 0 && v > 0), `${effect} shows both midway`);
    assert.deepEqual(createTransitionRenderer(planTransition({ width: 24, height: 16, effect, seed: 5 }), red, blue).frame(0.37), renderer.frame(0.37), `${effect} is deterministic`);
  }
  // From nothing: fades in from transparent.
  const fade = createTransitionRenderer(planTransition({ width: 24, height: 16, effect: "fade" }), null, blue);
  assert.equal(fade.frame(0)[3], 0);
  assert.deepEqual([...fade.frame(0.5).subarray(0, 4)], [0, 0, 255, 127]);
  // Random never picks the plain fade.
  const picks = new Set(Array.from({ length: 40 }, (_, seed) => planTransition({ width: 8, height: 8, seed }).effect));
  assert.ok(!picks.has("fade") && picks.size >= 4);
});

test("render core: images prepared at the screen's size, frames encoded for the terminal", () => {
  const dir = mkdtempSync(join(tmpdir(), "vt-core-"));
  try {
    for (const transport of ["stream", "file"]) {
      const core = createRenderCore({ dir, transport, pid: 7 });
      assert.match(core.handle({ type: "add", id: "a", png: solidPng(64, 32, [9, 9, 9]), ref: 1 }).error, /no display area/);
      core.handle({ type: "configure", area: { width: 200, height: 100 }, txPixels: 5_000, fit: "cover", feather: 0, opacity: 0.5 });
      const added = core.handle({ type: "add", id: "a", png: solidPng(64, 32, [9, 9, 9]), ref: 2 });
      assert.equal(added.ref, 2);
      assert.deepEqual([added.payload.width, added.payload.height], [64, 32], "no more than the source");
      const bytes = (payload) => (payload.medium === "t" ? readFileSync(payload.path) : inflateSync(Buffer.from(payload.data, "base64")));
      const hold = bytes(added.payload);
      assert.equal(hold.length, 64 * 32 * 4);
      assert.deepEqual([...hold.subarray(0, 4)], [9, 9, 9, 127], "opacity in the alpha");
      if (transport === "file") {
        assert.equal(added.payload.medium, "t");
        assert.match(added.payload.path, /tty-graphics-protocol-vt-7-\d+\.rgba$/);
        assert.equal(statSync(added.payload.path).mode & 0o777, 0o600);
      } else assert.equal(added.payload.compressed, true);
      core.handle({ type: "add", id: "b", png: solidPng(64, 32, [200, 9, 9]) });
      const begun = core.handle({ type: "begin", seq: 1, from: "a", to: "b", effect: "wave", seed: 1 });
      assert.equal(begun.effect, "wave");
      assert.ok(begun.width * begun.height <= 5_000);
      const frame = core.handle({ type: "frame", seq: 1, k: 1, t: 0.5 });
      assert.equal(bytes(frame.payload).length, begun.width * begun.height * 4);
      assert.ok(frame.ms >= 0);
      assert.equal(core.handle({ type: "frame", seq: 2, k: 1, t: 0.5 }).stale, true, "another transition's frame");
      core.handle({ type: "end", seq: 1 });
      assert.equal(core.handle({ type: "frame", seq: 1, k: 2, t: 0.6 }).stale, true);
      assert.match(core.handle({ type: "hold", id: "missing" }).error, /no image missing/);
      assert.match(core.handle({ type: "bogus" }).error, /unknown message/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderer: the same answers from a worker thread and in this thread", async () => {
  for (const useWorker of [true, false]) {
    const renderer = createRenderer({ transport: "stream", useWorker });
    try {
      assert.equal(renderer.threaded, useWorker);
      await renderer.configure({ area: { width: 120, height: 80 }, txPixels: 4_000, fit: "contain", feather: 0.1, opacity: 1 });
      const png = solidPng(30, 20, [1, 2, 3]);
      const added = await renderer.add("x", png);
      assert.equal(png.length > 0, true, "the caller's buffer is not consumed");
      assert.equal(added.payload.width, 30);
      await renderer.begin({ seq: 3, from: null, to: "x", effect: "ripple", seed: 2 });
      const frame = await renderer.frame(3, 1, 0.25);
      assert.equal(frame.k, 1);
      await assert.rejects(renderer.hold("nope"), /no image nope/);
    } finally {
      renderer.close();
    }
  }
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
        await settle();
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
      await settle();
    },
  };
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

/** A surface that records what it shows (the shape tui-surface.js and pi-client provide). */
function fakeSurface({ size: initial = { cols: 40, rows: 12, cellWidthPx: 10, cellHeightPx: 20 } } = {}) {
  const keys = new Set();
  const log = [];
  let shown = null;
  let size = initial;
  return {
    log,
    resize(next) { size = next; },
    size: () => size,
    transport: () => "stream",
    has: (key) => keys.has(key),
    upload(key, payload) { keys.add(key); log.push(`upload ${key} ${payload.width}x${payload.height}`); },
    show(key) { if (key !== null && !keys.has(key)) return false; shown = key; log.push(`show ${key}`); return true; },
    get shown() { return shown; },
    drop(key) { keys.delete(key); if (shown === key) shown = null; log.push(`drop ${key}`); },
    clear() { keys.clear(); shown = null; log.push("clear"); },
    lose() { keys.clear(); shown = null; },
  };
}

/** The renderer, answering at once (frames are tiny payloads). */
function fakeRenderer() {
  const calls = [];
  const payload = (width, height) => ({ medium: "d", data: "", compressed: true, width, height });
  return {
    calls,
    create: () => ({
      threaded: false,
      transport: "stream",
      configure: async (options) => { calls.push(`configure ${options.area.width}x${options.area.height}`); return {}; },
      add: async (id) => { calls.push(`add ${id}`); return { id, payload: payload(400, 240) }; },
      hold: async (id) => { calls.push(`hold ${id}`); return { id, payload: payload(400, 240) }; },
      drop: async (id) => { calls.push(`drop ${id}`); return { id }; },
      begin: async ({ seq, effect }) => { calls.push(`begin ${seq}`); return { seq, effect: effect === "random" ? "wave" : effect, width: 100, height: 60 }; },
      frame: async (seq, k) => ({ seq, k, payload: payload(100, 60), ms: 1 }),
      end: async (seq) => { calls.push(`end ${seq}`); return { seq }; },
      close() { calls.push("close"); },
    }),
  };
}

function engineHarness(overrides = {}) {
  const time = fakeTime();
  const config = { ...DEFAULTS, minIntervalMs: 1_000, firstChars: 10, minChars: 50, maxPerRun: 3, holdMs: 5_000, fadeMs: 100, fps: 50, minShowMs: 0, ...overrides };
  const prompts = [];
  const surface = fakeSurface();
  const renderer = fakeRenderer();
  let painted = 0;
  const engine = createVisualThoughtsEngine({
    config,
    now: time.now,
    timers: time.timers,
    surface,
    createRenderer: renderer.create,
    promptTurn: async (request) => { prompts.push(request.messages[0].content[0].text); return `scene ${prompts.length}`; },
    provider: { describe: () => "fake", generate: async () => ({ png: solidPng(16, 9, [painted++ * 40, 0, 0]), model: "fake", ms: 5 }) },
    warn: (message) => { throw new Error(`unexpected warning: ${message}`); },
  });
  return { engine, time, config, prompts, surface, renderer, painted: () => painted };
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
  await h.time.advance(0);
  assert.equal(h.painted(), 1);
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
  h.engine.runEnd();
  assert.equal(h.engine.status().images, 3);
  h.engine.dispose();
  assert.ok(h.renderer.calls.includes("close"));
});

test("engine: holds upload once and show; transitions play renderer frames, then the next hold", async () => {
  const h = engineHarness({ fadeMs: 200, fps: 50 });
  h.engine.setEnabled(true);
  h.engine.runStart();
  h.engine.output("user", "first painting please");
  await h.time.advance(0);
  // Prepared and uploaded before it joins the rotation; then a fade in from nothing.
  assert.deepEqual(h.renderer.calls.slice(0, 2), ["configure 400x240", h.renderer.calls[1]]);
  assert.match(h.renderer.calls[1], /^add vt-/);
  await h.time.advance(300);
  const id = h.engine.status().current;
  assert.ok(id);
  assert.equal(h.surface.shown, `hold:${id}:1`, "the hold image once the fade-in ends");
  const frames = h.surface.log.filter((line) => /^show tx:/.test(line)).length;
  assert.ok(frames >= 5 && frames <= 11, `about fadeMs × fps frames (${frames})`);
  assert.ok(h.surface.log.some((line) => line.startsWith("upload tx:0 100x60")));
  // A second image: crossfade from the first.
  h.engine.output("text", "q".repeat(60));
  await h.time.advance(1_000);
  await h.time.advance(300);
  const second = h.engine.status().current;
  assert.notEqual(second, id);
  assert.equal(h.surface.shown, `hold:${second}:1`);
  assert.equal(h.renderer.calls.filter((c) => c.startsWith("begin")).length, 2);
  assert.ok(h.renderer.calls.filter((c) => c.startsWith("end")).length >= 1);
  // The terminal freed everything: the shown hold uploads again.
  h.surface.lose();
  h.engine.lost();
  await h.time.advance(50);
  assert.equal(h.surface.shown, `hold:${second}:1`);
  assert.ok(h.renderer.calls.includes(`hold ${second}`));
  // A new size: the old hold stays up until the one made for the new size replaces it.
  h.surface.resize({ cols: 20, rows: 12, cellWidthPx: 10, cellHeightPx: 20 });
  h.engine.resized();
  assert.equal(h.surface.shown, `hold:${second}:1`, "nothing blank meanwhile");
  await h.time.advance(20);
  assert.equal(h.surface.shown, `hold:${second}:2`);
  assert.equal(h.surface.has(`hold:${second}:1`), false, "the old size's hold is freed");
  assert.ok(h.renderer.calls.includes("configure 200x240"));
  // Paused (an unfocused pane): no cycling, but a resize still remakes the shown hold.
  h.engine.pause(true);
  const before = h.engine.status().current;
  await h.time.advance(20_000);
  assert.equal(h.engine.status().current, before, "the cycle holds still");
  h.surface.resize({ cols: 30, rows: 12, cellWidthPx: 10, cellHeightPx: 20 });
  h.engine.resized();
  await h.time.advance(20);
  assert.equal(h.surface.shown, `hold:${before}:3`);
  h.engine.pause(false);
  // Off: nothing shown.
  h.engine.setEnabled(false);
  assert.equal(h.surface.shown, null);
  h.engine.dispose();
});

test("engine: rate limits wait their reset; failures back off and are reported", async () => {
  const time = fakeTime();
  const warnings = [];
  let attempt = 0;
  const config = { ...DEFAULTS, minIntervalMs: 0, firstChars: 1, minChars: 1, maxPerRun: 10 };
  const engine = createVisualThoughtsEngine({
    config, now: time.now, timers: time.timers, createRenderer: fakeRenderer().create,
    promptTurn: async () => "scene",
    provider: { generate: async () => { attempt += 1; if (attempt === 1) throw new ImageRateLimitError("limited", 30_000); throw new Error("boom"); } },
    surface: fakeSurface(),
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
  engine.dispose();
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
    await h.time.advance(300);
    assert.equal(h.surface.shown, "hold:vt-2:1", "drawn from the stored file");
    assert.ok(h.renderer.calls.includes("add vt-2"));
    h.engine.setEnabled(false);
    assert.equal(h.surface.log.at(-1), "clear");
    h.engine.dispose();
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

const flushed = () => new Promise((resolve) => queueMicrotask(resolve));

test("TUI surface: keyed images placed over the screen in one update, put back after Pi clears them", async () => {
  const { terminal, writes } = fakeTerminal();
  const tui = { mode: "fullscreen", terminal };
  let resized = 0;
  const lost = [];
  const surface = createTuiBackdropSurface({ tui, env: {}, options: () => ({ layer: "over", transport: "stream" }), onResize: () => { resized += 1; }, onLost: (key) => lost.push(key), cellSize: () => ({ widthPx: 10, heightPx: 20 }), ids: [11, 22, 33] });
  assert.deepEqual(surface.size(), { cols: 80, rows: 24, cellWidthPx: 10, cellHeightPx: 20 });
  assert.equal(surface.transport(), "stream");
  surface.upload("hold:a", { medium: "d", data: "eJw=", compressed: true, width: 4, height: 2 });
  surface.show("hold:a");
  await flushed();
  assert.equal(writes.length, 1, "one write per turn");
  assert.match(writes[0], /^\x1b\[\?2026h\x1b7/);
  assert.match(writes[0], /\x1b8\x1b\[\?2026l$/);
  const first = parseKittyGraphicsCommands(writes[0]);
  assert.deepEqual(first.map((c) => c.control.a), ["t", "p"]);
  assert.deepEqual([first[0].control.f, first[0].control.s, first[0].control.v, first[0].control.o, first[0].control.i], ["32", "4", "2", "z", "11"]);
  assert.deepEqual([first[1].control.c, first[1].control.r, first[1].control.z], ["80", "24", String(BACKDROP_Z.over)]);
  // A frame as a file: t=t; shown in place of the hold, whose placement goes.
  surface.upload("tx:0", { medium: "t", path: "/tmp/tty-graphics-protocol-vt-1-1.rgba", width: 4, height: 2 });
  surface.show("tx:0");
  await flushed();
  const second = parseKittyGraphicsCommands(writes[1]);
  assert.deepEqual(second.map((c) => `${c.control.a}${c.control.i}`), ["t22", "d11", "p22"]);
  assert.equal(second[0].control.t, "t");
  assert.equal(Buffer.from(second[0].payloadBase64, "base64").toString(), "/tmp/tty-graphics-protocol-vt-1-1.rgba");
  assert.equal(second[1].control.d, "i", "the hold's data stays");
  assert.equal(surface.shown, "tx:0");
  assert.equal(surface.show("missing"), false);

  // Pi deleted every placement in a frame: the shown image goes back before the frame ends.
  terminal.write("\x1b[?2026h\x1b_Ga=d,d=a,q=2\x1b\\rows\x1b[?2026l");
  assert.match(writes.at(-1), /rows\x1b7\x1b\[1;1H\x1b_Ga=p,i=22,[^\x1b]*\x1b\\\x1b8\x1b\[\?2026l$/);
  // Pi freed the images at a new size: the surface forgets them and asks for them again.
  terminal.columns = 100;
  terminal.write("\x1b[?2026h\x1b_Ga=d,d=A,q=2\x1b\\\x1b[2J\x1b[?2026l");
  await flushed();
  assert.deepEqual(lost, ["tx:0"]);
  assert.equal(resized, 1);
  assert.equal(surface.has("hold:a"), false);
  assert.equal(surface.shown, null);
  // Ordinary output passes through untouched.
  terminal.write("plain");
  assert.equal(writes.at(-1), "plain");
  // Drop frees; dispose frees what is left and unhooks.
  surface.upload("hold:b", { medium: "d", data: "", width: 1, height: 1 });
  surface.drop("hold:b");
  await flushed();
  assert.equal(parseKittyGraphicsCommands(writes.at(-1)).at(-1).control.d, "I");
  surface.upload("hold:c", { medium: "d", data: "", width: 1, height: 1 });
  await flushed();
  surface.dispose();
  assert.deepEqual(parseKittyGraphicsCommands(writes.at(-1)).map((c) => `${c.control.a}${c.control.d}`), ["dI"]);
  terminal.write("after");
  assert.equal(writes.at(-1), "after", "unhooked");
});

test("TUI surface: file transport when local; under in tmux; nothing outside fullscreen", async () => {
  const { terminal, writes } = fakeTerminal();
  assert.equal(createTuiBackdropSurface({ tui: { mode: "fullscreen", terminal }, env: {}, options: () => ({ transport: "auto" }), ids: [1] }).transport(), "file");
  assert.equal(createTuiBackdropSurface({ tui: { mode: "fullscreen", terminal }, env: { SSH_CONNECTION: "x" }, options: () => ({ transport: "auto" }), ids: [1] }).transport(), "stream");
  const tmux = createTuiBackdropSurface({ tui: { mode: "fullscreen", terminal }, env: { TMUX: "/tmp/tmux" }, options: () => ({}), ids: [1, 2] });
  assert.equal(tmux.transport(), "stream");
  tmux.upload("k", { medium: "d", data: "", width: 1, height: 1 });
  tmux.show("k");
  await flushed();
  assert.match(writes.at(-1), /\x1bPtmux;/, "passthrough");
  assert.equal(parseKittyGraphicsCommands(writes.at(-1)).find((c) => c.control.a === "p").control.z, String(BACKDROP_Z.under));
  tmux.dispose();
  const regular = createTuiBackdropSurface({ tui: { mode: "regular", terminal }, env: {}, options: () => ({}), ids: [1, 2] });
  assert.equal(regular.size(), null);
  regular.upload("k", { medium: "d", data: "", width: 1, height: 1 });
  assert.equal(regular.show("k"), false);
});

test("the encoded backdrop is a valid RGBA PNG", () => {
  const png = encodeBackdropPng({ width: 3, height: 2, rgba: new Uint8Array(24).fill(200) });
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  const idat = png.indexOf("IDAT");
  const length = png.readUInt32BE(idat - 4);
  const raw = inflateSync(png.subarray(idat + 4, idat + 4 + length));
  assert.equal(raw.length, 2 * (3 * 4 + 1));
});

/** pi-client's pane backdrop (ctx.ui.backdrop()), recording what it is asked. */
function fakeBackdrop(name) {
  const keys = new Set();
  const listeners = { resize: [], lost: [], close: [] };
  const backdrop = {
    name, log: [], shownKey: null, visible: true,
    size: () => (backdrop.visible ? { cols: 40, rows: 12, cellWidthPx: 10, cellHeightPx: 20 } : undefined),
    transport: () => "stream",
    has: (key) => keys.has(key),
    upload(key) { keys.add(key); backdrop.log.push(`upload ${key}`); },
    show(key, options) { if (key !== null && !keys.has(key)) return false; backdrop.shownKey = key; backdrop.log.push(`show ${key} ${options?.layer}`); return true; },
    get shown() { return backdrop.shownKey; },
    drop(key) { keys.delete(key); if (backdrop.shownKey === key) backdrop.shownKey = null; },
    clear() { keys.clear(); backdrop.shownKey = null; backdrop.log.push("clear"); },
    onResize(fn) { listeners.resize.push(fn); return () => {}; },
    onLost(fn) { listeners.lost.push(fn); return () => {}; },
    onClose(fn) { listeners.close.push(fn); return () => {}; },
    close() { for (const fn of listeners.close) fn(); },
  };
  return backdrop;
}

test("extension in pi-client: each pane paints its own session; prompts over the chat endpoint; panes hold still unfocused", async () => {
  const { createVisualThoughtsExtension } = await import("../extensions/visual-thoughts.js");
  const dir = mkdtempSync(join(tmpdir(), "vt-ext-"));
  const handlers = new Map();
  const commands = new Map();
  const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]), registerCommand: (name, def) => commands.set(name, def) };
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (url.endsWith("/v1/chat/completions")) return new Response(JSON.stringify({ choices: [{ message: { content: `scene for ${body.messages[1].content.length} chars` } }] }));
    return new Response(JSON.stringify({ data: [{ b64_json: solidPng(16, 9, [requests.length * 20, 40, 60]).toString("base64") }] }));
  };
  const extension = createVisualThoughtsExtension({
    settings: { agentUtils: { visualThoughts: { enabled: true, firstChars: 5, minIntervalMs: 0, fadeMs: 0 } } },
    env: { PI_VISUAL_THOUGHTS_DIR: dir, LITELLM_BASE_URL: "http://proxy:4000", LITELLM_MASTER_KEY: "k" },
    fetchImpl,
  });
  extension(pi);
  const left = fakeBackdrop("left");
  const right = fakeBackdrop("right");
  const notices = [];
  const ctxFor = (backdrop, sessionId) => ({
    ui: { backdrop: () => backdrop, notify: (message) => notices.push(message), setStatus() {} },
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [], getBranch: () => [] },
  });
  const emit = async (name, event, ctx) => { for (const fn of handlers.get(name) || []) await fn(event, ctx); };
  const waitFor = async (what, check) => { for (let i = 0; i < 400; i += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error(`timed out: ${what}`); };
  try {
    // The left pane's session runs: its prompt goes to the chat endpoint (no model registry here).
    const leftCtx = ctxFor(left, "s-left");
    await emit("session_start", {}, leftCtx);
    await emit("agent_start", {}, leftCtx);
    await emit("message_end", { message: { role: "user", content: [{ type: "text", text: "draw the harbour" }] } }, leftCtx);
    await waitFor("the left pane's image shown", () => left.log.some((line) => /^show hold:/.test(line)));
    const chat = requests.find((r) => r.url.endsWith("/chat/completions"));
    assert.equal(chat.url, "http://proxy:4000/v1/chat/completions");
    assert.equal(chat.body.model, "deepseek-v4-flash");
    assert.match(chat.body.messages[1].content, /\[prompt\] draw the harbour/);
    assert.ok(left.log.some((line) => line.endsWith(" over")), "shown over cell backgrounds by default");

    // Focus moves to the right pane, another session: it gets its own engine; the left holds still.
    const rightCtx = ctxFor(right, "s-right");
    await emit("session_start", {}, rightCtx);
    await emit("agent_start", {}, rightCtx);
    await emit("message_end", { message: { role: "assistant", content: [{ type: "thinking", thinking: "the lighthouse beam sweeps" }, { type: "text", text: "Done." }] } }, rightCtx);
    await waitFor("the right pane's image shown", () => right.log.some((line) => /^show hold:/.test(line)));
    assert.match(requests.filter((r) => r.url.endsWith("/chat/completions")).at(-1).body.messages[1].content, /\[thinking\] the lighthouse beam sweeps/);

    // The right pane switches to another session: its old one's images go.
    await emit("session_start", {}, ctxFor(right, "s-other"));
    assert.ok(right.log.includes("clear"));
    // A closed pane's engine goes with it; /thoughts off clears the rest.
    left.close();
    await commands.get("thoughts").handler("off", rightCtx);
    assert.equal(right.shownKey, null);
    await emit("session_shutdown", {}, rightCtx);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TUI surface: with pi-graphics' canvas on, the backdrop blends just above its background and returns after it clears", async () => {
  const CANVAS = Symbol.for("agent-utils.pi-graphics.canvas");
  const listeners = new Set();
  const canvas = { active: true, zBase: -1_000_000, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const previous = globalThis[CANVAS];
  globalThis[CANVAS] = canvas;
  try {
    const { terminal, writes } = fakeTerminal();
    const lost = [];
    const surface = createTuiBackdropSurface({ tui: { mode: "fullscreen", terminal }, env: {}, options: () => ({ layer: "over" }), onLost: (key) => lost.push(key), cellSize: () => ({ widthPx: 10, heightPx: 20 }), ids: [7, 8] });
    surface.upload("hold:a:1", { medium: "d", data: "", width: 1, height: 1 });
    surface.show("hold:a:1");
    await flushed();
    assert.equal(parseKittyGraphicsCommands(writes.at(-1)).find((c) => c.control.a === "p").control.z, String(-1_000_000 + CANVAS_BLEND_Z));
    // The canvas cleared the screen (its own write): the images are gone, the engine hears it.
    for (const listener of listeners) listener("cleared");
    await flushed();
    assert.deepEqual(lost, ["hold:a:1"]);
    assert.equal(surface.has("hold:a:1"), false);
    // Canvas off: the ordinary layer again.
    canvas.active = false;
    surface.upload("hold:a:2", { medium: "d", data: "", width: 1, height: 1 });
    surface.show("hold:a:2");
    await flushed();
    assert.equal(parseKittyGraphicsCommands(writes.at(-1)).find((c) => c.control.a === "p").control.z, String(BACKDROP_Z.over));
    surface.dispose();
    assert.equal(listeners.size, 0, "unsubscribed");
  } finally {
    globalThis[CANVAS] = previous;
  }
});
