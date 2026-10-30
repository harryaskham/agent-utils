// Visual thoughts: the engine. While the agent works, its output feeds a digest; when enough is
// new (and the last image is old enough), a fast model writes an image prompt from it and an
// image model paints it. Finished images join the rotation, which crossfades the backdrop
// between them. Hosts supply the surface (where frames go), the prompt model and the provider;
// the engine never blocks the agent and every failure is a warning at most.
import { readFileSync, unlinkSync } from "node:fs";

import { ImageRateLimitError } from "./image-provider.js";
import { buildImagePromptRequest, createDigest, normalizeImagePrompt } from "./prompter.js";
import { createRenderer as defaultCreateRenderer } from "./renderer.js";
import { createRotation } from "./rotation.js";

const ease = (t) => t * t * (3 - 2 * t);

/**
 * `config` is the live config object (runtime changes mutate it, then call `configure()`).
 * `promptTurn(request, signal)` resolves the prompt model's reply text; `provider.generate`
 * paints; `surface` keeps named images in the terminal and shows one (tui-surface.js has the
 * shape: size, transport, has, upload, show, shown, drop, clear); `createRenderer` makes the
 * renderer (renderer.js).
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
  createRenderer = defaultCreateRenderer,
  trace = null,
}) {
  const log = typeof trace === "function" ? (line) => { try { trace(`${now()} ${line}`); } catch {} } : () => {};
  if (typeof trace === "function") {
    // Main-thread stalls, while tracing.
    let expected = Date.now() + 10;
    const lagTimer = setInterval(() => {
      const late = Date.now() - expected;
      if (late > 30) log(`stall ${late}ms`);
      expected = Date.now() + 10;
    }, 10);
    lagTimer.unref?.();
  }
  const digest = createDigest();
  const rotation = createRotation(rotationOptions());
  /** id → { id, prompt, model, batch, at, ms, png?, path?, sent? } */
  const images = new Map();
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
  let seq = 0;
  let paused = false;
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
        // Prepared (and its hold uploaded) before it joins the rotation, so it shows at once.
        await ensureHold(id);
        if (disposed || !enabled) return;
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
  // Holds: each image is uploaded once at up to the screen's resolution and placed while it is
  // shown. Transitions: the renderer draws frames at a lower resolution, uploaded and swapped at
  // `fps` (two keys, alternating), then the next image's hold takes over.

  let renderer = null;
  let areaKey = "";
  // Holds are named for the size they were made for: a resized backdrop keeps showing the old
  // one (the terminal scales it) until the new one is up, then the old one goes.
  let holdGen = 0;
  const holdKey = (id) => `hold:${id}:${holdGen}`;
  const liveHolds = new Set();
  let configuring = null;
  const holdRequests = new Map(); // id → promise
  let job = null; // { seq, from, to, frames, ready: Map(k → payload), requested: Set, shownK, alt, begun }
  let jobSeq = 0;

  function ensureRenderer() {
    if (renderer) return renderer;
    renderer = createRenderer({ transport: surface.transport?.() || "stream", useWorker: config.worker !== false, onError: (error) => warn(`visual thoughts: renderer thread failed (${error?.message || error}); rendering in this thread`) });
    return renderer;
  }

  /** The renderer configured for the surface's current size and look; null when not shown. */
  function ensureConfigured(size = surface.size()) {
    if (!size) return null;
    const area = { width: size.cols * size.cellWidthPx, height: size.rows * size.cellHeightPx };
    const key = `${area.width}x${area.height}:${config.fit}:${config.feather}:${config.opacity}:${config.transitionPixels}`;
    if (key === areaKey) return configuring;
    areaKey = key;
    holdRequests.clear();
    if (job) endJob();
    holdGen += 1;
    for (const key of [...liveHolds]) if (surface.shown !== key) { surface.drop(key); liveHolds.delete(key); }
    configuring = ensureRenderer().configure({ area, txPixels: config.transitionPixels, fit: config.fit, feather: config.feather, opacity: config.opacity });
    return configuring;
  }

  /** Make sure `id`'s hold image is in the terminal; resolves true once it is. */
  function ensureHold(id) {
    // Configured first: configuring for a new size moves holds to a new generation (key).
    const ready = ensureConfigured();
    if (!ready) return Promise.resolve(false);
    const key = holdKey(id);
    if (surface.has(key)) return Promise.resolve(true);
    let request = holdRequests.get(id);
    if (!request || request.key !== key) {
      const image = images.get(id);
      const sendPng = image && !image.sent;
      const gen = holdGen;
      request = ready
        .then(() => {
          if (disposed || !renderer) return null;
          if (!sendPng) return renderer.hold(id);
          const png = image.png || (image.path ? readFileSync(image.path) : null);
          if (!png) throw new Error(`image ${id} has no data`);
          image.sent = true;
          image.png = null; // the renderer keeps it now
          return renderer.add(id, png);
        })
        .then((reply) => {
          if (!reply || disposed || holdRequests.get(id) !== request || gen !== holdGen) return false;
          if (!images.has(id)) { void renderer.drop(id).catch(() => {}); return false; }
          surface.upload(key, reply.payload);
          liveHolds.add(key);
          return true;
        })
        .catch((error) => {
          lastError = error?.message || String(error);
          warn(`visual thoughts: ${lastError}`);
          return false;
        });
      request.key = key;
      holdRequests.set(id, request);
      // A request that did not leave the hold up is forgotten, so the next asks again.
      request.then((ok) => { if ((!ok || !surface.has(key)) && holdRequests.get(id) === request) holdRequests.delete(id); });
    }
    return request.then((ok) => ok && surface.has(key));
  }

  /** Drop terminal copies of holds that are neither shown nor about to be. */
  function trimHolds(keep) {
    for (const id of images.keys()) {
      if (keep.has(id)) continue;
      const key = holdKey(id);
      if (surface.has(key) && surface.shown !== key) { surface.drop(key); liveHolds.delete(key); holdRequests.delete(id); }
    }
  }

  function endJob() {
    if (!job) return;
    const ended = job;
    job = null;
    for (const payload of ended.ready.values()) discard(payload);
    for (const key of ["tx:0", "tx:1"]) if (surface.shown !== key) surface.drop(key);
    void renderer?.end(ended.seq).catch(() => {});
  }

  /** A frame payload never shown: its file is ours to delete. */
  function discard(payload) {
    if (payload?.medium === "t" && payload.path) { try { unlinkSync(payload.path); } catch {} }
  }

  function startJob(view) {
    if (job) endJob();
    // Configure first: a new size ends any job, and this one must outlive that.
    const ready = ensureConfigured();
    if (!ready) return;
    jobSeq += 1;
    const frames = Math.max(2, Math.round((config.fadeMs / 1000) * config.fps));
    const current = { seq: jobSeq, from: view.from, to: view.to, frames, ready: new Map(), requested: new Set(), shownK: 0, alt: 0, begun: false, failed: false };
    job = current;
    log(`job ${current.seq} ${view.from}->${view.to} frames=${frames}`);
    const holds = [ensureHold(view.to), ...(view.from ? [ensureHold(view.from)] : [])];
    ready
      .then(() => Promise.all(holds))
      .then(() => (disposed || !renderer ? Promise.reject(new Error("stopped")) : renderer.begin({ seq: current.seq, from: current.from, to: current.to, effect: config.effect, seed: (Math.random() * 2 ** 31) | 0 })))
      .then((reply) => { log(`begin ${current.seq} ${reply?.effect} ${reply?.width}x${reply?.height}`); if (job === current) { current.begun = true; pump(lastViewT); } })
      .catch((error) => { log(`begin failed ${current.seq} ${error?.message}`); if (job === current) { current.failed = true; lastError = error?.message || String(error); } });
  }

  /**
   * Keep the frames playback will want next requested: from the frame due shortly (now plus the
   * renderer's typical turnaround) a few ahead. Frames already behind playback are never asked for.
   */
  function pump(t = 0) {
    const current = job;
    if (!current?.begun) return;
    const lead = Math.max(1, Math.ceil((frameMs + 1000 / config.fps) / (config.fadeMs / current.frames)));
    const from = Math.max(current.shownK + 1, Math.ceil(t * current.frames) + 1);
    const ahead = 3;
    for (let k = from; k <= Math.min(current.frames, from + lead + ahead); k += 1) {
      if (current.requested.has(k) || current.ready.has(k)) continue;
      if (current.requested.size > ahead) break; // the renderer is busy enough
      current.requested.add(k);
      renderer.frame(current.seq, k, ease(k / current.frames)).then((reply) => {
        current.requested.delete(k);
        if (job !== current || reply.stale || k <= current.shownK) { discard(reply.payload); return; }
        current.ready.set(k, reply.payload);
        frameMs = frameMs ? frameMs * 0.8 + reply.ms * 0.2 : reply.ms;
        log(`frame ${current.seq}:${k} ${reply.ms.toFixed(1)}ms`);
      }).catch(() => { current.requested.delete(k); });
    }
  }

  let frameMs = 0;
  let lastViewT = 0;

  function scheduleRender(ms) {
    if (displayTimer) timers.clearTimeout(displayTimer);
    displayTimer = null;
    if (!Number.isFinite(ms)) return;
    displayTimer = timers.setTimeout(() => { displayTimer = null; render(); }, Math.max(4, ms));
    displayTimer?.unref?.();
  }

  function render() {
    if (!enabled || disposed) return;
    const at = now();
    // The size first: a new one moves holds to a new generation.
    if (images.size && surface.size()) ensureConfigured();
    // Paused (an unfocused pane): a transition under way finishes; then the image holds, made
    // again for a new size, but the cycle does not move on.
    if (paused && !job) {
      const id = rotation.status().current;
      if (!id) return;
      const key = holdKey(id);
      if (surface.shown === key) return;
      if (surface.has(key)) showHold(key);
      else void ensureHold(id).then((ok) => { if (ok) render(); });
      return;
    }
    const view = rotation.tick(at);
    if (!view) { scheduleRender(rotation.wakeIn(at)); return; }
    if (!surface.size()) { scheduleRender(1_000); return; }
    try {
      if (view.id) {
        if (job && job.to === view.id && surface.has(holdKey(view.id))) endJob();
        const key = holdKey(view.id);
        if (surface.shown !== key) {
          if (surface.has(key)) {
            showHold(key);
            log(`hold ${view.id}`);
            if (job) endJob();
          } else {
            void ensureHold(view.id).then((ok) => { if (ok) render(); });
          }
        }
        const { cycle, pending } = rotation.status();
        const at = cycle.indexOf(view.id);
        trimHolds(new Set([view.id, pending, cycle.length ? cycle[(at + 1) % cycle.length] : null].filter(Boolean)));
        scheduleRender(rotation.wakeIn(now()));
        return;
      }
      lastViewT = view.t;
      if (!job || job.from !== view.from || job.to !== view.to) startJob(view);
      const current = job;
      if (current && !current.failed) {
        const target = Math.min(current.frames, Math.max(1, Math.ceil(view.t * current.frames)));
        let best = 0;
        for (const k of current.ready.keys()) if (k <= target && k > best) best = k;
        if (best > current.shownK) {
          const payload = current.ready.get(best);
          for (const [k, stale] of current.ready) if (k < best) { discard(stale); current.ready.delete(k); }
          current.ready.delete(best);
          const key = `tx:${current.alt}`;
          current.alt ^= 1;
          surface.upload(key, payload);
          surface.show(key);
          log(`show ${current.seq}:${best}/${current.frames} t=${view.t.toFixed(3)}`);
          current.shownK = best;
          lastFrameAt = at;
          shownFrames += 1;
        }
        pump(view.t);
      }
      scheduleRender(1000 / Math.max(1, config.fps));
    } catch (error) {
      lastError = error?.message || String(error);
      warn(`visual thoughts: ${lastError}`);
      scheduleRender(1_000);
    }
  }

  /** Show a hold; a hold of an earlier size it replaces goes. */
  function showHold(key) {
    const previous = surface.shown;
    surface.show(key);
    if (previous && previous !== key && liveHolds.has(previous) && !previous.endsWith(`:${holdGen}`)) {
      surface.drop(previous);
      liveHolds.delete(previous);
    }
  }

  let lastFrameAt = 0;
  let shownFrames = 0;

  function dropUnused() {
    const keep = new Set(rotation.ids());
    for (const id of images.keys()) {
      if (keep.has(id)) continue;
      images.delete(id);
      for (const key of [...liveHolds]) if (key.startsWith(`hold:${id}:`)) { surface.drop(key); liveHolds.delete(key); }
      holdRequests.delete(id);
      void renderer?.drop(id).catch(() => {});
    }
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
      if (enabled) { render(); maybeGenerate(); }
      else {
        for (const controller of inflight) controller.abort();
        if (displayTimer) timers.clearTimeout(displayTimer);
        if (wakeTimer) timers.clearTimeout(wakeTimer);
        displayTimer = null; wakeTimer = null;
        endJob();
        try { surface.clear(); } catch {}
        // Images stay with the renderer; their holds upload again when shown.
        holdRequests.clear();
        setActivity("idle");
      }
    },
    get enabled() { return enabled; },
    /** Hold still (an unfocused pane) or carry on cycling. */
    pause(on) {
      paused = Boolean(on);
      if (!paused) render();
    },
    get paused() { return paused; },
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
      render();
    },
    /** The surface changed size: images are prepared again for it. */
    resized() {
      render();
    },
    /** The terminal freed the images: upload what is shown again. */
    lost() {
      log("lost");
      holdRequests.clear();
      if (job) endJob();
      render();
    },
    clear() {
      endJob();
      for (const id of images.keys()) void renderer?.drop(id).catch(() => {});
      rotation.clear();
      images.clear();
      holdRequests.clear();
      try { surface.clear(); } catch {}
    },
    /** Frames shown and the renderer's cost, for status. */
    stats() {
      return { frames: shownFrames, frameMs, threaded: renderer?.threaded ?? null, transport: renderer?.transport ?? null };
    },
    dispose() {
      if (disposed) return;
      this.setEnabled(false);
      disposed = true;
      renderer?.close();
      renderer = null;
    },
  };
}
