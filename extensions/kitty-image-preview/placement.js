// Placement / side-panel resolution helpers extracted from kitty-image-preview.js
// (bd-e1914a). Pure over `state` plus terminal width, passthrough detection, and
// the viewport row limit. Behavior is unchanged from the original inline defs.

import { MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE, detectKittyPassthroughMode, shouldUseUnicodePlaceholders } from "../kitty-graphics.js";

import {
  AUTO_PLACEMENT,
  AUTO_SIDE_MIN_COLUMNS,
  DEFAULT_COLUMNS,
  DEFAULT_MAX_ROWS,
  SIDE_OVERLAY_PLACEMENT,
} from "./constants.js";
import { clampInteger } from "./text-utils.js";
import { currentTerminalColumns, previewViewportRowLimit } from "./layout.js";

export function configuredPassthroughMode(state) {
  return state.config.passthrough === "auto" ? detectKittyPassthroughMode(process.env) : state.config.passthrough;
}

export function shouldUseInlineRightPlacement(state) {
  return configuredPassthroughMode(state) === "tmux";
}

export function shouldAutoUseSidePanel(state) {
  if (shouldUseInlineRightPlacement(state)) return false;
  const columns = currentTerminalColumns();
  return columns === undefined || columns >= AUTO_SIDE_MIN_COLUMNS;
}

export function resolvePlacement(state) {
  if (state.config.placement !== AUTO_PLACEMENT) return state.config.placement;
  return shouldAutoUseSidePanel(state) ? SIDE_OVERLAY_PLACEMENT : "aboveEditor";
}

export function sideOverlayWidth(state) {
  return clampInteger(state.config.columns, DEFAULT_COLUMNS, 1, 4096);
}

export function sideOverlayMaxHeight(state) {
  const configured = clampInteger(state.config.rows || state.config.maxRows, DEFAULT_MAX_ROWS, 1, MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1);
  const viewportLimit = previewViewportRowLimit();
  return viewportLimit === undefined ? configured : Math.min(configured, viewportLimit);
}

// Placement-mode predicates extracted from kitty-image-preview.js (bd-e1914a).
// isSideOverlayPlacement is a pure constant check; shouldRenderUnicodePlaceholders
// reads only state.config plus call options and delegates to the kitty-graphics
// passthrough/placeholder decision.
export function isSideOverlayPlacement(placement) {
  return placement === SIDE_OVERLAY_PLACEMENT;
}

export function shouldRenderUnicodePlaceholders(state, options = {}) {
  const placement = options.placement ?? state.config.placement;
  const forceAnchored = options.forceUnicodePlaceholders || (
    // For this preview extension, anchored placeholders are the safe default.
    // Direct cursor placement can move the real terminal cursor while Pi is
    // differentially redrawing, which creates duplicate full-screen scrollback
    // entries on image/frame updates. Keep direct cursor mode available only as
    // an explicit debugging override with placementMode: "cursor".
    state.config.placementMode === "auto" && options.preferAnchored !== false
  ) || (
    options.forceSideOverlay !== false && isSideOverlayPlacement(placement)
  );
  return shouldUseUnicodePlaceholders({
    placementMode: state.config.placementMode,
    passthrough: state.config.passthrough,
    env: process.env,
    forceAnchored,
  });
}
