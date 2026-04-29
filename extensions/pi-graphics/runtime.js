// Pi-runtime-agnostic helpers used by the pi-graphics extension.
//
// Pi-coding-agent injects `pi` and pulls in `@sinclair/typebox` at extension
// load time, but the placement-building logic is plain ESM. Splitting it out
// here lets tests cover renderer + protocol composition without taking a
// dependency on Pi internals.

import {
  buildKittyUnicodePlaceholderLines,
  buildPngVirtualPlacementCommand,
  bufferToBase64,
  shouldUseUnicodePlaceholders,
  stableKittyImageId,
} from "../kitty-graphics.js";

const PLACEMENT_ID_BASE = 0xa1;

export function makeState() {
  return {
    ownedImageIds: new Set(),
    placementCounter: 0,
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

function nextPlacementId(state) {
  state.placementCounter = (state.placementCounter + 1) % 0xffffff;
  return PLACEMENT_ID_BASE + state.placementCounter;
}

export function buildPlacement(state, { name, png, columns, rows, caption } = {}) {
  const imageId = trackOwned(state, stableKittyImageId(`agent-utils.pi-graphics.${name}`));
  const placementId = nextPlacementId(state);
  const transmit = buildPngVirtualPlacementCommand({
    imageId,
    placementId,
    pngBase64: bufferToBase64(png),
    columns,
    rows,
    passthrough: state.config.passthrough,
  });
  const lines = buildKittyUnicodePlaceholderLines({
    imageId,
    placementId,
    columns,
    rows,
    caption,
  });
  return { imageId, placementId, transmit, lines };
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
