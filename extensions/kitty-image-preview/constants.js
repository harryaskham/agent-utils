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

// Default vision model for image-description (provider/model). Overridable via
// KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL.
export const DEFAULT_DESCRIBE_MODEL = "litellm-anthropic/claude-opus-4-7";
