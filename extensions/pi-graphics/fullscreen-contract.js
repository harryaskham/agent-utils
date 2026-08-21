// Fullscreen Pi graphics composition contract (bd-6342e4).
//
// This module is intentionally runtime-agnostic. It records the ownership and
// lifecycle rules that the implementation slices must enforce, and provides a
// tiny lease stack for composing singleton Pi UI surfaces without restoring an
// obsolete factory over a newer extension owner.

export const FULLSCREEN_SHUTDOWN_EVENT = "session_shutdown";
export const EDITOR_CHROME_REGISTRY = Symbol.for("agent-utils.editor-chrome-registry");

export const FULLSCREEN_SURFACE_CONTRACT = Object.freeze({
  editor: Object.freeze({ api: "setEditorComponent", ownership: "lease-stack", quietWhenOff: true }),
  footer: Object.freeze({ api: "setFooter", ownership: "lease-stack", quietWhenOff: true }),
  header: Object.freeze({ api: "setHeader", ownership: "lease-stack", quietWhenOff: true }),
  widget: Object.freeze({ api: "setWidget", ownership: "namespaced-id", quietWhenOff: true }),
  workingMessage: Object.freeze({ api: "setWorkingMessage", ownership: "lease-stack", quietWhenOff: true }),
  workingIndicator: Object.freeze({ api: "setWorkingIndicator", ownership: "lease-stack", quietWhenOff: true }),
  hardwareCursor: Object.freeze({ api: "setShowHardwareCursor", ownership: "lease-stack", quietWhenOff: true }),
  kittyImage: Object.freeze({ api: "kitty-image-id", ownership: "scoped-id", quietWhenOff: true }),
  kittyPlacement: Object.freeze({ api: "kitty-placement-id", ownership: "scoped-id", quietWhenOff: true }),
  timer: Object.freeze({ api: "timer", ownership: "registry", quietWhenOff: true }),
});

export const FULLSCREEN_MODE_MIGRATIONS = Object.freeze({
  joinedunicode: Object.freeze({ style: "unicode", unicodeMode: "topLeft", deprecated: true }),
  "joined-unicode": Object.freeze({ style: "unicode", unicodeMode: "topLeft", deprecated: true }),
  joined_unicode: Object.freeze({ style: "unicode", unicodeMode: "topLeft", deprecated: true }),
  joined: Object.freeze({ style: "unicode", unicodeMode: "topLeft", deprecated: true }),
  placeholder: Object.freeze({ style: "unicode", unicodeMode: "fill", deprecated: true }),
  caco: Object.freeze({ style: "unicode", unicodeMode: "fill", deprecated: true }),
  overlay: Object.freeze({ style: "relative", deprecated: true }),
  animated: Object.freeze({ style: "relative", animation: true, deprecated: true }),
  static: Object.freeze({ style: "static", deprecated: false }),
  unicode: Object.freeze({ style: "unicode", unicodeMode: "fill", deprecated: false }),
  relative: Object.freeze({ style: "relative", deprecated: false }),
});

export function resolveFullscreenDynamicPolicy({ tmux = false, liveEditor = false, dynamicInTmux = false, dynamic = true } = {}) {
  const liveInTerminal = !tmux || liveEditor || dynamicInTmux;
  return {
    liveInTerminal,
    dynamic: Boolean(dynamic) && liveInTerminal,
    animation: liveInTerminal,
    trailingWorkspace: liveInTerminal,
    rowBackground: liveInTerminal,
  };
}

export function resolveFullscreenEditorMode(value) {
  const key = String(value || "static").trim().toLowerCase();
  const resolved = FULLSCREEN_MODE_MIGRATIONS[key] || FULLSCREEN_MODE_MIGRATIONS.static;
  return { input: key, ...resolved, warning: resolved.deprecated ? `deprecated editor mode '${key}' maps to '${resolved.style}'` : null };
}

/**
 * Maintain composable ownership for a singleton host surface. A release removes
 * only its exact lease; it never reinstalls a stale captured factory over owners
 * registered later. Higher priority wraps later, then insertion order breaks ties.
 */
