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
 * The renderer's state and message handler. `handle(message)` returns the reply (and the
 * buffers to transfer), synchronously.
 */
export function createRenderCore({ dir, transport = "file", pid = process.pid } = {}) {
  /** id → { png, source?: {width,height}, hold?, tx? } */
  const images = new Map();
  let area = null; // { width, height } device pixels
  let txPixels = 400_000;
  let display = { fit: "cover", feather: 0.12, opacity: 0.3 };
  let fileSeq = 0;
  let current = null; // { seq, renderer, out }

  function encode({ width, height, rgba }) {
    if (transport === "file") {
      fileSeq += 1;
      const path = join(dir, `tty-graphics-protocol-vt-${pid}-${fileSeq}.rgba`);
      writeFileSync(path, rgba, { mode: 0o600 });
      return { medium: "t", path, width, height };
    }
    return { medium: "d", data: deflateSync(rgba, { level: 1 }).toString("base64"), compressed: true, width, height };
  }

  function ensure(id) {
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
    configure({ area: nextArea, txPixels: nextTx, fit, feather, opacity }) {
      const changed = !area || nextArea.width !== area.width || nextArea.height !== area.height || nextTx !== txPixels
        || fit !== display.fit || feather !== display.feather || opacity !== display.opacity;
      area = { width: Math.max(16, Math.round(nextArea.width)), height: Math.max(16, Math.round(nextArea.height)) };
      if (Number.isFinite(nextTx)) txPixels = nextTx;
      display = { fit, feather, opacity };
      if (changed) for (const image of images.values()) { image.hold = null; image.tx = null; }
      return { changed };
    },
    /** An image to show: kept (as PNG) and prepared now; replies with its hold payload. */
    add({ id, png }) {
      images.set(id, { png: Buffer.from(png) });
      return handlers.hold({ id });
    },
    /** The hold image's payload (again: a terminal that freed it needs it re-sent). */
    hold({ id }) {
      const image = ensure(id);
      return { id, payload: encode(image.hold) };
    },
    drop({ id }) {
      images.delete(id);
      return { id };
    },
    /** Start a transition (`from` may be null): later `frame`s render it. */
    begin({ seq, from, to, effect, seed }) {
      const b = ensure(to);
      const a = from && images.has(from) ? ensure(from) : null;
      const plan = planTransition({ width: b.tx.width, height: b.tx.height, effect, seed });
      current = { seq, renderer: createTransitionRenderer(plan, a?.tx || null, b.tx), out: new Uint8Array(b.tx.width * b.tx.height * 4) };
      return { seq, effect: plan.effect, width: b.tx.width, height: b.tx.height };
    },
    frame({ seq, k, t }) {
      if (!current || current.seq !== seq) return { seq, k, stale: true };
      const started = performance.now();
      const { plan } = current.renderer;
      current.renderer.frame(t, current.out);
      const payload = encode({ width: plan.width, height: plan.height, rgba: current.out });
      return { seq, k, payload, ms: performance.now() - started };
    },
    end({ seq }) {
      if (current?.seq === seq) current = null;
      return { seq };
    },
  };

  return {
    handle(message) {
      const handler = handlers[message?.type];
      if (!handler) return { type: "error", ref: message?.ref, error: `unknown message ${message?.type}` };
      try {
        return { type: message.type, ref: message.ref, ...handler(message) };
      } catch (error) {
        return { type: "error", ref: message.ref, error: error?.message || String(error) };
      }
    },
  };
}
