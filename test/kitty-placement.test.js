import test from "node:test";
import assert from "node:assert/strict";

import {
  configuredPassthroughMode,
  shouldUseInlineRightPlacement,
  shouldAutoUseSidePanel,
  resolvePlacement,
  sideOverlayWidth,
  sideOverlayMaxHeight,
} from "../extensions/kitty-image-preview/placement.js";

function makeState(config = {}) {
  return {
    config: {
      passthrough: "none",
      placement: "auto",
      columns: undefined,
      rows: undefined,
      maxRows: undefined,
      ...config,
    },
  };
}

// Override terminal dimensions (and clear COLUMNS/LINES env) with restore, so
// the width/height-coupled placement helpers are deterministic.
function withTerminal({ columns, rows }, fn) {
  const origCols = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  const origRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  const origEnv = { COLUMNS: process.env.COLUMNS, LINES: process.env.LINES };
  try {
    Object.defineProperty(process.stdout, "columns", { value: columns, configurable: true });
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
    delete process.env.COLUMNS;
    delete process.env.LINES;
    return fn();
  } finally {
    if (origCols) Object.defineProperty(process.stdout, "columns", origCols);
    if (origRows) Object.defineProperty(process.stdout, "rows", origRows);
    for (const [k, v] of Object.entries(origEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function withTmux(value, fn) {
  const orig = process.env.TMUX;
  try {
    if (value === undefined) delete process.env.TMUX;
    else process.env.TMUX = value;
    return fn();
  } finally {
    if (orig === undefined) delete process.env.TMUX; else process.env.TMUX = orig;
  }
}

test("configuredPassthroughMode returns explicit modes and auto-detects from env", () => {
  assert.equal(configuredPassthroughMode(makeState({ passthrough: "none" })), "none");
  assert.equal(configuredPassthroughMode(makeState({ passthrough: "tmux" })), "tmux");
  withTmux("/tmp/tmux-1000/default,1,0", () => {
    assert.equal(configuredPassthroughMode(makeState({ passthrough: "auto" })), "tmux");
  });
  withTmux(undefined, () => {
    assert.equal(configuredPassthroughMode(makeState({ passthrough: "auto" })), "none");
  });
});

test("shouldUseInlineRightPlacement only uses the legacy tmux inline fallback when explicitly requested", () => {
  assert.equal(shouldUseInlineRightPlacement(makeState({ passthrough: "tmux" })), false);
  assert.equal(shouldUseInlineRightPlacement(makeState({ passthrough: "none" })), false);
  assert.equal(
    shouldUseInlineRightPlacement(makeState({ passthrough: "tmux" }), { KITTY_IMAGE_PREVIEW_INLINE_RIGHT_IN_TMUX: "1" }),
    true,
  );
  assert.equal(
    shouldUseInlineRightPlacement(makeState({ passthrough: "tmux" }), { KITTY_IMAGE_PREVIEW_SCROLL_SAFE_AUTO: "0" }),
    true,
  );
});

test("shouldAutoUseSidePanel defaults to scroll-safe height-neutral placement", () => {
  assert.equal(shouldAutoUseSidePanel(makeState({ passthrough: "tmux" })), true, "tmux still uses side panel by default");
  withTerminal({ columns: 120, rows: 40 }, () => {
    assert.equal(shouldAutoUseSidePanel(makeState({ passthrough: "none" })), true, "wide -> side panel");
  });
  withTerminal({ columns: 80, rows: 40 }, () => {
    assert.equal(shouldAutoUseSidePanel(makeState({ passthrough: "none" })), true, "narrow still avoids height-adding inline rows");
  });
  withTerminal({ columns: undefined, rows: undefined }, () => {
    assert.equal(shouldAutoUseSidePanel(makeState({ passthrough: "none" })), true, "unknown width -> side panel");
  });
});

test("shouldAutoUseSidePanel can restore legacy width and tmux fallback via env", () => {
  assert.equal(
    shouldAutoUseSidePanel(makeState({ passthrough: "tmux" }), { env: { KITTY_IMAGE_PREVIEW_SCROLL_SAFE_AUTO: "0" }, columns: 120 }),
    false,
    "legacy mode keeps tmux inline fallback",
  );
  assert.equal(
    shouldAutoUseSidePanel(makeState({ passthrough: "none" }), { env: { KITTY_IMAGE_PREVIEW_SCROLL_SAFE_AUTO: "0" }, columns: 80 }),
    false,
    "legacy mode honors the width threshold",
  );
  assert.equal(
    shouldAutoUseSidePanel(makeState({ passthrough: "none" }), { env: { KITTY_IMAGE_PREVIEW_SCROLL_SAFE_AUTO: "0" }, columns: 120 }),
    true,
  );
});

test("resolvePlacement passes through explicit placements and resolves auto", () => {
  assert.equal(resolvePlacement(makeState({ placement: "belowEditor" })), "belowEditor");
  assert.equal(resolvePlacement(makeState({ placement: "aboveEditor" })), "aboveEditor");
  withTerminal({ columns: 120, rows: 40 }, () => {
    assert.equal(resolvePlacement(makeState({ placement: "auto", passthrough: "none" })), "rightOverlay");
  });
  withTerminal({ columns: 80, rows: 40 }, () => {
    assert.equal(resolvePlacement(makeState({ placement: "auto", passthrough: "none" })), "rightOverlay");
  });
  assert.equal(resolvePlacement(makeState({ placement: "auto", passthrough: "tmux" })), "rightOverlay");
  assert.equal(
    resolvePlacement(makeState({ placement: "auto", passthrough: "tmux" }), { env: { KITTY_IMAGE_PREVIEW_SCROLL_SAFE_AUTO: "0" }, columns: 120 }),
    "aboveEditor",
    "legacy opt-out restores tmux inline placement",
  );
});

test("sideOverlayWidth clamps the configured column count", () => {
  assert.equal(sideOverlayWidth(makeState({ columns: 120 })), 120);
  assert.equal(sideOverlayWidth(makeState({ columns: undefined })), 48, "default columns");
  assert.equal(sideOverlayWidth(makeState({ columns: 0 })), 1, "clamps to min 1");
  assert.equal(sideOverlayWidth(makeState({ columns: 9999 })), 4096, "clamps to max 4096");
});

test("sideOverlayMaxHeight takes the min of configured and viewport limit", () => {
  // terminal rows 48 -> viewport limit 24.
  withTerminal({ columns: 120, rows: 48 }, () => {
    assert.equal(sideOverlayMaxHeight(makeState({ rows: 100 })), 24, "viewport caps configured");
    assert.equal(sideOverlayMaxHeight(makeState({ rows: 10 })), 10, "configured below viewport wins");
    // rows falsy -> falls back to maxRows, then DEFAULT_MAX_ROWS (24).
    assert.equal(sideOverlayMaxHeight(makeState({ rows: 0, maxRows: 8 })), 8);
    assert.equal(sideOverlayMaxHeight(makeState({})), 24, "default max rows, capped by viewport");
  });
  // unknown terminal rows -> configured value passes through uncapped.
  withTerminal({ columns: 120, rows: undefined }, () => {
    assert.equal(sideOverlayMaxHeight(makeState({ rows: 100 })), 100);
  });
});