export function createSurfaceLeaseStack(baseValue = null) {
  let sequence = 0;
  const leases = [];
  return {
    acquire({ owner, decorate, priority = 0 } = {}) {
      if (!owner || typeof decorate !== "function") throw new Error("surface lease requires owner and decorate");
      const lease = Object.freeze({ owner: String(owner), decorate, priority: Number(priority) || 0, sequence: sequence++ });
      leases.push(lease);
      return lease;
    },
    release(lease) {
      const index = leases.indexOf(lease);
      if (index < 0) return false;
      leases.splice(index, 1);
      return true;
    },
    compose(value = baseValue) {
      return [...leases]
        .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
        .reduce((current, lease) => lease.decorate(current), value);
    },
    owners() {
      return [...leases]
        .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)
        .map((lease) => lease.owner);
    },
    clearOwner(owner) {
      let removed = 0;
      for (let index = leases.length - 1; index >= 0; index -= 1) {
        if (leases[index].owner === owner) {
          leases.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export function getOrCreateEditorChromeRegistry(ui, { defaultFactory = null } = {}) {
  if (!ui || typeof ui.setEditorComponent !== "function") return null;
  if (ui[EDITOR_CHROME_REGISTRY]) return ui[EDITOR_CHROME_REGISTRY];

  const originalSet = ui.setEditorComponent.bind(ui);
  const originalGet = typeof ui.getEditorComponent === "function" ? ui.getEditorComponent.bind(ui) : null;
  let baseFactory = originalGet?.() || defaultFactory;
  let sequence = 0;
  const leases = [];
  let compositeFactory = null;

  const sorted = () => [...leases].sort((a, b) => a.priority - b.priority || a.sequence - b.sequence);
  const apply = () => {
    compositeFactory = (tui, theme, keybindings) => {
      let component = typeof baseFactory === "function" ? baseFactory(tui, theme, keybindings) : null;
      for (const lease of sorted()) component = lease.decorate(component, { tui, theme, keybindings });
      return component;
    };
    compositeFactory.__agentUtilsEditorChromeComposite = true;
    originalSet(compositeFactory);
  };

  const patchedSet = function (factory, ..._rest) {
    if (factory?.__agentUtilsEditorChromeComposite) return originalSet(factory);
    baseFactory = factory || defaultFactory;
    apply();
  };
  patchedSet.__agentUtilsEditorChromeRegistry = true;
  const patchedGet = () => baseFactory;
  patchedGet.__agentUtilsEditorChromeRegistry = true;

  const registry = {
    acquire({ owner, decorate, priority = 0 } = {}) {
      if (!owner || typeof decorate !== "function") throw new Error("editor chrome lease requires owner and decorate");
      registry.releaseOwner(owner);
      const lease = Object.freeze({ owner: String(owner), decorate, priority: Number(priority) || 0, sequence: sequence++ });
      leases.push(lease);
      apply();
      return lease;
    },
    release(lease) {
      const index = leases.indexOf(lease);
      if (index < 0) return false;
      leases.splice(index, 1);
      apply();
      return true;
    },
    releaseOwner(owner) {
      let removed = 0;
      for (let index = leases.length - 1; index >= 0; index -= 1) {
        if (leases[index].owner === owner) { leases.splice(index, 1); removed += 1; }
      }
      if (removed) apply();
      return removed;
    },
    owners: () => sorted().map((lease) => lease.owner),
    baseFactory: () => baseFactory,
  };
  ui[EDITOR_CHROME_REGISTRY] = registry;
  ui.setEditorComponent = patchedSet;
  if (originalGet) ui.getEditorComponent = patchedGet;
  apply();
  return registry;
}

export function wrapEditorComponent(base, { renderRows } = {}) {
  if (!base || typeof base.render !== "function" || typeof renderRows !== "function") return base;
  const wrapper = {
    base,
    wantsKeyRelease: base.wantsKeyRelease,
    get focused() { return Boolean(base.focused); },
    set focused(value) { if ("focused" in base) base.focused = value; },
    render(width) { return renderRows(base.render(width), width); },
    handleInput(data) { return base.handleInput?.(data); },
    invalidate() { return base.invalidate?.(); },
    dispose() { return base.dispose?.(); },
  };
  return new Proxy(wrapper, {
    get(target, property, receiver) {
      if (property in target) return Reflect.get(target, property, receiver);
      const value = base[property];
      return typeof value === "function" ? value.bind(base) : value;
    },
    set(target, property, value, receiver) {
      if (property in target) return Reflect.set(target, property, value, receiver);
      base[property] = value;
      return true;
    },
  });
}

export function createFullscreenResourceOwner({
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const timeouts = new Set();
  const intervals = new Set();
  return {
    timeout(fn, delay) {
      let timer;
      timer = setTimeoutImpl(() => { timeouts.delete(timer); fn(); }, delay);
      timeouts.add(timer);
      timer?.unref?.();
      return timer;
    },
    interval(fn, delay) {
      const timer = setIntervalImpl(fn, delay);
      intervals.add(timer);
      timer?.unref?.();
      return timer;
    },
    clear(timer) {
      if (!timer) return false;
      let removed = false;
      if (timeouts.delete(timer)) { clearTimeoutImpl(timer); removed = true; }
      if (intervals.delete(timer)) { clearIntervalImpl(timer); removed = true; }
      return removed;
    },
    drain() {
      const result = { timeouts: timeouts.size, intervals: intervals.size };
      for (const timer of timeouts) clearTimeoutImpl(timer);
      for (const timer of intervals) clearIntervalImpl(timer);
      timeouts.clear();
      intervals.clear();
      return result;
    },
    counts: () => ({ timeouts: timeouts.size, intervals: intervals.size }),
  };
}

export function fullscreenQuietModeViolations(resources = {}) {
  const violations = [];
  for (const [surface, contract] of Object.entries(FULLSCREEN_SURFACE_CONTRACT)) {
    if (!contract.quietWhenOff) continue;
    const value = resources[surface];
    const active = value instanceof Set || value instanceof Map ? value.size > 0 : Array.isArray(value) ? value.length > 0 : Boolean(value);
    if (active) violations.push(surface);
  }
  return violations;
}
