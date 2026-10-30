// Visual thoughts: the renderer, run on a worker thread (render-worker.js) or, failing that, in
// the calling thread. It decodes and fits images, renders transition frames, and encodes both
// for the terminal: raw RGBA written to a temporary file the terminal reads and deletes (`t=t`,
// when the terminal is on this machine), else zlib-compressed RGBA inline (`o=z`). The main
// thread only forwards the result, so a 60 fps crossfade costs it a few hundred bytes a frame.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { createTransitionRenderer, planTransition } from "./effects.js";
import { decodeImage, prepareBackdrop } from "./raster.js";

/** Largest hold image (device pixels): a still image needs no more than the screen or its source. */
const MAX_HOLD_PIXELS = 4_200_000;

/**
 * The hold size for a source on an area (device pixels): the area's aspect, no larger than the
 * area, the source's visible part (cover crops it) or MAX_HOLD_PIXELS.
 */
export function holdSize(source, area, fit = "cover") {
  const aspect = area.width / area.height;
  let width = area.width;
  let height = area.height;
  // Source pixels across the visible part: cover shows a crop, contain/stretch the whole image.
  const visibleWidth = fit === "cover" ? Math.min(source.width, source.height * aspect) : source.width;
  const scale = Math.min(1, visibleWidth / width, Math.sqrt(MAX_HOLD_PIXELS / (width * height)));
  width = Math.max(16, Math.round(width * scale));
  height = Math.max(16, Math.round(width / aspect));
  return { width, height };
}

/** The transition size for an area: its aspect, at most `pixels`. */
export function transitionSize(area, pixels = 400_000) {
  const scale = Math.min(1, Math.sqrt(pixels / (area.width * area.height)));
  return { width: Math.max(16, Math.floor(area.width * scale)), height: Math.max(16, Math.floor(area.height * scale)) };
}

/**
 * The renderer's state and message handler. `handle(message)` returns the reply, synchronously.
 * Each message names its context (`ctx`: one per backdrop, so one renderer serves every pane);
 * a context has its own area, look, images and transition.
 */
export function createRenderCore({ dir, transport = "file", pid = process.pid } = {}) {
  const contexts = new Map();
  let fileSeq = 0;

  function context(name = "default") {
    let state = contexts.get(name);
    if (!state) {
      state = { images: new Map(), area: null, txPixels: 400_000, display: { fit: "cover", feather: 0.12, opacity: 0.3 }, current: null };
      contexts.set(name, state);
    }
    return state;
  }

  function encode({ width, height, rgba }) {
    if (transport === "file") {
      fileSeq += 1;
      const path = join(dir, `tty-graphics-protocol-vt-${pid}-${fileSeq}.rgba`);
      writeFileSync(path, rgba, { mode: 0o600 });
      return { medium: "t", path, width, height };
    }
    return { medium: "d", data: deflateSync(rgba, { level: 1 }).toString("base64"), compressed: true, width, height };
  }

  function ensure(state, id) {
    const { images, area, txPixels, display } = state;
    const image = images.get(id);
    if (!image) throw new Error(`no image ${id}`);
    if (!area) throw new Error("no display area yet");
    if (!image.hold || !image.tx) {
      const source = decodeImage(image.png);
      image.source = { width: source.width, height: source.height };
      if (!image.hold) image.hold = prepareBackdrop(source, { ...holdSize(source, area, display.fit), ...display });
      if (!image.tx) image.tx = prepareBackdrop(source, { ...transitionSize(area, txPixels), ...display });
    }
    return image;
  }

  const handlers = {
    /** Display geometry and look; prepared rasters for another size or look are dropped. */
    configure(state, { area: nextArea, txPixels: nextTx, fit, feather, opacity }) {
      const { area, txPixels, display } = state;
      const changed = !area || nextArea.width !== area.width || nextArea.height !== area.height || nextTx !== txPixels
        || fit !== display.fit || feather !== display.feather || opacity !== display.opacity;
      state.area = { width: Math.max(16, Math.round(nextArea.width)), height: Math.max(16, Math.round(nextArea.height)) };
      if (Number.isFinite(nextTx)) state.txPixels = nextTx;
      state.display = { fit, feather, opacity };
      if (changed) for (const image of state.images.values()) { image.hold = null; image.tx = null; }
      return { changed };
    },
    /** An image to show: kept (as PNG) and prepared now; replies with its hold payload. */
    add(state, { id, png }) {
      state.images.set(id, { png: Buffer.from(png) });
      return handlers.hold(state, { id });
    },
    /** The hold image's payload (again: a terminal that freed it needs it re-sent). */
    hold(state, { id }) {
      const image = ensure(state, id);
      return { id, payload: encode(image.hold) };
    },
    drop(state, { id }) {
      state.images.delete(id);
      return { id };
    },
    /** Start a transition (`from` may be null): later `frame`s render it. */
    begin(state, { seq, from, to, effect, seed }) {
      const b = ensure(state, to);
      const a = from && state.images.has(from) ? ensure(state, from) : null;
      const plan = planTransition({ width: b.tx.width, height: b.tx.height, effect, seed });
      state.current = { seq, renderer: createTransitionRenderer(plan, a?.tx || null, b.tx), out: new Uint8Array(b.tx.width * b.tx.height * 4) };
      return { seq, effect: plan.effect, width: b.tx.width, height: b.tx.height };
    },
    frame(state, { seq, k, t }) {
      const { current } = state;
      if (!current || current.seq !== seq) return { seq, k, stale: true };
      const started = performance.now();
      const { plan } = current.renderer;
      current.renderer.frame(t, current.out);
      const payload = encode({ width: plan.width, height: plan.height, rgba: current.out });
      return { seq, k, payload, ms: performance.now() - started };
    },
    end(state, { seq }) {
      if (state.current?.seq === seq) state.current = null;
      return { seq };
    },
    /** The context's backdrop is gone: forget everything it had. */
    release(state, message) {
      contexts.delete(message.ctx ?? "default");
      return {};
    },
  };

  return {
    handle(message) {
      const handler = handlers[message?.type];
      if (!handler) return { type: "error", ref: message?.ref, error: `unknown message ${message?.type}` };
      try {
        return { type: message.type, ref: message.ref, ...handler(context(message.ctx), message) };
      } catch (error) {
        return { type: "error", ref: message.ref, error: error?.message || String(error) };
      }
    },
  };
}
