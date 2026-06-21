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

// Screenshot streams reuse a SINGLE stable kitty image id and overwrite it each
// frame, instead of minting a fresh id per frame (the per-frame id keyed on
// path+mtime+size, so every captured frame transmitted under a distinct id and
// left a superseded resident surface to reclaim). Overwriting one stable id per
// stream avoids the per-frame id-minting and transmit churn entirely and keeps a
// single resident surface in flight (bd-ded98d element (d), follow-up to the
// closed bd-ad43f8). The id stays inside the session/pid-scoped preview
// namespace so concurrent managed agents cannot collide on it.
export function kittyPreviewStreamImageId(options = {}) {
  return kittyPreviewImageId("stream.latest", options);
}

// Resolve the kitty image id to use for one captured stream frame: the stream's
// stable id when present, otherwise the per-frame fallback id (legacy behaviour
// and any non-stream caller). Pure so the stable-id reuse is unit-testable
// without driving the capture loop (bd-ded98d element (d)).
export function resolveStreamFrameId(stream, fallbackId) {
  return stream?.imageId || fallbackId;
}

export function kittyPreviewDefaultPlacementId(options = {}) {
  return kittyPreviewPlaceholderPlacementId("placement.main", options);
}
