// Reserved kitty graphics z-index values for Pi-owned graphics.
//
// Cacophony-hosted Pi sessions can clear stale Pi graphics on view switch/blur
// by issuing kitty delete-by-z-index commands for this small explicit set,
// instead of using a global delete-all or maintaining a Pi<->caco image
// registry. Keep these values dedicated to Pi graphics surfaces.

export const PI_GRAPHICS_Z = Object.freeze({
  BOX_CHROME: -1073741823,
  ANCHOR: -1073741824,
  SURFACE: -1073741825,
  BACKGROUND: -1073741826,
  DEEP_BACKGROUND: -1073741827,
});

export const PI_GRAPHICS_RESERVED_Z_INDICES = Object.freeze([
  PI_GRAPHICS_Z.BOX_CHROME,
  PI_GRAPHICS_Z.ANCHOR,
  PI_GRAPHICS_Z.SURFACE,
  PI_GRAPHICS_Z.BACKGROUND,
  PI_GRAPHICS_Z.DEEP_BACKGROUND,
]);

export const PI_GRAPHICS_RESERVED_Z_INDEX_MIN = Math.min(...PI_GRAPHICS_RESERVED_Z_INDICES);
export const PI_GRAPHICS_RESERVED_Z_INDEX_MAX = Math.max(...PI_GRAPHICS_RESERVED_Z_INDICES);
