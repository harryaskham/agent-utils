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
  // Clamp against the FILTERED item count: dropped (path-less) entries must not
  // leave the index past the end of state.items, which would make
  // summarizeCurrent report "No image is loaded". (bd-811a7c)
  state.index = clampInteger(snapshot.index, 0, 0, Math.max(0, state.items.length - 1));
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

// Timer / index / animation-cycle state helpers extracted from
// kitty-image-preview.js (bd-e1914a). Pure over `state` plus global timer APIs.

// Detach a timer from the event loop so it never keeps the process alive.
export function keepTimerFromHoldingProcess(timer) {
  if (typeof timer?.unref === "function") timer.unref();
  return timer;
}

// Advance the current image index by `direction`, wrapping; false if empty.
export function advanceIndex(state, direction = 1) {
  if (state.items.length === 0) return false;
  const next = (state.index + direction + state.items.length) % state.items.length;
  state.index = next;
  return true;
}

// Stop and clear the animation timer/flag.
export function stopAnimation(state) {
  if (state.animationTimer) clearInterval(state.animationTimer);
  state.animationTimer = undefined;
  state.animation = { running: false };
}

// Stop and clear the cycle timer/flag.
export function stopCycle(state) {
  if (state.cycleTimer) clearInterval(state.cycleTimer);
  state.cycleTimer = undefined;
  state.cycle = { running: false };
}

// Tool-result shaping helpers extracted from kitty-image-preview.js (bd-e1914a).
// makeDetails attaches the serialized public state; makeContent renders the
// current-state summary plus any extra lines as a single text block.
export function makeDetails(state, extra = {}) {
  return {
    ...extra,
    kittyImagePreviewState: serializePublicState(state),
  };
}

export function makeContent(state, extraLines = []) {
  return [{ type: "text", text: [summarizeCurrent(state), ...extraLines].filter(Boolean).join("\n") }];
}
