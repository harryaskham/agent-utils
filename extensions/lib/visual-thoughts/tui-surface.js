// Visual thoughts in TUI Pi: the backdrop as kitty graphics images behind the whole screen.
//
// The surface keeps named images in the terminal (`upload`), shows one of them placed over the
// screen under the text (`show`), and frees them (`drop`). Everything written in one turn of the
// event loop goes out as one synchronized update, so swapping a shown frame never flickers.
//
// Pi's fullscreen renderer owns the screen: it deletes every placement when its own images change
// (`a=d,d=a`) and frees all images on full redraws (`a=d,d=A`, erase-display). A hook on the
// terminal's writes puts the shown image back inside that same frame, before it ends; when the
// images were freed, `onLost` asks for them again.
//
// Image data comes ready for the terminal: a temporary file of raw RGBA it reads and deletes
// (`t=t`), or zlib-compressed RGBA inline (`o=z`). The image sits under the text: above cell
// backgrounds (`over`, tinting panels too) or beneath them (`under`); `auto` is `under` inside
// tmux (whose status line and popups must cover it) and `over` elsewhere (herdr paints every
// cell's background).
import { getCellDimensions } from "@earendil-works/pi-tui";

import { serializeKittyGraphicsChunks, serializeKittyGraphicsCommand } from "../../kitty-graphics.js";
import { piGraphicsImageId } from "../../pi-graphics/id-space.js";

export const BACKDROP_Z = Object.freeze({ over: -1_048_576, under: -1_073_741_900 });
/** Above pi-graphics' canvas background (and its tint), below its glow: blended into it. */
export const CANVAS_BLEND_Z = 2;
const CANVAS = Symbol.for("agent-utils.pi-graphics.canvas");

/** pi-graphics' full canvas, when it is on (/gfx full): its background's z. */
export function activeCanvas() {
  const canvas = globalThis[CANVAS];
  return canvas?.active ? canvas : null;
}
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const DELETE_PLACEMENTS = /\x1b_Ga=d,d=a[,;\x1b]/;
const FREE_IMAGES = /\x1b_Ga=d,d=A[,;\x1b]/;
const POOL = 48;

/** Whether frames can go as files: the terminal is on this machine (no SSH, no tmux). */
export function fileTransportUsable(env = process.env) {
  return !env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT && !env.TMUX;
}

export function backdropLayer(layer, env = process.env) {
  if (layer === "over" || layer === "under") return layer;
  return env.TMUX ? "under" : "over";
}

/** The kitty command that transmits a renderer payload as image `imageId` (no placement). */
export function transmitCommand(imageId, payload, passthrough = "none") {
  const base = { a: "t", f: 32, s: payload.width, v: payload.height, i: imageId, q: 2 };
  if (payload.medium === "t") return serializeKittyGraphicsCommand({ ...base, t: "t" }, Buffer.from(payload.path).toString("base64"), { passthrough });
  return serializeKittyGraphicsChunks({ ...base, ...(payload.compressed ? { o: "z" } : {}) }, payload.data, { passthrough });
}

/**
 * The surface on Pi's terminal. `tui` is Pi's TUI (it follows renderer switches); `options()`
 * gives `{ layer, transport }` live; `onResize()` runs when the screen's size changes;
 * `onLost()` when the terminal freed the images (they need uploading again).
 */
