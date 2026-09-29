// Terminal input tap and pixel-geometry discovery for Pi graphics.
//
// Pi's ProcessTerminal forwards every parsed input sequence through its
// `inputHandler` field (set in `start()`, including after a regular <->
// fullscreen renderer switch). Replacing that field with an accessor lets us
// observe — and in full-canvas mode rewrite — input *before* any TUI input
// listener runs, without patching Pi internals or racing listener order.

const TAP_KEY = Symbol.for("agent-utils.piGraphics.terminalInputTap");

const CELL_SIZE_RE = /^\x1b\[6;(\d+);(\d+)t$/;
const TEXT_AREA_RE = /^\x1b\[4;(\d+);(\d+)t$/;

export function parsePixelGeometryReply(data) {
  const cell = CELL_SIZE_RE.exec(data);
  if (cell) return { kind: "cell", heightPx: Number(cell[1]), widthPx: Number(cell[2]) };
  const area = TEXT_AREA_RE.exec(data);
  if (area) return { kind: "textArea", heightPx: Number(area[1]), widthPx: Number(area[2]) };
  return null;
}

/**
 * Install (or join) the tap on a terminal. Multiple independent handlers may
 * register; each returns undefined (pass), a string (replace) or null
 * (swallow). The accessor survives terminal restarts because Pi re-assigns
 * `inputHandler`, which goes through our setter.
 */
export function tapTerminalInput(terminal, handler) {
  if (!terminal || typeof handler !== "function") return () => {};
  let slot = terminal[TAP_KEY];
  if (!slot) {
    const descriptor = Object.getOwnPropertyDescriptor(terminal, "inputHandler");
    let raw = descriptor && "value" in descriptor ? descriptor.value : terminal.inputHandler;
    const handlers = new Set();
    const wrapped = (data) => {
      let current = data;
      for (const fn of handlers) {
        let next;
        try { next = fn(current); } catch { next = undefined; }
        if (next === null) return undefined;
        if (typeof next === "string") current = next;
        if (current.length === 0) return undefined;
      }
      return typeof raw === "function" ? raw(current) : undefined;
    };
    slot = { handlers, descriptor, get raw() { return raw; } };
    Object.defineProperty(terminal, "inputHandler", {
      configurable: true,
      enumerable: true,
      get() { return typeof raw === "function" ? wrapped : raw; },
      set(value) { raw = value; },
    });
    slot.restore = () => {
      const current = raw;
      delete terminal.inputHandler;
      if (slot.descriptor && "value" in slot.descriptor) {
        Object.defineProperty(terminal, "inputHandler", { ...slot.descriptor, value: current });
      } else {
        terminal.inputHandler = current;
      }
      delete terminal[TAP_KEY];
    };
    terminal[TAP_KEY] = slot;
  }
  slot.handlers.add(handler);
  return () => {
    const current = terminal[TAP_KEY];
    if (!current) return;
    current.handlers.delete(handler);
    if (current.handlers.size === 0) current.restore();
  };
}

/**
 * Track the terminal's pixel geometry. Observes `CSI 6;h;w t` (cell size) and
 * `CSI 4;h;w t` (text area) replies — Pi itself consumes the cell-size reply,
 * so this tap only peeks — and can query on demand.
 */
export function createPixelGeometryTracker({ onChange = () => {} } = {}) {
  const geometry = { cellWidthPx: 0, cellHeightPx: 0, textAreaWidthPx: 0, textAreaHeightPx: 0 };
  let untap = null;
  let terminal = null;
  const handler = (data) => {
    if (typeof data !== "string" || data.length > 24 || !data.startsWith("\x1b[")) return undefined;
    const reply = parsePixelGeometryReply(data);
    if (!reply) return undefined;
    let changed = false;
    if (reply.kind === "cell" && reply.widthPx > 0 && reply.heightPx > 0) {
      changed = geometry.cellWidthPx !== reply.widthPx || geometry.cellHeightPx !== reply.heightPx;
      geometry.cellWidthPx = reply.widthPx;
      geometry.cellHeightPx = reply.heightPx;
      if (changed) try { onChange({ ...geometry }); } catch {}
      return undefined; // let Pi consume its own cell-size reply
    }
    if (reply.kind === "textArea" && reply.widthPx > 0 && reply.heightPx > 0) {
      changed = geometry.textAreaWidthPx !== reply.widthPx || geometry.textAreaHeightPx !== reply.heightPx;
      geometry.textAreaWidthPx = reply.widthPx;
      geometry.textAreaHeightPx = reply.heightPx;
      if (changed) try { onChange({ ...geometry }); } catch {}
      return null; // Pi never asks for this one; do not leak it as input
    }
    return undefined;
  };
  return {
    geometry,
    attach(nextTerminal) {
      if (!nextTerminal || terminal === nextTerminal) return;
      untap?.();
      terminal = nextTerminal;
      untap = tapTerminalInput(terminal, handler);
    },
    query(write = terminal?.write?.bind(terminal)) {
      try { write?.("\x1b[16t\x1b[14t"); } catch {}
    },
    known() { return geometry.cellWidthPx > 0 && geometry.cellHeightPx > 0; },
    dispose() { untap?.(); untap = null; terminal = null; },
  };
}
