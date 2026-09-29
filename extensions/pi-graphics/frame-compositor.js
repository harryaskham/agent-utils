// Frame compositor for Pi graphics.
//
// Why this exists
// ---------------
// Real (non-virtual) Kitty placements need a screen position. Historically the
// extension parented them to a Unicode-placeholder *virtual* placement and
// relied on `P/Q/H/V` relative placement. That fails in practice:
//   * Ghostty does not position children of virtual parents (they land at
//     whatever the terminal cursor happened to be) — cursor halos, footer
//     underlays and relative borders drifted or vanished.
//   * Pi fullscreen deletes every visible placement (`a=d,d=a`) and clears the
//     screen on full redraws, so once-emitted relative placements disappeared
//     permanently.
//   * The placements were emitted with setTimeout(0) outside Pi's synchronized
//     frame, at an arbitrary cursor position.
//
// The compositor instead wraps the active renderer's `doRender`. After Pi has
// composed a frame it knows the exact screen: fullscreen `previousScreen` or
// regular-mode `previousLines` + viewport top, plus the hardware cursor Pi
// positioned for IME. Components embed zero-width private APC markers
// (`ESC _ pi:gfx:<key> BEL`) where an overlay should anchor. The compositor
// locates them, diffs the desired placement set against what is on screen,
// and injects absolute `CUP + a=p` commands *inside the same synchronized
// update* (before ESU), wrapped in DECSC/DECRC so Pi's cursor is untouched.
// Markers are stripped from the byte stream before it reaches the terminal.

import { approximateVisibleCells } from "./ansi-width.js";

export const GFX_MARKER_PREFIX = "\x1b_pi:gfx:";
const GFX_MARKER_RE = /\x1b_pi:gfx:([^\x07\x1b]*)\x07/g;
const ESU = "\x1b[?2026l";
const HOOK_KEY = Symbol.for("agent-utils.piGraphics.frameCompositor");

/** Zero-width marker understood by pi-tui width math (APC) and stripped before output. */
export function gfxMarker(key) {
  return `${GFX_MARKER_PREFIX}${String(key).replace(/[\x00-\x1f\x7f]/g, "")}\x07`;
}

export function stripGfxMarkers(text) {
  const value = String(text ?? "");
  return value.includes(GFX_MARKER_PREFIX) ? value.replace(GFX_MARKER_RE, "") : value;
}

/** Find every marker in the visible rows. Returns Map(key -> {row, col}). */
export function scanGfxMarkers(lines, { top = 0, height = lines?.length ?? 0 } = {}) {
  const markers = new Map();
  if (!Array.isArray(lines)) return markers;
  const end = Math.min(lines.length, top + Math.max(0, height));
  for (let index = Math.max(0, top); index < end; index += 1) {
    const line = lines[index];
    if (typeof line !== "string" || !line.includes(GFX_MARKER_PREFIX)) continue;
    GFX_MARKER_RE.lastIndex = 0;
    let match;
    while ((match = GFX_MARKER_RE.exec(line)) !== null) {
      const col = approximateVisibleCells(line.slice(0, match.index));
      if (!markers.has(match[1])) markers.set(match[1], { row: index - top, col });
    }
  }
  return markers;
}

