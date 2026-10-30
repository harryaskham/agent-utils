// Visual thoughts in TUI Pi: the backdrop as a kitty graphics image behind the whole screen.
//
// Pi's fullscreen renderer owns the screen. Frames are written between Pi's renders, each
// inside a synchronized update: the new frame goes to the idle one of two image ids, is placed
// at the top-left cell scaled to the screen, and the previous image is deleted, so a crossfade
// step never flickers. Pi deletes every placement when its own images change (`a=d,d=a`) and
// frees images on full redraws (`a=d,d=A`, erase-display); a hook on the terminal's writes puts
// the backdrop back (re-sending its data when freed) inside that same frame, before it ends.
//
// Frames travel as files the terminal reads (`t=f`) when it runs on this machine, else inline.
// The image sits under the text: above cell backgrounds (`over`, tinting tool boxes too) or
// beneath them (`under`); `auto` is `under` inside tmux (whose status line and popups must
// cover it) and `over` elsewhere (herdr paints every cell's background).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serializeKittyGraphicsChunks, serializeKittyGraphicsCommand } from "../../kitty-graphics.js";
import { piGraphicsImageId } from "../../pi-graphics/id-space.js";

export const BACKDROP_Z = Object.freeze({ over: -1_048_576, under: -1_073_741_900 });
const BSU = "\x1b[?2026h";
const ESU = "\x1b[?2026l";
const SAVE = "\x1b7";
const RESTORE = "\x1b8";
const DELETE_PLACEMENTS = /\x1b_Ga=d,d=a[,;\x1b]/;
const FREE_IMAGES = /\x1b_Ga=d,d=A[,;\x1b]/;

/** Whether frames can go as files: the terminal is on this machine (no SSH, no tmux). */
export function fileTransportUsable(env = process.env) {
  return !env.SSH_CONNECTION && !env.SSH_TTY && !env.SSH_CLIENT && !env.TMUX;
}

export function backdropLayer(layer, env = process.env) {
  if (layer === "over" || layer === "under") return layer;
  return env.TMUX ? "under" : "over";
}

/**
 * The surface on Pi's terminal. `tui` is Pi's TUI (it follows renderer switches); `options()`
 * gives `{ layer, transport }` live. `onResize()` runs when the screen's size changes.
 */
export function createTuiBackdropSurface({ tui, env = process.env, options = () => ({}), onResize = () => {}, ids } = {}) {
  const terminal = tui?.terminal;
  if (!terminal) throw new Error("visual thoughts: Pi's terminal is not available");
  const imageIds = ids || [piGraphicsImageId("visual-thoughts:a"), piGraphicsImageId("visual-thoughts:b")];
  const placementId = 1;
  const passthrough = env.TMUX ? "tmux" : "none";
  const rawWrite = (() => {
    const method = Object.getPrototypeOf(terminal)?.write;
    return typeof method === "function" ? method.bind(terminal) : terminal.write.bind(terminal);
  })();
  let dir = null;
  let fileSeq = 0;
  const files = [];
  /** What is on screen: { imageId, transmit, cols, rows, z } */
  let current = null;
  let active = 1;
  let lastSize = "";
  let hooked = false;
  let ownWrite;
  let hadOwnWrite = false;

  const serialize = (control, payload = "") => serializeKittyGraphicsCommand(control, payload, { passthrough });
  const z = () => BACKDROP_Z[backdropLayer(options().layer, env)];
  const transport = () => {
    const wanted = options().transport || "auto";
    if (wanted === "file" || wanted === "stream") return wanted;
    return fileTransportUsable(env) ? "file" : "stream";
  };

  function frameFile(png) {
    if (!dir) {
      dir = join(tmpdir(), `agent-utils-visual-thoughts-${process.pid}`);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    fileSeq += 1;
    const path = join(dir, `frame-${fileSeq}.png`);
    writeFileSync(path, png, { mode: 0o600 });
    files.push(path);
    // The current frame's file must outlive a re-send after the terminal freed images.
    while (files.length > 3) rmSync(files.shift(), { force: true });
    return path;
  }

  /** Transmit only (`a=t`): the data for a later placement. */
  function transmitCommand(imageId, png) {
    if (transport() === "file") {
      return serialize({ a: "t", f: 100, t: "f", i: imageId, q: 2 }, Buffer.from(frameFile(png)).toString("base64"));
    }
    return serializeKittyGraphicsChunks({ a: "t", f: 100, i: imageId, q: 2 }, png.toString("base64"), { passthrough });
  }

  function placeCommand(entry) {
    return `\x1b[1;1H${serialize({ a: "p", i: entry.imageId, p: placementId, c: entry.cols, r: entry.rows, z: entry.z, C: 1, q: 2 })}`;
  }

  function size() {
    if (tui.mode !== undefined && tui.mode !== "fullscreen") return null;
    const cols = Math.max(1, Number(terminal.columns) || 0);
    const rows = Math.max(1, Number(terminal.rows) || 0);
    return cols > 1 && rows > 1 ? { cols, rows } : null;
  }

  function hook() {
    if (hooked) return;
    hadOwnWrite = Object.prototype.hasOwnProperty.call(terminal, "write");
    ownWrite = hadOwnWrite ? terminal.write : undefined;
    const inner = terminal.write;
    terminal.write = function visualThoughtsWrite(data) {
      return inner.call(this, afterHostWrite(String(data)));
    };
    hooked = true;
  }

  function unhook() {
    if (!hooked) return;
    if (hadOwnWrite) terminal.write = ownWrite;
    else delete terminal.write;
    hooked = false;
  }

  /** Pi's output, with the backdrop put back when Pi removed it. */
  function afterHostWrite(data) {
    if (!current || !data.includes("\x1b")) return data;
    const freed = FREE_IMAGES.test(data) || data.includes("\x1b[2J") || data.includes("\x1b[3J");
    if (!freed && !DELETE_PLACEMENTS.test(data)) return data;
    const now = size();
    const key = now ? `${now.cols}x${now.rows}` : "";
    if (now) { current.cols = now.cols; current.rows = now.rows; }
    if (key && key !== lastSize) { lastSize = key; queueMicrotask(onResize); }
    const restore = `${SAVE}${freed ? current.transmit : ""}${placeCommand(current)}${RESTORE}`;
    const at = data.lastIndexOf(ESU);
    return at < 0 ? `${data}${restore}` : `${data.slice(0, at)}${restore}${data.slice(at)}`;
  }

  return {
    size() {
      const now = size();
      if (now) lastSize = `${now.cols}x${now.rows}`;
      return now;
    },
    show({ png }) {
      const now = size();
      if (!now) return;
      hook();
      const next = 1 - active;
      const imageId = imageIds[next];
      const transmit = transmitCommand(imageId, png);
      const entry = { imageId, transmit, cols: now.cols, rows: now.rows, z: z() };
      const previous = current;
      let out = `${BSU}${SAVE}${transmit}${placeCommand(entry)}`;
      if (previous && previous.imageId !== imageId) out += serialize({ a: "d", d: "I", i: previous.imageId, q: 2 });
      out += `${RESTORE}${ESU}`;
      rawWrite(out);
      current = entry;
      active = next;
    },
    clear() {
      if (current) rawWrite(`${SAVE}${imageIds.map((imageId) => serialize({ a: "d", d: "I", i: imageId, q: 2 })).join("")}${RESTORE}`);
      current = null;
    },
    get showing() { return Boolean(current); },
    transport,
    dispose() {
      try { this.clear(); } catch {}
      unhook();
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = null;
      files.length = 0;
    },
  };
}
