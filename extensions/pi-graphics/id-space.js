// Scoped kitty graphics ID allocation for the Pi graphics extension.
//
// Kitty image ids are effectively terminal-global. If a Pi process dies before
// scoped cleanup, a later process that reuses the same image/placement ids can
// make old placeholders repaint or animate in surprising places. Keep ids
// stable within one process/session for redraw caching, but salt them with a
// process/session namespace so unrelated kitty graphics consumers are unlikely
// to collide.

import {
  stableKittyImageId,
  stableKittyPlacementId,
  stableKittyPlaceholderPlacementId,
} from "../kitty-graphics.js";

export const PI_GRAPHICS_ID_PREFIX = "agent-utils.pi-graphics.v2";

export function piGraphicsIdScope({ env = process.env, pid = process.pid, cwd = process.cwd() } = {}) {
  const configured = env.PI_GRAPHICS_ID_NAMESPACE || env.PI_KITTY_GRAPHICS_NAMESPACE;
  if (configured) return String(configured);
  const sessionish = env.PI_CODING_AGENT_SESSION
    || env.PI_CODING_AGENT_SESSION_FILE
    || env.PI_CODING_AGENT_DIR
    || env.CACO_AGENT_ID
    || cwd
    || "unknown-session";
  // Include pid so two live Pi processes that share the same agent/settings dir
  // still allocate disjoint terminal ids. Redraw stability only needs to hold
  // inside the current process; after restart, avoiding stale-placeholder pop-in
  // is more important than reusing old ids.
  return `${sessionish}:pid:${pid || 0}`;
}

export function piGraphicsImageId(name, options = {}) {
  return stableKittyImageId(`${PI_GRAPHICS_ID_PREFIX}.${piGraphicsIdScope(options)}.${String(name ?? "image")}`);
}

export function piGraphicsPlacementId(name, options = {}) {
  return stableKittyPlacementId(`${PI_GRAPHICS_ID_PREFIX}.${piGraphicsIdScope(options)}.${String(name ?? "placement")}`);
}

export function piGraphicsPlaceholderPlacementId(name, options = {}) {
  return stableKittyPlaceholderPlacementId(`${PI_GRAPHICS_ID_PREFIX}.${piGraphicsIdScope(options)}.${String(name ?? "placement")}`);
}
