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

// Reserved high sub-band for pi-graphics editor-chrome image ids.
//
// Kitty image ids are terminal-global 32-bit values shared across every graphics
// consumer attached to the same tty. Pi's native read-image renderer
// (pi-tui terminal-image.js allocateImageId) hands out *random* ids across the
// whole [1, 0xfffffffe] range, and our sibling kitty-image-preview extension
// derives ids across the full namespace too. Folding pi-graphics chrome ids into
// a documented high band keeps them:
//   - disjoint from the 24-bit Unicode placeholder *placement* band
//     [0x800000, 0xffffff] (so an image id can never be mistaken for a placement id),
//   - clustered away from preview / box-rail image ids so concurrent renders inside
//     this extension are far less likely to alias one another, and
//   - always non-zero in the high byte (and <= 0xff), so Unicode placeholder cells
//     encode the full id via the high-byte diacritic instead of silently collapsing
//     to 24 bits on compliant terminals.
//
// NOTE: a reserved band LOWERS but does not ELIMINATE collisions with pi-tui's
// uniform-random allocator -- a single uniform draw still aliases any one of our
// K live ids with probability ~K/2^32. The remaining duplicate-editor-border
// visual (Unicode placeholder cells scrolling into scrollback under pi-tui's a=T
// read image) and the FD-28/29 "unmanaged mode" tty warnings originate in Pi /
// pi-tui core and are tracked as an upstream report, not fixable from this
// extension. See bd-470314.
export const PI_GRAPHICS_IMAGE_ID_BAND_BASE = 0xc0000000;
// Band spans [0xc0000000, 0xfffffffd]; size leaves the top id (0xffffffff) unused
// so folded values stay strictly below the 32-bit ceiling.
export const PI_GRAPHICS_IMAGE_ID_BAND_SIZE = 0x3ffffffe;

export function piGraphicsIdScope({ env = process.env, pid = process.pid, cwd = process.cwd() } = {}) {
  const configured = env.PI_GRAPHICS_ID_NAMESPACE || env.PI_KITTY_GRAPHICS_NAMESPACE;
  const sessionish = configured
    || env.PI_CODING_AGENT_SESSION
    || env.PI_CODING_AGENT_SESSION_FILE
    || env.PI_CODING_AGENT_DIR
    || env.CACO_AGENT_ID
    || cwd
    || "unknown-session";
  // Include pid even when an operator provided a namespace: tmux panes commonly
  // run several live Pi instances with the same home/profile namespace, and
  // kitty image ids are terminal-global. Redraw stability only needs to hold
  // inside the current process; after restart, avoiding cross-pane stale image
  // pop-in is more important than reusing old ids.
  if (env.PI_GRAPHICS_ID_NAMESPACE_EXACT === "1" || env.PI_KITTY_GRAPHICS_NAMESPACE_EXACT === "1") {
    return String(sessionish);
  }
  return `${sessionish}:pid:${pid || 0}`;
}

export function piGraphicsImageId(name, options = {}) {
  const raw = stableKittyImageId(`${PI_GRAPHICS_ID_PREFIX}.${piGraphicsIdScope(options)}.${String(name ?? "image")}`);
  // Fold the stable hash into the reserved high band. The band base has its high
  // byte set (0xc0..0xff after folding), so the result is always encodable by the
  // Unicode placeholder high-byte diacritic and never lands in the placeholder
  // placement band. Determinism and pid/namespace salting are inherited from the
  // stable hash above.
  return (PI_GRAPHICS_IMAGE_ID_BAND_BASE + (raw % PI_GRAPHICS_IMAGE_ID_BAND_SIZE)) >>> 0;
}

export function piGraphicsPlacementId(name, options = {}) {
  return stableKittyPlacementId(`${PI_GRAPHICS_ID_PREFIX}.${piGraphicsIdScope(options)}.${String(name ?? "placement")}`);
}

export function piGraphicsPlaceholderPlacementId(name, options = {}) {
  return stableKittyPlaceholderPlacementId(`${PI_GRAPHICS_ID_PREFIX}.${piGraphicsIdScope(options)}.${String(name ?? "placement")}`);
}
