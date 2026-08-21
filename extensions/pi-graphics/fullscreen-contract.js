// Fullscreen Pi graphics composition contract (bd-6342e4).
//
// This module is intentionally runtime-agnostic. It records the ownership and
// lifecycle rules that the implementation slices must enforce, and provides a
// tiny lease stack for composing singleton Pi UI surfaces without restoring an
// obsolete factory over a newer extension owner.

export const FULLSCREEN_SHUTDOWN_EVENT = "session_shutdown";

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
