// Pi-runtime-agnostic helpers used by the pi-graphics extension.
//
// Pi-coding-agent injects `pi` and pulls in `@sinclair/typebox` at extension
// load time, but the placement-building logic is plain ESM. Splitting it out
// here lets tests cover renderer + protocol composition without taking a
// dependency on Pi internals.

import {
  buildKittyUnicodePlaceholderLines,
  buildPngVirtualPlacementAnimation,
  buildPngVirtualPlacementCommand,
  bufferToBase64,
  shouldUseUnicodePlaceholders,
} from "../kitty-graphics.js";
import {
  piGraphicsImageId,
  piGraphicsPlaceholderPlacementId,
} from "./id-space.js";

export function makeState() {
  return {
    ownedImageIds: new Set(),
    transmittedImageIds: new Set(),
    placementByImage: new Map(),
    config: {
      passthrough: "auto",
      placementMode: "auto",
    },
  };
}

function trackOwned(state, id) {
  state.ownedImageIds.add(id);
  return id;
}

function placementIdForName(name) {
  return piGraphicsPlaceholderPlacementId(`placement.${name}`);
}

export function buildPlacement(state, { name, png, columns, rows, width, caption, zIndex } = {}) {
  const imageId = trackOwned(state, piGraphicsImageId(name));
  const alreadyTransmitted = state.transmittedImageIds.has(imageId);
  const placementId = state.placementByImage.get(imageId) ?? placementIdForName(name);
  if (!alreadyTransmitted) state.placementByImage.set(imageId, placementId);
  const transmit = alreadyTransmitted ? "" : buildPngVirtualPlacementCommand({
    imageId,
    placementId,
    pngBase64: bufferToBase64(png),
    columns,
    rows,
    zIndex,
    passthrough: state.config.passthrough,
  });
  if (!alreadyTransmitted) state.transmittedImageIds.add(imageId);
  const lines = buildKittyUnicodePlaceholderLines({
    imageId,
    placementId,
    columns,
    rows,
    width,
    caption,
  });
  return { imageId, placementId, transmit, lines, transmitted: !alreadyTransmitted };
}

export function buildAnimatedPlacement(state, { name, pngs, delaysMs, columns, rows, width, caption, zIndex, autoLoop = true } = {}) {
  const imageId = trackOwned(state, piGraphicsImageId(name));
  const alreadyTransmitted = state.transmittedImageIds.has(imageId);
  const placementId = state.placementByImage.get(imageId) ?? placementIdForName(name);
  if (!alreadyTransmitted) state.placementByImage.set(imageId, placementId);
  const transmit = alreadyTransmitted ? "" : buildPngVirtualPlacementAnimation({
    imageId,
    placementId,
    pngBases: pngs.map((png) => bufferToBase64(png)),
    delaysMs,
    columns,
    rows,
    zIndex,
    passthrough: state.config.passthrough,
    autoLoop,
  });
  if (!alreadyTransmitted) state.transmittedImageIds.add(imageId);
  const lines = buildKittyUnicodePlaceholderLines({
    imageId,
    placementId,
    columns,
    rows,
    width,
    caption,
  });
  return { imageId, placementId, transmit, lines, transmitted: !alreadyTransmitted, frames: pngs.length };
}

export function resetPlacementTracking(state) {
  state?.ownedImageIds?.clear?.();
  state?.transmittedImageIds?.clear?.();
  state?.placementByImage?.clear?.();
}

export function ensureUnicodePlacement(state) {
  return shouldUseUnicodePlaceholders({
    placementMode: state.config.placementMode,
    passthrough: state.config.passthrough,
    forceAnchored: true,
  });
}

export function renderToText({ transmit, lines }) {
  const [first, ...rest] = lines;
  return [`${transmit}${first ?? ""}`, ...rest].join("\n");
}
