// Placement / side-panel resolution helpers extracted from kitty-image-preview.js
// (bd-e1914a). Pure over `state` plus terminal width, passthrough detection, and
// the viewport row limit.

import {
  MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE,
  detectKittyPassthroughMode,
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

function envFlagDisabled(value) {
  return /^(?:0|false|off|no|legacy)$/i.test(String(value ?? ""));
}

function envFlagEnabled(value) {
  return /^(?:1|true|on|yes)$/i.test(String(value ?? ""));
}

export function scrollSafeAutoPlacementEnabled(env = process.env) {
  return !envFlagDisabled(env.KITTY_IMAGE_PREVIEW_SCROLL_SAFE_AUTO);
}

export function configuredPassthroughMode(state, env = process.env) {
  return state.config.passthrough === "auto" ? detectKittyPassthroughMode(env) : state.config.passthrough;
}

export function shouldUseInlineRightPlacement(state, env = process.env) {
  if (configuredPassthroughMode(state, env) !== "tmux") return false;
  // Scroll-safe auto placement keeps rightOverlay height-neutral even under
  // tmux by patching the existing TUI rows. Operators can opt back into the
  // legacy height-adding inline widget for diagnosis/compatibility.
  return !scrollSafeAutoPlacementEnabled(env) || envFlagEnabled(env.KITTY_IMAGE_PREVIEW_INLINE_RIGHT_IN_TMUX);
}

export function shouldAutoUseSidePanel(state, { env = process.env, columns = currentTerminalColumns() } = {}) {
  if (shouldUseInlineRightPlacement(state, env)) return false;
  if (scrollSafeAutoPlacementEnabled(env)) return true;
  return columns === undefined || columns >= AUTO_SIDE_MIN_COLUMNS;
}

export function resolvePlacement(state, options = {}) {
  if (state.config.placement !== AUTO_PLACEMENT) return state.config.placement;
  return shouldAutoUseSidePanel(state, options) ? SIDE_OVERLAY_PLACEMENT : "aboveEditor";
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
  const directNoPassthrough = passthroughMode === "none";
  const preferAnchored = state.config.placementMode === "auto"
    && options.preferAnchored !== false
    // SSH and Herdr forward graphics bytes; they do not imply tmux or support
    // for Unicode virtual placements. Without a passthrough hop, use ordinary
    // cursor placement like icat, even when TERM is only xterm-256color.
    && !directNoPassthrough;
  const forceAnchored = options.forceUnicodePlaceholders || preferAnchored || (
    options.forceSideOverlay !== false && isSideOverlayPlacement(placement) && !directNoPassthrough
  );
  return shouldUseUnicodePlaceholders({
    placementMode: state.config.placementMode,
    passthrough,
    env,
    forceAnchored,
  });
}
