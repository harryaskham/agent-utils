// Placement / side-panel resolution helpers extracted from kitty-image-preview.js
// (bd-e1914a). Pure over `state` plus terminal width, passthrough detection, and
// the viewport row limit. Behavior is unchanged from the original inline defs.

import {
  MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE,
  detectKittyPassthroughMode,
  isNativeKittyGraphicsTerminal,
  isRemoteSshSession,
  shouldUseUnicodePlaceholders,
} from "../kitty-graphics.js";

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
  const env = options.env ?? process.env;
  const passthrough = state.config.passthrough;
  const passthroughMode = passthrough === "auto" ? detectKittyPassthroughMode(env) : passthrough;
  const nativeNoPassthrough = passthroughMode === "none" && !isRemoteSshSession(env) && isNativeKittyGraphicsTerminal(env);
  const preferAnchored = state.config.placementMode === "auto"
    && options.preferAnchored !== false
    // On native kitty-compatible terminals with no passthrough hop (not tmux,
    // not SSH), default to cursor placement. Unicode placeholders are useful as
    // an anchored tmux/side-panel workaround, but in no-passthrough Ghostty they
    // can leak PUA placeholder cells as tofu when the TUI text stream and kitty
    // protocol writes interleave (bd-903d89).
    && !nativeNoPassthrough;
  const forceAnchored = options.forceUnicodePlaceholders || preferAnchored || (
    options.forceSideOverlay !== false && isSideOverlayPlacement(placement) && !nativeNoPassthrough
  );
  return shouldUseUnicodePlaceholders({
    placementMode: state.config.placementMode,
    passthrough,
    env,
    forceAnchored,
  });
}
