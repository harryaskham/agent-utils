// Preview state helpers extracted from kitty-image-preview.js (bd-e1914a).
// These operate purely on the passed-in `state` object (and snapshot details)
// with no terminal/ctx/timer coupling: snapshot serialize/restore, owned-image
// tracking, item list mutation, and the human-readable current-image summary.
// Behavior is unchanged from the original inline definitions.

import path from "node:path";

import { stableKittyImageId } from "../kitty-graphics.js";
import { clampInteger } from "./text-utils.js";

export function serializePublicState(state) {
  return {
    version: 1,
    visible: state.visible,
    index: state.index,
    config: { ...state.config },
    items: state.items.map((item) => ({
      id: item.id,
      path: item.path,
      label: item.label,
      mediaType: item.mediaType,
      width: item.width,
      height: item.height,
      addedAt: item.addedAt,
    })),
    ownedImageIds: Array.from(state.ownedImageIds || []),
  };
}

export function restorePublicState(state, details) {
  const snapshot = details?.kittyImagePreviewState;
  if (!snapshot || !Array.isArray(snapshot.items)) return;
  state.visible = Boolean(snapshot.visible);
  state.index = clampInteger(snapshot.index, 0, 0, Math.max(0, snapshot.items.length - 1));
  state.config = { ...state.config, ...(snapshot.config ?? {}) };
  state.items = snapshot.items
    .filter((item) => typeof item?.path === "string")
    .map((item) => ({
      id: Number.isFinite(item.id) ? item.id : stableKittyImageId(item.path),
      path: item.path,
      label: item.label || path.basename(item.path),
      mediaType: item.mediaType || "image/png",
      width: item.width,
      height: item.height,
      addedAt: item.addedAt || Date.now(),
    }));
  state.ownedImageIds = new Set(
    Array.isArray(snapshot.ownedImageIds) && snapshot.ownedImageIds.length > 0
      ? snapshot.ownedImageIds.filter((id) => Number.isFinite(id))
      : state.items.map((item) => item.id),
  );
}

export function trackOwnedItem(state, item) {
  if (!item || typeof item.id !== "number") return item;
  if (!state.ownedImageIds) state.ownedImageIds = new Set();
  state.ownedImageIds.add(item.id);
  return item;
}

export function clearOwnedImageIds(state) {
  state.ownedImageIds = new Set();
}

export function pushItems(state, items) {
  for (const item of items) {
    state.items.push(item);
    trackOwnedItem(state, item);
  }
}

export function replaceItems(state, items) {
  // Note: we intentionally keep previously-owned image ids registered so that
  // pending scoped-deletes can still target them on subsequent prepare/clear
  // cycles. Items are evicted from ownership only on explicit clear/shutdown.
  state.items = [];
  pushItems(state, items);
}

export function summarizeCurrent(state) {
  const current = state.items[state.index];
  if (!current) return "No image is loaded.";
  const dims = current.width && current.height ? ` (${current.width}×${current.height})` : "";
  const mode = state.config.transferMode === "auto" ? "auto" : state.config.transferMode;
  return `Showing ${state.index + 1}/${state.items.length}: ${current.label}${dims}; placement=${state.config.placement}, transfer=${mode}, graphicsPlacement=${state.config.placementMode}, z=${state.config.zIndex}.`;
}
