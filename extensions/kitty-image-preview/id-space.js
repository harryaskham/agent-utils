// Scoped kitty graphics ID allocation for the kitty image preview extension.
//
// The preview widget shares the same terminal-global kitty graphics namespace as
// pi-graphics chrome. Delegate to pi-graphics' session/pid-scoped allocators so
// static galleries, Unicode virtual placements, and screenshot streams cannot
// collide with stale images from another Pi/caco pane. Keep the preview-specific
// prefix in the name segment so pi-graphics and image-preview remain separately
// searchable while sharing one namespace contract.

import {
  piGraphicsImageId,
  piGraphicsPlacementId,
  piGraphicsPlaceholderPlacementId,
} from "../pi-graphics/id-space.js";

export const KITTY_IMAGE_PREVIEW_ID_PREFIX = "kitty-image-preview.v2";

function previewName(name) {
  return `${KITTY_IMAGE_PREVIEW_ID_PREFIX}.${String(name ?? "image")}`;
}

export function kittyPreviewImageId(name, options = {}) {
  return piGraphicsImageId(previewName(name), options);
}

export function kittyPreviewPlacementId(name, options = {}) {
  return piGraphicsPlacementId(previewName(name), options);
}

export function kittyPreviewPlaceholderPlacementId(name, options = {}) {
  return piGraphicsPlaceholderPlacementId(previewName(name), options);
}

export function kittyPreviewItemName({ absolutePath, mtimeMs, size } = {}) {
  return `item.${String(absolutePath ?? "unknown")}.${Number(mtimeMs) || 0}.${Number(size) || 0}`;
}

export function kittyPreviewDefaultPlacementId(options = {}) {
  return kittyPreviewPlaceholderPlacementId("placement.main", options);
}
