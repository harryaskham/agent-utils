// Shared kitty-image-preview config constants (bd-e1914a). Extracted so both the
// main extension file and the placement submodule can reference them without
// duplication.

export const AUTO_PLACEMENT = "auto";
export const SIDE_OVERLAY_PLACEMENT = "rightOverlay";
export const DEFAULT_COLUMNS = 48;
export const DEFAULT_MAX_ROWS = 24;
export const AUTO_SIDE_MIN_COLUMNS = 100;
export const SIDE_PANEL_MAX_WIDTH_RATIO = 0.5;
export const SIDE_PANEL_LEFT_PADDING = 2;

// Minimum columns reserved for the conversation/text column on the LHS. The
// side rail never eats into this floor, so slim windows keep a readable text
// column and the rail shrinks (or disappears entirely below ~21 columns)
// instead. At exactly 40 columns the default 50% ratio and this floor agree
// (20/20); above 40 the ratio binds and the rail is a true half of the width.
export const SIDE_PANEL_MIN_MAIN_COLUMNS = 20;

// Bounds for an operator-supplied /image-width ratio. The upper bound keeps a
// sliver of text column on wide terminals even before the absolute floor above
// applies; the lower bound keeps the rail wide enough to render something.
export const SIDE_PANEL_MIN_WIDTH_RATIO = 0.05;
export const SIDE_PANEL_MAX_ALLOWED_WIDTH_RATIO = 0.9;

// Default vision model for image-description (provider/model). Overridable per
// call (describeModel), via KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL, or in
// settings.json (kittyImagePreview.describeModel). Uses a github-copilot model so
// describe calls reuse pi's Copilot auth through the model registry (bd-02c6ff).
export const DEFAULT_DESCRIBE_MODEL = "github-copilot/claude-opus-4.8";

// Fallback chain tried only when no explicit param/env/settings override is
// configured, so a node missing the exact default id degrades gracefully instead
// of hard-throwing "not registered" (mirrors tendril-share's chain).
export const FALLBACK_DESCRIBE_MODELS = Object.freeze([
  DEFAULT_DESCRIBE_MODEL,
  "github-copilot/claude-opus-4.8-1m-internal",
  "github-copilot/claude-opus-4-8",
  "github-copilot/claude-opus-4-8-1m-internal",
  "github-copilot/claude-opus-4.7",
  "github-copilot/claude-opus-4.7-1m-internal",
  "github-copilot/claude-opus-4-7",
  "github-copilot/claude-opus-4-7-1m-internal",
  "litellm-anthropic/claude-opus-4-7",
]);

// Placement option sets for preview config validation and tool schemas.
export const WIDGET_PLACEMENTS = ["aboveEditor", "belowEditor"];
export const PREVIEW_PLACEMENTS = [AUTO_PLACEMENT, ...WIDGET_PLACEMENTS, SIDE_OVERLAY_PLACEMENT];
