// Visual thoughts: the engine. While the agent works, its output feeds a digest; when enough is
// new (and the last image is old enough), a fast model writes an image prompt from it and an
// image model paints it. Finished images join the rotation, which crossfades the backdrop
// between them. Hosts supply the surface (where frames go), the prompt model and the provider;
// the engine never blocks the agent and every failure is a warning at most.
import { readFileSync } from "node:fs";

import { ImageRateLimitError } from "./image-provider.js";
import { buildImagePromptRequest, createDigest, normalizeImagePrompt } from "./prompter.js";
import { backdropRasterSize, blendBackdrops, decodeImage, encodeBackdropPng, prepareBackdrop } from "./raster.js";
import { createRotation } from "./rotation.js";

const ease = (t) => t * t * (3 - 2 * t);

/**
 * `config` is the live config object (runtime changes mutate it, then call `configure()`).
 * `promptTurn(request, signal)` resolves the prompt model's reply text; `provider.generate`
 * paints; `surface` is `{ size() → { cols, rows } | null, show({ png, width, height }), clear() }`.
 */
export function createVisualThoughtsEngine({
  config,
  promptTurn,
  provider,
  surface,
  store = null,
  now = () => Date.now(),
  timers = { setTimeout, clearTimeout },
  warn = () => {},
  onChange = () => {},
}) {
  const digest = createDigest();
  const rotation = createRotation(rotationOptions());
  /** id → { id, prompt, model, batch, at, ms, png?, path? } */
  const images = new Map();
  /** id → prepared raster for the current display key. */
  const prepared = new Map();
  let preparedKey = "";
  const inflight = new Set();
  const recentPrompts = [];
  let enabled = false;
  let disposed = false;
  let inRun = false;
  let flushAfterRun = false;
  let runCount = 0;
  let nextAllowedAt = 0;
  let failures = 0;
  let displayTimer = null;
  let wakeTimer = null;
  let lastFrameKey = "";
  let seq = 0;
  let activity = "idle"; // idle | prompting | painting
  let lastError = "";
  let generated = 0;
  let lastMs = 0;
  let currentProvider = provider;

  function rotationOptions() {
    return { holdMs: config.holdMs, fadeMs: config.fadeMs, minShowMs: config.minShowMs, minSet: config.minSet, maxImages: config.maxImages };
  }

  function setActivity(next) {
    if (activity === next) return;
    activity = next;
    try { onChange(status()); } catch {}
  }

  // ── generation ────────────────────────────────────────────────────────────

  function scheduleWake(at) {
    if (wakeTimer) return;
    wakeTimer = timers.setTimeout(() => { wakeTimer = null; maybeGenerate(); }, Math.max(50, at - now()));
    wakeTimer?.unref?.();
  }

  function maybeGenerate({ force = false } = {}) {
    if (!enabled || disposed) return false;
    if (inflight.size >= config.maxConcurrent) return false;
    if (!force) {
      if (!inRun && !flushAfterRun) return false;
      if (runCount >= config.maxPerRun) return false;
      const threshold = runCount === 0 ? config.firstChars : config.minChars;
      if (digest.pending < Math.max(1, threshold)) return false;
    }
    if (now() < nextAllowedAt) { scheduleWake(nextAllowedAt); return false; }
    flushAfterRun = false;
    void generate();
    return true;
  }

  async function generate() {
    const snapshot = digest.snapshot();
    digest.mark();
    runCount += 1;
    nextAllowedAt = now() + config.minIntervalMs;
    const batch = rotation.batch;
    const controller = new AbortController();
    inflight.add(controller);
    try {
      setActivity("prompting");
      const request = buildImagePromptRequest({ digest: snapshot, recentPrompts, style: config.style });
      const reply = await promptTurn(request, controller.signal);
      if (controller.signal.aborted) return;
      const prompt = normalizeImagePrompt(reply, { style: config.style });
      if (!prompt) throw new Error("the prompt model returned no prompt");
      recentPrompts.push(prompt);
      if (recentPrompts.length > 5) recentPrompts.shift();
      setActivity("painting");
      const result = await currentProvider.generate(prompt, { signal: controller.signal });
      if (controller.signal.aborted || disposed) return;
      seq += 1;
      const id = `vt-${now().toString(36)}-${seq}`;
      const record = { id, prompt, model: result.model, batch, at: now(), ms: result.ms };
      let path;
      if (store) {
        try { path = await store.save(record, result.png); } catch (error) { warn(`visual thoughts: could not save an image: ${error.message}`); }
      }
      images.set(id, { ...record, png: result.png, path });
      generated += 1;
      lastMs = result.ms;
      failures = 0;
      lastError = "";
      if (enabled) {
        try { prepare(id); } catch (error) { images.delete(id); throw error; }
        rotation.add({ id, batch }, now());
        dropUnused();
        render();
      }
      if (store && config.keep > 0 && generated % 8 === 0) store.prune(config.keep).catch(() => {});
    } catch (error) {
      if (controller.signal.aborted || disposed) return;
      if (error instanceof ImageRateLimitError) {
        nextAllowedAt = Math.max(nextAllowedAt, now() + error.retryAfterMs);
        lastError = error.message;
      } else {
        failures += 1;
        nextAllowedAt = Math.max(nextAllowedAt, now() + Math.min(300_000, 15_000 * 2 ** (failures - 1)));
        lastError = error?.message || String(error);
        warn(`visual thoughts: ${lastError}`);
      }
    } finally {
      inflight.delete(controller);
      if (!inflight.size) setActivity("idle");
      else try { onChange(status()); } catch {}
      maybeGenerate();
    }
  }

  // ── display ──────────────────────────────────────────────────────────────

  function displayKey(size) {
    const raster = backdropRasterSize({ cols: size.cols, rows: size.rows, detail: config.detail, cellAspect: config.cellAspect });
    return { raster, key: `${raster.width}x${raster.height}:${config.fit}:${config.feather}:${config.opacity}` };
  }

  function prepare(id, size = surface.size()) {
    if (!size) return null;
    const { raster, key } = displayKey(size);
    if (key !== preparedKey) { prepared.clear(); preparedKey = key; }
    if (prepared.has(id)) return prepared.get(id);
    const image = images.get(id);
    if (!image) return null;
    const png = image.png || (image.path ? readFileSync(image.path) : null);
    if (!png) return null;
    const ready = prepareBackdrop(decodeImage(png), { ...raster, fit: config.fit, feather: config.feather, opacity: config.opacity });
    prepared.set(id, ready);
    return ready;
  }

  /** Forget images the rotation dropped (their files stay in the store). */
  function dropUnused() {
    const keep = new Set(rotation.ids());
    for (const id of images.keys()) if (!keep.has(id)) { images.delete(id); prepared.delete(id); }
  }

  function scheduleRender(ms) {
    if (displayTimer) timers.clearTimeout(displayTimer);
    displayTimer = null;
    if (!Number.isFinite(ms)) return;
    displayTimer = timers.setTimeout(() => { displayTimer = null; render(); }, Math.max(16, ms));
    displayTimer?.unref?.();
  }

  function render() {
    if (!enabled || disposed) return;
    const at = now();
    const view = rotation.tick(at);
    if (!view) { scheduleRender(rotation.wakeIn(at)); return; }
    const size = surface.size();
    if (!size) { scheduleRender(1_000); return; }
    try {
      let frame;
      let frameKey;
      if (view.id) {
        frameKey = `${view.id}@${preparedKey}`;
        if (frameKey !== lastFrameKey) frame = prepare(view.id, size);
      } else {
        const steps = Math.max(1, Math.round(config.fadeSteps));
        const step = Math.min(steps, Math.max(1, Math.round(ease(view.t) * steps)));
        frameKey = `${view.from}>${view.to}:${step}/${steps}@${preparedKey}`;
        if (frameKey !== lastFrameKey) {
          const to = prepare(view.to, size);
          const from = view.from ? prepare(view.from, size) : null;
          if (to) frame = step >= steps ? to : blendBackdrops(from, to, step / steps);
        }
      }
      if (frame) {
        surface.show({ png: encodeBackdropPng(frame), width: frame.width, height: frame.height });
        lastFrameKey = frameKey;
      }
    } catch (error) {
      lastError = error?.message || String(error);
      warn(`visual thoughts: ${lastError}`);
    }
    const wake = view.id ? rotation.wakeIn(now()) : Math.max(16, config.fadeMs / Math.max(1, config.fadeSteps));
    scheduleRender(wake);
  }

  function status() {
    return {
      enabled,
      activity,
      inRun,
      runCount,
      generated,
      lastMs,
      lastError,
      provider: currentProvider?.describe?.() || "",
      waitMs: Math.max(0, nextAllowedAt - now()),
      prompt: recentPrompts.at(-1) || "",
      ...rotation.status(),
    };
  }

  return {
    status,
    /** Output while the agent works: `kind` thinking | text | tool | result | user. */
    output(kind, text) {
      if (!enabled || disposed) return;
      digest.add(kind, text);
      maybeGenerate();
    },
    /** An agent run begins (a prompt): its images form a new batch. */
    runStart() {
      inRun = true;
      flushAfterRun = false;
      runCount = 0;
      rotation.newBatch();
    },
    /** The run ended: one last image from what is left, if enough. */
    runEnd() {
      inRun = false;
      if (enabled && runCount < config.maxPerRun && digest.pending >= Math.max(1, config.firstChars)) {
        flushAfterRun = true;
        maybeGenerate();
      }
    },
    setEnabled(next) {
      if (disposed) return;
      enabled = Boolean(next);
      if (enabled) { lastFrameKey = ""; render(); maybeGenerate(); }
      else {
        for (const controller of inflight) controller.abort();
        if (displayTimer) timers.clearTimeout(displayTimer);
        if (wakeTimer) timers.clearTimeout(wakeTimer);
        displayTimer = null; wakeTimer = null; lastFrameKey = "";
        try { surface.clear(); } catch {}
        setActivity("idle");
      }
    },
    get enabled() { return enabled; },
    /** Paint from the current output now, regardless of thresholds (not of rate limits). */
    generateNow() {
      if (!enabled) return false;
      return maybeGenerate({ force: true });
    },
    /** Crossfade to the next image now. */
    next() {
      rotation.skip(now());
      render();
    },
    /** Images from an earlier run of this session (store records with paths), shown at once. */
    restore(records = []) {
      for (const record of records) {
        if (!record?.id || images.has(record.id)) continue;
        images.set(record.id, { id: record.id, prompt: record.prompt, model: record.model, batch: -1, at: record.at, path: record.path });
        rotation.add({ id: record.id, batch: -1 }, now());
        if (record.prompt) { recentPrompts.push(record.prompt); if (recentPrompts.length > 5) recentPrompts.shift(); }
      }
      dropUnused();
      render();
    },
    /** Apply changed display/generation settings (and a new provider, if given). */
    configure({ provider: nextProvider } = {}) {
      if (nextProvider) currentProvider = nextProvider;
      rotation.configure(rotationOptions());
      dropUnused();
      prepared.clear();
      preparedKey = "";
      lastFrameKey = "";
      render();
    },
    /** The surface changed size: re-prepare and redraw. */
    resized() {
      lastFrameKey = "";
      render();
    },
    clear() {
      rotation.clear();
      images.clear();
      prepared.clear();
      lastFrameKey = "";
      try { surface.clear(); } catch {}
    },
    dispose() {
      if (disposed) return;
      this.setEnabled(false);
      disposed = true;
    },
  };
}