export function createTuiBackdropSurface({ tui, env = process.env, options = () => ({}), onResize = () => {}, onLost = () => {}, cellSize = getCellDimensions, ids } = {}) {
  const terminal = tui?.terminal;
  if (!terminal) throw new Error("visual thoughts: Pi's terminal is not available");
  const pool = ids || Array.from({ length: POOL }, (_, n) => piGraphicsImageId(`visual-thoughts:${n}`));
  const free = [...pool];
  const passthrough = env.TMUX ? "tmux" : "none";
  const placementId = 1;
  const rawWrite = (() => {
    const method = Object.getPrototypeOf(terminal)?.write;
    return typeof method === "function" ? method.bind(terminal) : terminal.write.bind(terminal);
  })();
  /** key → image id (uploaded and still in the terminal). */
  const keys = new Map();
  let shown = null; // { key, imageId, cols, rows, z }
  let batch = "";
  let flushing = false;
  let lastSize = "";
  let hooked = false;
  let ownWrite;
  let hadOwnWrite = false;

  const serialize = (control) => serializeKittyGraphicsCommand(control, "", { passthrough });
  // With pi-graphics' canvas on, the backdrop blends into its background (aurora, nebula, …):
  // just above it, under the canvas's glow, cards and text.
  const z = () => {
    const canvas = activeCanvas();
    return canvas && Number.isFinite(canvas.zBase) ? canvas.zBase + CANVAS_BLEND_Z : BACKDROP_Z[backdropLayer(options().layer, env)];
  };
  let unsubscribeCanvas = null;

  function screen() {
    if (tui.mode !== undefined && tui.mode !== "fullscreen") return null;
    const cols = Math.max(1, Number(terminal.columns) || 0);
    const rows = Math.max(1, Number(terminal.rows) || 0);
    return cols > 1 && rows > 1 ? { cols, rows } : null;
  }

  function placeCommand(entry) {
    return `\x1b[1;1H${serialize({ a: "p", i: entry.imageId, p: placementId, c: entry.cols, r: entry.rows, z: entry.z, C: 1, q: 2 })}`;
  }

  function queue(command) {
    if (!command) return;
    batch += command;
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => {
      flushing = false;
      const out = batch;
      batch = "";
      if (out) rawWrite(`${BSU}${SAVE}${out}${RESTORE}${ESU}`);
    });
  }

  /** Every image is gone (the host freed them, or the canvas cleared the screen). */
  function loseAll() {
    if (!keys.size && !shown) return;
    const lost = shown?.key ?? null;
    for (const imageId of keys.values()) if (!free.includes(imageId)) free.push(imageId);
    keys.clear();
    shown = null;
    queueMicrotask(() => onLost(lost));
  }

  function hook() {
    if (hooked) return;
    // The canvas starting, stopping or clearing erases the screen with its own writes.
    const canvas = globalThis[CANVAS];
    if (canvas?.subscribe && !unsubscribeCanvas) unsubscribeCanvas = canvas.subscribe(() => loseAll());
    hadOwnWrite = Object.prototype.hasOwnProperty.call(terminal, "write");
    ownWrite = hadOwnWrite ? terminal.write : undefined;
    const inner = terminal.write;
    terminal.write = function visualThoughtsWrite(data) {
      return inner.call(this, afterHostWrite(String(data)));
    };
    hooked = true;
  }

  function unhook() {
    try { unsubscribeCanvas?.(); } catch {}
    unsubscribeCanvas = null;
    if (!hooked) return;
    if (hadOwnWrite) terminal.write = ownWrite;
    else delete terminal.write;
    hooked = false;
  }

  /** Pi's output, with the backdrop put back where Pi removed it. */
  function afterHostWrite(data) {
    if (!shown || !data.includes("\x1b_G") && !data.includes("\x1b[2J") && !data.includes("\x1b[3J")) return data;
    const freed = FREE_IMAGES.test(data) || data.includes("\x1b[2J") || data.includes("\x1b[3J");
    if (!freed && !DELETE_PLACEMENTS.test(data)) return data;
    const now = screen();
    const key = now ? `${now.cols}x${now.rows}` : "";
    if (key && key !== lastSize) { lastSize = key; queueMicrotask(onResize); }
    if (freed) {
      // Every image is gone: forget them; the engine uploads what it shows again.
      loseAll();
      return data;
    }
    if (now) { shown.cols = now.cols; shown.rows = now.rows; }
    const restore = `${SAVE}${placeCommand(shown)}${RESTORE}`;
    const at = data.lastIndexOf(ESU);
    return at < 0 ? `${data}${restore}` : `${data.slice(0, at)}${restore}${data.slice(at)}`;
  }

  return {
    /** The screen in cells and the cell's device pixels; null when nothing can be shown. */
    size() {
      const now = screen();
      if (!now) return null;
      lastSize = `${now.cols}x${now.rows}`;
      const cell = cellSize?.() || {};
      return {
        ...now,
        cellWidthPx: Math.max(1, Number(cell.widthPx) || 9),
        cellHeightPx: Math.max(1, Number(cell.heightPx) || 18),
      };
    },
    /** How frames should travel: `file` (`t=t`) or `stream` (inline). */
    transport() {
      const wanted = options().transport || "auto";
      if (wanted === "file" || wanted === "stream") return wanted;
      return fileTransportUsable(env) ? "file" : "stream";
    },
    has(key) { return keys.has(key); },
    /** Put a renderer payload into the terminal under `key` (replacing what it held). */
    upload(key, payload) {
      hook();
      let imageId = keys.get(key);
      if (imageId === undefined) {
        imageId = free.shift();
        if (imageId === undefined) throw new Error("visual thoughts: out of image ids");
        keys.set(key, imageId);
      }
      queue(transmitCommand(imageId, payload, passthrough));
    },
    /** Show `key`'s image over the screen (null: nothing); the previous one's placement goes. */
    show(key) {
      const now = screen();
      const imageId = key == null ? undefined : keys.get(key);
      if (key != null && (imageId === undefined || !now)) return false;
      if (shown && shown.imageId !== imageId) queue(serialize({ a: "d", d: "i", i: shown.imageId, p: placementId, q: 2 }));
      if (imageId === undefined) { shown = null; return true; }
      const entry = { key, imageId, cols: now.cols, rows: now.rows, z: z() };
      // Placed after the old one's deletion in the same update: no frame without a backdrop.
      queue(placeCommand(entry));
      shown = entry;
      return true;
    },
    get shown() { return shown?.key ?? null; },
    /** Free `key`'s image. */
    drop(key) {
      const imageId = keys.get(key);
      if (imageId === undefined) return;
      keys.delete(key);
      if (shown?.key === key) shown = null;
      queue(serialize({ a: "d", d: "I", i: imageId, q: 2 }));
      free.push(imageId);
    },
    clear() {
      for (const key of [...keys.keys()]) this.drop(key);
      shown = null;
    },
    dispose() {
      try {
        let out = "";
        for (const imageId of keys.values()) out += serialize({ a: "d", d: "I", i: imageId, q: 2 });
        keys.clear();
        shown = null;
        batch = "";
        if (out) rawWrite(`${SAVE}${out}${RESTORE}`);
      } catch {}
      unhook();
    },
  };
}