const FULLSCREEN_CURSOR_RE = /\x1b\[(\d+);(\d+)H\x1b\[\?25[hl](?:\x1b\[\?2026l)?$/;
const REGULAR_CURSOR_RE = /\x1b\[(\d+)G(?:\x1b\[\?25[hl])?$/;

/**
 * Derive frame geometry from a renderer after its doRender ran.
 * `buffer` is everything the renderer wrote during that doRender.
 */
export function analyzeFrame(renderer, buffer, previous = null) {
  const terminal = renderer?.terminal;
  const width = Math.max(1, Number(terminal?.columns) || 80);
  const height = Math.max(1, Number(terminal?.rows) || 24);
  const mode = renderer?.mode === "fullscreen" ? "fullscreen" : "regular";
  // Image data can be destroyed by the host frame itself:
  //  * `a=d,d=A` (Pi fullscreen full redraw with no Pi-owned images) deletes
  //    and frees every image in the terminal, including ours;
  //  * erase-display (`2J`/`3J`) removes on-screen placements and both Kitty
  //    and Ghostty then prune images left without any placement — so images
  //    uploaded with `a=t` for real placements vanish ("ENOENT: image not
  //    found"). Only images held by a virtual (U=1) placement survive.
  const erased = buffer.includes("\x1b[2J") || buffer.includes("\x1b[3J");
  const freed = erased || /\x1b_Ga=d,d=A[,;\x1b]/.test(buffer);
  const cleared = freed || /\x1b_Ga=d,d=a[,;\x1b]/.test(buffer);
  let lines;
  let top = 0;
  let cursor = null;
  if (mode === "fullscreen") {
    lines = Array.isArray(renderer.previousScreen) ? renderer.previousScreen : [];
    const match = FULLSCREEN_CURSOR_RE.exec(buffer);
    if (match) cursor = { row: Number(match[1]) - 1, col: Number(match[2]) - 1 };
    else if (buffer.length === 0 && previous) cursor = previous.cursor;
  } else {
    lines = Array.isArray(renderer.previousLines) ? renderer.previousLines : [];
    top = Math.max(0, Number(renderer.previousViewportTop) || 0);
    const match = REGULAR_CURSOR_RE.exec(buffer);
    if (match) {
      const row = Number(renderer.hardwareCursorRow) - top;
      cursor = row >= 0 && row < height ? { row, col: Number(match[1]) - 1 } : null;
    } else if (buffer.length === 0 && previous) cursor = previous.cursor;
  }
  // Regular mode: when Pi's content grows the terminal scrolls, and real
  // placements scroll with the text. A moved viewport therefore invalidates
  // every placement position we emitted, even if markers look unchanged.
  const scrolled = mode === "regular" && previous?.mode === "regular" && previous.top !== top;
  const resized = previous ? previous.width !== width || previous.height !== height : false;
  return {
    mode, width, height, lines, top, cursor, freed, erased,
    cleared: cleared || scrolled || resized,
    markers: scanGfxMarkers(lines, { top, height }),
  };
}

/** Insert commands just before the final synchronized-update end, else append. */
export function injectBeforeFrameEnd(buffer, injection) {
  if (!injection) return buffer;
  const index = buffer.lastIndexOf(ESU);
  if (index < 0) return `${buffer}${injection}`;
  return `${buffer.slice(0, index)}${injection}${buffer.slice(index)}`;
}

/**
 * Tracks real placements the compositor owns and emits the minimal diff.
 * Desired entries: { key, imageId, placementId, row, col, cols, rows, z,
 *   cellWidthPx, cellHeightPx } — row/col may be negative or exceed the screen;
 * the part outside the screen is cropped from the source rectangle.
 */
export function createOverlayPlacementSet({ serialize }) {
  let current = new Map();

  function place(entry, frame) {
    const cols = Math.max(1, Math.trunc(entry.cols || 1));
    const rows = Math.max(1, Math.trunc(entry.rows || 1));
    const cw = Math.max(1, Math.trunc(entry.cellWidthPx || 8));
    const ch = Math.max(1, Math.trunc(entry.cellHeightPx || 16));
    const left = Math.max(0, -entry.col);
    const topClip = Math.max(0, -entry.row);
    const right = Math.max(0, entry.col + cols - frame.width);
    const bottom = Math.max(0, entry.row + rows - frame.height);
    const visibleCols = cols - left - right;
    const visibleRows = rows - topClip - bottom;
    if (visibleCols <= 0 || visibleRows <= 0) return "";
    const control = { a: "p", i: entry.imageId, p: entry.placementId, C: 1, q: 2, z: entry.z };
    if (left || topClip || right || bottom) {
      Object.assign(control, {
        x: left * cw, y: topClip * ch, w: visibleCols * cw, h: visibleRows * ch,
        c: visibleCols, r: visibleRows,
      });
    } else {
      control.c = cols;
      control.r = rows;
    }
    const row = entry.row + topClip;
    const col = entry.col + left;
    return `\x1b[${row + 1};${col + 1}H${serialize(control)}`;
  }

  function remove(entry) {
    return serialize({ a: "d", d: "i", i: entry.imageId, p: entry.placementId, q: 2 });
  }

  function signature(entry, frame) {
    return `${entry.imageId}:${entry.placementId}:${entry.row}:${entry.col}:${entry.cols}x${entry.rows}:${entry.z}:${frame.width}x${frame.height}`;
  }

  return {
    update(frame, desired) {
      const next = new Map();
      let commands = "";
      for (const entry of desired) {
        if (!entry || entry.key == null || next.has(entry.key)) continue;
        const sig = signature(entry, frame);
        const prior = current.get(entry.key);
        if (prior && (prior.entry.imageId !== entry.imageId || prior.entry.placementId !== entry.placementId)) {
          commands += remove(prior.entry);
        }
        if (!prior || prior.sig !== sig || frame.cleared) commands += place(entry, frame);
        next.set(entry.key, { entry, sig });
      }
      for (const [key, prior] of current) {
        if (!next.has(key)) commands += remove(prior.entry);
      }
      current = next;
      return commands ? `\x1b7${commands}\x1b8` : "";
    },
    clear() {
      let commands = "";
      for (const prior of current.values()) commands += remove(prior.entry);
      current = new Map();
      return commands;
    },
    size: () => current.size,
    keys: () => [...current.keys()],
  };
}

/**
 * Install the doRender wrapper on the active renderer. `getTui()` returns the
 * stable TUI reference (Pi hands extensions a Proxy that follows renderer
 * switches); `ensure()` is cheap and re-installs after a regular<->fullscreen
 * switch creates a new renderer.
 *
 * onFrame(frame, { buffer }) may return:
 *   { replace: string }  – write this instead of Pi's frame (full canvas mode)
 *   { inject: string }   – insert before the frame's ESU (overlays)
 */
export function createFrameCompositor({ getTui, onFrame, onError = () => {} } = {}) {
  let token = Symbol("frame-compositor");
  let installedOn = null;
  let previousFrame = null;
  let frames = 0;
  let disposed = false;

  function install(tui) {
    if (!tui || disposed) return false;
    if (tui[HOOK_KEY] === token) return true;
    const proto = Reflect.getPrototypeOf(tui);
    const original = proto?.doRender;
    if (typeof original !== "function") return false;
    const myToken = token;
    const wrapped = function piGraphicsFrameCompositor(...args) {
      const terminal = this.terminal;
      if (!terminal || typeof terminal.write !== "function" || this[HOOK_KEY] !== myToken) {
        return original.apply(this, args);
      }
      const chunks = [];
      const hadOwnWrite = Object.prototype.hasOwnProperty.call(terminal, "write");
      const ownWrite = hadOwnWrite ? terminal.write : undefined;
      const realWrite = terminal.write;
      terminal.write = (data) => { chunks.push(String(data)); };
      let result;
      try {
        result = original.apply(this, args);
      } finally {
        if (hadOwnWrite) terminal.write = ownWrite;
        else delete terminal.write;
      }
      const buffer = chunks.join("");
      let output = buffer;
      try {
        const frame = analyzeFrame(this, buffer, previousFrame);
        previousFrame = frame;
        frames += 1;
        const decision = onFrame?.(frame, { buffer, renderer: this }) || {};
        if (typeof decision.replace === "string") output = decision.replace;
        else output = injectBeforeFrameEnd(stripGfxMarkers(buffer), decision.inject || "");
        if (decision.append) output += decision.append;
      } catch (error) {
        output = stripGfxMarkers(buffer);
        try { onError(error); } catch {}
      }
      if (output) realWrite.call(terminal, output);
      return result;
    };
    // Assigning through Pi's TUI proxy defines an own property on the current
    // renderer instance, shadowing the prototype method.
    tui.doRender = wrapped;
    tui[HOOK_KEY] = myToken;
    installedOn = tui;
    return true;
  }

  return {
    ensure(tui = getTui?.()) {
      try { return install(tui); } catch (error) { try { onError(error); } catch {} return false; }
    },
    get lastFrame() { return previousFrame; },
    get frames() { return frames; },
    dispose() {
      disposed = true;
      const tui = installedOn;
      installedOn = null;
      if (!tui) return;
      try {
        if (tui[HOOK_KEY] === token) {
          // Pi's TUI proxy forwards `set` but has no `deleteProperty` trap, so
          // shadow the wrapper with the prototype method instead of deleting.
          const original = Reflect.getPrototypeOf(tui)?.doRender;
          if (typeof original === "function") tui.doRender = original;
          tui[HOOK_KEY] = undefined;
        }
      } catch {}
      token = Symbol("frame-compositor-disposed");
    },
  };
}
