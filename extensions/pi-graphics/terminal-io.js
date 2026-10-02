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
const KITTY_PROBE_ID = 31337;
const KITTY_PROBE_RE = /^\x1b_Gi=31337(?:,[^;]*)?;([^\x1b]*)\x1b\\$/;

export function createPixelGeometryTracker({ onChange = () => {} } = {}) {
  const geometry = { cellWidthPx: 0, cellHeightPx: 0, textAreaWidthPx: 0, textAreaHeightPx: 0 };
  let untap = null;
  let terminal = null;
  const waiters = new Set();
  let kittyReply = null;
  const settle = () => { for (const fn of waiters) { try { fn(); } catch {} } };
  const handler = (data) => {
    if (typeof data !== "string") return undefined;
    // Reply to our Kitty graphics support probe (a=q): never Pi input.
    const kitty = data.length < 256 ? KITTY_PROBE_RE.exec(data) : null;
    if (kitty) { kittyReply = kitty[1] || "OK"; settle(); return null; }
    if (data.length > 24 || !data.startsWith("\x1b[")) return undefined;
    const reply = parsePixelGeometryReply(data);
    if (!reply) return undefined;
    let changed = false;
    if (reply.kind === "cell" && reply.widthPx > 0 && reply.heightPx > 0) {
      changed = geometry.cellWidthPx !== reply.widthPx || geometry.cellHeightPx !== reply.heightPx;
      geometry.cellWidthPx = reply.widthPx;
      geometry.cellHeightPx = reply.heightPx;
      if (changed) try { onChange({ ...geometry }); } catch {}
      settle();
      return undefined; // let Pi consume its own cell-size reply
    }
    if (reply.kind === "textArea" && reply.widthPx > 0 && reply.heightPx > 0) {
      changed = geometry.textAreaWidthPx !== reply.widthPx || geometry.textAreaHeightPx !== reply.heightPx;
      geometry.textAreaWidthPx = reply.widthPx;
      geometry.textAreaHeightPx = reply.heightPx;
      if (changed) try { onChange({ ...geometry }); } catch {}
      settle();
      return null; // Pi never asks for this one; do not leak it as input
    }
    return undefined;
  };
  const wait = (predicate, timeoutMs) => new Promise((resolve) => {
    if (predicate()) { resolve(true); return; }
    let timer = null;
    const check = () => {
      if (!predicate()) return;
      waiters.delete(check); clearTimeout(timer); resolve(true);
    };
    waiters.add(check);
    timer = setTimeout(() => { waiters.delete(check); resolve(predicate()); }, Math.max(1, timeoutMs));
    timer.unref?.();
  });
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
    /**
     * Resolve the cell size, actively querying when it is unknown: CSI 16 t
     * (cell px) and CSI 14 t (text-area px). If only the text area answers,
     * derive cells from the character grid. Resolves { known, source }.
     */
    async ensure({ write = terminal?.write?.bind(terminal), timeoutMs = 600, columns, rows } = {}) {
      if (geometry.cellWidthPx > 0 && geometry.cellHeightPx > 0) return { known: true, source: "cached" };
      try { write?.("\x1b[16t\x1b[14t"); } catch {}
      await wait(() => geometry.cellWidthPx > 0 || geometry.textAreaWidthPx > 0, timeoutMs);
      // Give the second reply a short grace period when one has arrived.
      if (!(geometry.cellWidthPx > 0)) await wait(() => geometry.cellWidthPx > 0, 120);
      if (geometry.cellWidthPx > 0 && geometry.cellHeightPx > 0) return { known: true, source: "csi16t" };
      const cols = Number(columns) || 0; const lines = Number(rows) || 0;
      if (geometry.textAreaWidthPx > 0 && cols > 0 && lines > 0) {
        geometry.cellWidthPx = Math.max(1, Math.round(geometry.textAreaWidthPx / cols));
        geometry.cellHeightPx = Math.max(1, Math.round(geometry.textAreaHeightPx / lines));
        try { onChange({ ...geometry }); } catch {}
        return { known: true, source: "csi14t" };
      }
      return { known: false, source: "none" };
    },
    /** Explicit cell size (settings / command) for terminals that never answer. */
    assume(widthPx, heightPx) {
      const w = Math.trunc(Number(widthPx)); const h = Math.trunc(Number(heightPx));
      if (!(w > 0 && h > 0)) return false;
      geometry.cellWidthPx = w; geometry.cellHeightPx = h;
      try { onChange({ ...geometry }); } catch {}
      return true;
    },
    /** Does the terminal speak the Kitty graphics protocol? (a=q probe) */
    async probeKittyGraphics({ write = terminal?.write?.bind(terminal), timeoutMs = 500 } = {}) {
      kittyReply = null;
      try { write?.(`\x1b_Gi=${KITTY_PROBE_ID},s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\`); } catch {}
      await wait(() => kittyReply !== null, timeoutMs);
      return kittyReply === null ? { supported: false, reply: null } : { supported: kittyReply === "OK", reply: kittyReply };
    },
    dispose() { untap?.(); untap = null; terminal = null; },
  };
}
