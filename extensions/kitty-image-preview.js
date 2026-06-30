import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  shellQuote,
  normalizeMaybeAtPath,
  expandHome,
  resolveUserPath,
  relativeLabel,
  sanitizeFilenamePart,
  timestampForFilename,
  clampInteger,
  pluralizeImages,
  truncatePlainText,
} from "./kitty-image-preview/text-utils.js";
import {
  getSessionScreenshotDir,
  buildScreenshotOutputPath,
  sessionTempId,
  getStreamDir,
  getDescribeTempDir,
} from "./kitty-image-preview/session-paths.js";
import {
  serializePublicState,
  restorePublicState,
  trackOwnedItem,
  clearOwnedImageIds,
  pushItems,
  replaceItems,
  summarizeCurrent,
  keepTimerFromHoldingProcess,
  advanceIndex,
  stopAnimation,
  stopCycle,
  makeDetails,
  makeContent,
  applyConfig,
} from "./kitty-image-preview/state.js";
import {
  estimatedRowsForColumns,
  fitImageColumnsForRows,
  containImageBox,
  packImagesIntoPages,
  pageForIndex,
  limitLinesToTerminalRows,
  currentTerminalColumns,
  previewViewportRowLimit,
  previewImageRowLimit,
  buildSidePanelLayout,
  componentContains,
  renderChildren,
  wantsFullWidthWithSidePanel,
  renderChildrenForSidePanel,
} from "./kitty-image-preview/layout.js";
import {
  AUTO_PLACEMENT,
  DEFAULT_COLUMNS,
  DEFAULT_MAX_ROWS,
  SIDE_OVERLAY_PLACEMENT,
  PREVIEW_PLACEMENTS,
} from "./kitty-image-preview/constants.js";
import {
  configuredPassthroughMode,
  shouldUseInlineRightPlacement,
  shouldAutoUseSidePanel,
  resolvePlacement,
  sideOverlayWidth,
  sideOverlayMaxHeight,
  isSideOverlayPlacement,
  shouldRenderUnicodePlaceholders,
} from "./kitty-image-preview/placement.js";
import {
  buildTendrilCaptureArgs,
  buildPlaywrightCliScreenshotArgs,
  buildPlaywrightCliScreenshotCommand,
} from "./kitty-image-preview/cli-commands.js";
import {
  imageControlHint,
  imageStatusLine,
  defaultScreenshotLabel,
  streamStatusLine,
} from "./kitty-image-preview/status-line.js";
import {
  tokenizeConfigArgs,
  parseConfigPatch,
  applyConfigPatch,
  formatConfigSummary,
  configUsageHint,
} from "./kitty-image-preview/config-command.js";

import {
  buildScopedDeleteCommand,
  releaseOwnedImageData,
  runHeadlessOwnedFree,
  enumerateGraphicsWriters,
  buildCurrentDisplayCommand,
  resetTransmissionGuard,
} from "./kitty-image-preview/display-commands.js";

import {
  renderCurrentImageLines,
  renderSidePanelPageLines,
  KittyImagePreviewWidget,
} from "./kitty-image-preview/widget.js";

import {
  fullResolutionDescribeParams,
  parseJsonEnvelope,
  targetText,
} from "./kitty-image-preview/parse.js";

import {
  describeParameterSchema,
  streamDescribeParameterSchema,
} from "./kitty-image-preview/schema.js";

import { resolveDescribeModel } from "./kitty-image-preview/describe-model.js";

import { complete, StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";

import {
  MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE,
  detectKittyPassthroughMode,
  fileToBase64,
  isRemoteSshSession,
  isSupportedKittyPngPath,
  readPngDimensions,
  shouldUseInMemoryTransfer,
} from "./kitty-graphics.js";
import {
  kittyPreviewDefaultPlacementId,
  kittyPreviewImageId,
  kittyPreviewItemName,
  kittyPreviewStreamImageId,
  resolveStreamFrameId,
} from "./kitty-image-preview/id-space.js";
import { buildPassthroughProbePlan } from "./kitty-image-preview/passthrough-probe.js";

const TOOL_PREFIX = "kitty_image_preview";
const WIDGET_ID = "kitty-image-preview";
const DEFAULT_Z_INDEX = 0;
const DEFAULT_BG_Z_INDEX = -1073741824;
const DEFAULT_STREAM_INTERVAL_MS = 1000;
const DEFAULT_DESCRIBE_INTERVAL_SECONDS = 30;
const SIDE_PANEL_LAYOUT_SYMBOL = Symbol.for("agent-utils.kittyImagePreview.sidePanelLayout");
const IMAGE_DESCRIPTION_PROMPT = `Describe this image objectively and exhaustively for an AI agent that cannot see it.

Focus on absolute, verifiable visual facts:
- image type/context (screenshot, UI, diagram, photo, etc.)
- visible text, labels, numbers, paths, buttons, controls, icons, and warnings
- spatial layout using positions such as top-left, center, right side, bottom bar
- relationships between elements and apparent state/selection/focus
- colors, shapes, charts, images, and notable visual details
- if it is a UI screenshot, identify active app/window/pane and anything that appears actionable

Do not infer hidden intent. Do not say what you cannot know. Be concise but detailed.`;
const SUPPORTED_EXTENSIONS = new Set([".png", ".apng"]);

function stringEnum(values, description) {
  return StringEnum(values, { description });
}

// shellQuote/normalizeMaybeAtPath/expandHome/resolveUserPath/relativeLabel/
// sanitizeFilenamePart/timestampForFilename/clampInteger are imported from
// ./kitty-image-preview/text-utils.js (extracted in bd-e1914a).


// serializePublicState is imported from ./kitty-image-preview/state.js
// (extracted in bd-e1914a).

// trackOwnedItem is imported from ./kitty-image-preview/state.js.


// clearOwnedImageIds is imported from ./kitty-image-preview/state.js.

// pushItems is imported from ./kitty-image-preview/state.js.

// replaceItems is imported from ./kitty-image-preview/state.js.

// restorePublicState is imported from ./kitty-image-preview/state.js.

// summarizeCurrent is imported from ./kitty-image-preview/state.js.

// pluralizeImages/truncatePlainText are imported from
// ./kitty-image-preview/text-utils.js (extracted in bd-e1914a).

// imageControlHint is imported from ./kitty-image-preview/status-line.js
// (extracted in bd-e1914a).


// imageStatusLine is imported from ./kitty-image-preview/status-line.js
// (extracted in bd-e1914a).


// renderCurrentImageLines and KittyImagePreviewWidget are imported from
// ./kitty-image-preview/widget.js and re-exported below. They were extracted
// (bd-c75d9e) so a widget-level smoke can drive the render path without pulling
// in the schema.js (@sinclair/typebox) / pi-ai command-registration imports.
export { renderCurrentImageLines, KittyImagePreviewWidget };

// sideOverlayWidth/sideOverlayMaxHeight/configuredPassthroughMode/
// shouldUseInlineRightPlacement are imported from
// ./kitty-image-preview/placement.js (extracted in bd-e1914a).

// currentTerminalColumns/currentTerminalRows/previewViewportRowLimit/
// previewImageRowLimit are imported from ./kitty-image-preview/layout.js
// (extracted in bd-e1914a).

// shouldAutoUseSidePanel/resolvePlacement are imported from
// ./kitty-image-preview/placement.js (extracted in bd-e1914a).

// estimatedRowsForColumns/fitImageColumnsForRows are imported from
// ./kitty-image-preview/layout.js (extracted in bd-e1914a).

// buildSidePanelLayout is imported from ./kitty-image-preview/layout.js
// (extracted in bd-e1914a).

export function buildSideOverlayOptions(state) {
  return {
    anchor: "right-center",
    width: sideOverlayWidth(state),
    maxHeight: sideOverlayMaxHeight(state),
    margin: { right: 0 },
    nonCapturing: true,
  };
}

function requestSideOverlayRender(state) {
  state.sideOverlay?.component?.invalidate?.();
  state.sideOverlay?.tui?.requestRender?.();
}

function requestSidePanelRender(state, { force = false } = {}) {
  state.sidePanel?.component?.invalidate?.();
  state.sidePanel?.tui?.requestRender?.(force);
}

function uninstallSidePanelLayout(panel) {
  const tui = panel?.tui;
  const installed = tui?.[SIDE_PANEL_LAYOUT_SYMBOL];
  if (!tui || installed?.owner !== panel) return;
  tui.render = installed.originalRender;
  delete tui[SIDE_PANEL_LAYOUT_SYMBOL];
  tui.requestRender?.();
}

function clearSidePanel(state) {
  const panel = state.sidePanel;
  if (!panel) return;
  state.sidePanel = undefined;
  panel.cancelled = true;
  uninstallSidePanelLayout(panel);
  panel.handle?.hide?.();
  panel.component?.dispose?.();
}

function clearSideOverlay(state) {
  const overlay = state.sideOverlay;
  if (!overlay) return;
  state.sideOverlay = undefined;
  overlay.cancelled = true;
  overlay.handle?.hide?.();
  overlay.component?.dispose?.();
}

function clearSidePresentation(state) {
  clearSideOverlay(state);
  clearSidePanel(state);
}

function fallbackSideWidget(ctx, state, reason = "rightOverlay is unavailable", { warn = true } = {}) {
  const componentFactory = () => new KittyImagePreviewWidget(state, {
    forceUnicodePlaceholders: shouldUseInlineRightPlacement(state),
    forceSideOverlay: false,
  });
  ctx.ui.setWidget(WIDGET_ID, componentFactory, { placement: "aboveEditor" });
  if (warn && !state.sideInlineFallbackWarned) {
    state.sideInlineFallbackWarned = true;
    ctx.ui.notify?.(`kitty image ${reason}; using the inline above-editor widget.`, "warning");
  }
}


function findEditorBoundaryIndex(tui) {
  const children = Array.isArray(tui?.children) ? tui.children : [];
  const focusedIndex = children.findIndex((child) => componentContains(child, tui.focusedComponent));
  if (focusedIndex >= 0) return focusedIndex;
  // Pi's interactive layout ends with editorContainer, widgetBelow, footer.
  return Math.max(0, children.length - 3);
}


// limitLinesToTerminalRows is imported from
// ./kitty-image-preview/layout.js (extracted in bd-e1914a).

function renderSidePanelImageLines(state, rows, layout) {
  const current = state.items[state.index];
  const blank = " ".repeat(layout.totalWidth);
  if (!current || rows <= 0) return [];
  // Side-panel rendering normally uses virtual placement + Unicode
  // placeholders so the image anchors to reserved cells without moving the
  // terminal cursor during Pi's differential redraws. Native kitty-compatible
  // terminals with no passthrough hop are the exception: in Ghostty the
  // placeholder cells can leak as tofu when interleaved with the TUI text
  // stream, so shouldRenderUnicodePlaceholders falls back to cursor placement
  // for that environment (bd-903d89).
  const useUnicodePlaceholders = shouldRenderUnicodePlaceholders(state, {
    forceSideOverlay: true,
  });
  const maxRows = previewImageRowLimit({
    viewportRows: undefined,
    availableRows: rows,
    protocolMax: useUnicodePlaceholders ? MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1 : 200,
  });
  // Aspect-preserving contain fit (bd image-preview sidebar work): derive the
  // rendered cell box from the actual row budget so kitty is never handed a
  // (width, rows) pair that mismatches the image's natural aspect ratio. The
  // previous code clamped imageRows to the visible rows while keeping the column
  // width fixed, which scaled tall images into a too-short box and squished them
  // vertically. containImageBox fills the full column width whenever height is
  // not the binding constraint, and only narrows the image for tall/portrait
  // sources so the aspect ratio is preserved either way.
  const rowBudget = Math.max(1, Math.min(rows, layout.imageRows || rows, maxRows));
  const box = containImageBox(current, layout.imageWidth, rowBudget);
  const imageLines = renderCurrentImageLines(state, current, {
    columns: box.imageWidth,
    rows: box.imageRows,
    lineWidth: layout.imageWidth,
    useUnicodePlaceholders,
    leadingSpaces: layout.padding,
  });
  // Bottom-align the image in the reserved side frame so the preview is pinned
  // immediately above the editor/input area instead of drifting at the top of
  // the scrollback viewport.
  const topBlankRows = Math.max(0, rows - imageLines.length);
  return Array.from({ length: rows }, (_unused, index) => imageLines[index - topBlankRows] ?? blank);
}

// Multi-image paged side panel (Part C-wire live, bd-502d6a). Renders the packed
// page that contains the current image — per-entry name header + width-fit image
// blocks — reusing renderSidePanelPageLines (transmit-once-per-image-id). Falls
// back to the single-image renderer whenever there are <2 images, the per-entry
// page payloads are not all prepared, or packing yields nothing, so the common
// single-image / unprepared paths are byte-for-byte unchanged.
function renderSidePanelImageLinesPaged(state, rows, layout) {
  const prepared = state.pagePrepared;
  const ready = prepared instanceof Map && state.items.every((item) => prepared.has(item.id));
  if (state.items.length < 2 || !ready || rows <= 0) {
    return renderSidePanelImageLines(state, rows, layout);
  }
  const useUnicodePlaceholders = shouldRenderUnicodePlaceholders(state, { forceSideOverlay: true });
  const pages = packImagesIntoPages(state.items, {
    columnWidth: layout.imageWidth,
    availableRows: rows,
    headerRows: 1,
  });
  if (pages.length === 0) return renderSidePanelImageLines(state, rows, layout);
  const pageIndex = Math.min(pages.length - 1, Math.max(0, pageForIndex(pages, state.index)));
  return renderSidePanelPageLines(state, {
    page: pages[pageIndex],
    rows,
    totalWidth: layout.totalWidth,
    imageWidth: layout.imageWidth,
    padding: layout.padding,
    useUnicodePlaceholders,
    preparedById: prepared,
  });
}

function renderTuiWithSidePanel(tui, originalRender, width, state) {
  const placement = resolvePlacement(state);
  if (!state.visible || state.items.length === 0 || !isSideOverlayPlacement(placement) || shouldUseInlineRightPlacement(state)) {
    return originalRender.call(tui, width);
  }
  const terminalWidth = Math.max(1, Math.trunc(width || tui?.terminal?.columns || 1));
  const terminalHeight = Math.max(1, Math.trunc(tui?.terminal?.rows || 1));
  const clampToViewport = (lines) => limitLinesToTerminalRows(lines, terminalHeight);
  const children = Array.isArray(tui.children) ? tui.children : [];
  const editorBoundary = findEditorBoundaryIndex(tui);
  const bottomLines = renderChildren(children.slice(editorBoundary), terminalWidth);
  const bottomVisibleRows = Math.min(bottomLines.length, Math.max(0, terminalHeight - 1));
  const viewportPanelLimit = previewViewportRowLimit(terminalHeight) ?? terminalHeight;
  const panelRows = Math.max(0, Math.min(terminalHeight - bottomVisibleRows, viewportPanelLimit));
  if (panelRows <= 0) return originalRender.call(tui, width);

  let layout = buildSidePanelLayout(state, terminalWidth, panelRows);
  if (layout.totalWidth < 1 || layout.imageRows < 1) return originalRender.call(tui, width);
  const topChildren = children.slice(0, editorBoundary);
  let topRendered = renderChildrenForSidePanel(topChildren, layout.mainWidth, terminalWidth);
  let topLines = topRendered.lines;
  let topFullWidthLines = topRendered.fullWidthLines;
  let combined = [];
  let visiblePanelRows = 0;
  let panelStart = 0;

  const calculateVisiblePanel = () => {
    const panelBlank = " ".repeat(layout.totalWidth);
    combined = [
      ...topLines.map((line, index) => topFullWidthLines[index] ? line : `${line}\x1b[${layout.mainWidth + 1}G${panelBlank}`),
      ...bottomLines,
    ];
    const viewportTop = Math.max(0, combined.length - terminalHeight);
    panelStart = Math.min(topLines.length, viewportTop);
    const panelEnd = Math.min(topLines.length, panelStart + panelRows);
    visiblePanelRows = Math.max(0, panelEnd - panelStart);
  };

  calculateVisiblePanel();
  if (visiblePanelRows === 0) return clampToViewport(combined);

  const refinedLayout = buildSidePanelLayout(state, terminalWidth, visiblePanelRows);
  if (refinedLayout.totalWidth >= 1 && refinedLayout.imageRows >= 1 && (
    refinedLayout.mainWidth !== layout.mainWidth || refinedLayout.imageRows !== layout.imageRows
  )) {
    layout = refinedLayout;
    topRendered = renderChildrenForSidePanel(topChildren, layout.mainWidth, terminalWidth);
    topLines = topRendered.lines;
    topFullWidthLines = topRendered.fullWidthLines;
    calculateVisiblePanel();
    if (visiblePanelRows === 0) return clampToViewport(combined);
  }

  const moveToPanel = `\x1b[${layout.mainWidth + 1}G`;
  const blankPanel = " ".repeat(layout.totalWidth);
  const panelLines = renderSidePanelImageLinesPaged(state, visiblePanelRows, layout);
  for (let index = 0; index < visiblePanelRows; index += 1) {
    const lineIndex = panelStart + index;
    if (topFullWidthLines[lineIndex]) continue;
    combined[lineIndex] = `${topLines[lineIndex]}${moveToPanel}${panelLines[index] ?? blankPanel}`;
  }
  return clampToViewport(combined);
}

function installSidePanelLayout(tui, state, panel) {
  if (!tui || tui[SIDE_PANEL_LAYOUT_SYMBOL]?.owner === panel) return;
  if (tui[SIDE_PANEL_LAYOUT_SYMBOL]) uninstallSidePanelLayout(tui[SIDE_PANEL_LAYOUT_SYMBOL].owner);
  const originalRender = tui.render;
  tui[SIDE_PANEL_LAYOUT_SYMBOL] = { owner: panel, originalRender };
  tui.render = function patchedKittyImagePreviewRender(width) {
    return renderTuiWithSidePanel(this, originalRender, width, state);
  };
}

function ensureSidePanel(ctx, state) {
  if (state.sidePanel?.tui) {
    installSidePanelLayout(state.sidePanel.tui, state, state.sidePanel);
    requestSidePanelRender(state);
    return;
  }
  if (state.sidePanel?.pending) return;
  if (typeof ctx.ui.custom !== "function") {
    fallbackSideWidget(ctx, state, "rightOverlay needs Pi custom UI support");
    return;
  }

  const panel = {
    pending: true,
    cancelled: false,
    handle: undefined,
    component: undefined,
    tui: undefined,
  };
  panel.component = {
    render() { return []; },
    invalidate() {},
    dispose() { uninstallSidePanelLayout(panel); },
  };
  state.sidePanel = panel;

  let promise;
  try {
    promise = ctx.ui.custom((tui) => {
      panel.pending = false;
      panel.tui = tui;
      installSidePanelLayout(tui, state, panel);
      return panel.component;
    }, {
      overlay: true,
      overlayOptions: { anchor: "top-right", width: 1, maxHeight: 1, visible: () => false, nonCapturing: true },
      onHandle: (handle) => {
        panel.handle = handle;
        handle.unfocus?.();
        // The hidden overlay is only a supported way to get the TUI instance
        // from Pi. Remove it immediately so normal overlay compositing does not
        // pad the buffer or affect side-panel viewport math.
        handle.hide?.();
      },
    });
  } catch (error) {
    if (state.sidePanel === panel) state.sidePanel = undefined;
    fallbackSideWidget(ctx, state, "rightOverlay side panel failed to initialize");
    ctx.ui.notify?.(`kitty image rightOverlay side panel failed: ${error.message}`, "warning");
    return;
  }

  promise?.catch?.((error) => {
    if (state.sidePanel === panel) state.sidePanel = undefined;
    uninstallSidePanelLayout(panel);
    ctx.ui.notify?.(`kitty image rightOverlay side panel closed: ${error.message}`, "warning");
  });
}

function ensureSideOverlay(ctx, state) {
  if (state.sideOverlay?.handle || state.sideOverlay?.pending) {
    state.sideOverlay.handle?.setHidden?.(false);
    requestSideOverlayRender(state);
    return;
  }
  if (typeof ctx.ui.custom !== "function") {
    fallbackSideWidget(ctx, state);
    return;
  }

  const overlay = {
    pending: true,
    cancelled: false,
    handle: undefined,
    component: undefined,
    tui: undefined,
  };
  state.sideOverlay = overlay;

  let promise;
  try {
    promise = ctx.ui.custom((_tui, _theme, _keybindings, _done) => {
      overlay.pending = false;
      overlay.tui = _tui;
      overlay.component = new KittyImagePreviewWidget(state, { forceSideOverlay: true });
      return overlay.component;
    }, {
      overlay: true,
      overlayOptions: () => buildSideOverlayOptions(state),
      onHandle: (handle) => {
        overlay.handle = handle;
        handle.unfocus?.();
        if (overlay.cancelled) handle.hide?.();
      },
    });
  } catch (error) {
    if (state.sideOverlay === overlay) state.sideOverlay = undefined;
    fallbackSideWidget(ctx, state);
    ctx.ui.notify?.(`kitty image rightOverlay failed: ${error.message}`, "warning");
    return;
  }

  promise?.catch?.((error) => {
    if (state.sideOverlay === overlay) state.sideOverlay = undefined;
    ctx.ui.notify?.(`kitty image rightOverlay closed: ${error.message}`, "warning");
  });
}

export function syncWidget(ctx, state) {
  if (!ctx?.hasUI) return;
  if (state.items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    clearSidePresentation(state);
    ctx.ui.setStatus(WIDGET_ID, undefined);
    return;
  }
  if (!state.visible) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    clearSidePresentation(state);
    ctx.ui.setStatus(WIDGET_ID, imageStatusLine(state));
    return;
  }
  const current = state.items[state.index];
  const placement = resolvePlacement(state);
  if (isSideOverlayPlacement(placement)) {
    clearSideOverlay(state);
    ctx.ui.setWidget(WIDGET_ID, undefined);
    if (shouldUseInlineRightPlacement(state)) {
      clearSidePanel(state);
      fallbackSideWidget(ctx, state, "rightOverlay is inline inside tmux passthrough", { warn: false });
    } else {
      ensureSidePanel(ctx, state);
    }
  } else {
    clearSidePresentation(state);
    const componentFactory = () => new KittyImagePreviewWidget(state, { placement });
    ctx.ui.setWidget(WIDGET_ID, componentFactory, { placement });
  }
  ctx.ui.setStatus(WIDGET_ID, imageStatusLine(state, current));
}

function flashDeleteWidget(ctx, state, deleteCommand) {
  if (!ctx?.hasUI) return;
  if (isSideOverlayPlacement(state.config.placement)) {
    clearSidePresentation(state);
    const flashComponent = {
      render(width) {
        return [`${deleteCommand}${" ".repeat(Math.max(1, width))}`];
      },
      invalidate() {},
    };
    if (typeof ctx.ui.custom === "function") {
      let handle;
      try {
        const promise = ctx.ui.custom(() => flashComponent, {
          overlay: true,
          overlayOptions: () => buildSideOverlayOptions(state),
          onHandle: (overlayHandle) => {
            handle = overlayHandle;
          },
        });
        promise?.catch?.(() => {});
        setTimeout(() => handle?.hide?.(), 100);
      } catch {
        ctx.ui.setWidget(WIDGET_ID, () => flashComponent, { placement: "aboveEditor" });
        setTimeout(() => ctx.ui.setWidget(WIDGET_ID, undefined), 100);
      }
    } else {
      ctx.ui.setWidget(WIDGET_ID, () => flashComponent, { placement: "aboveEditor" });
      setTimeout(() => ctx.ui.setWidget(WIDGET_ID, undefined), 100);
    }
    ctx.ui.setStatus(WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(WIDGET_ID, () => ({
    render(width) {
      return [`${deleteCommand}${" ".repeat(Math.max(1, width))}`];
    },
    invalidate() {},
  }), { placement: state.config.placement });
  ctx.ui.setStatus(WIDGET_ID, undefined);
  setTimeout(() => {
    if (!state.visible) ctx.ui.setWidget(WIDGET_ID, undefined);
  }, 100);
}





function startCycle(state, ctx, { intervalMs = 5000, direction = 1, loop = true } = {}) {
  stopCycle(state);
  state.cycle = { running: true, intervalMs, direction, loop };
  state.cycleTimer = keepTimerFromHoldingProcess(setInterval(() => {
    if (!state.visible || state.items.length === 0) {
      stopCycle(state);
      syncWidget(ctx, state);
      return;
    }
    const cycle = state.cycle;
    if (cycle.inFlight) return;
    cycle.inFlight = true;
    const next = state.index + direction;
    if (next < 0 || next >= state.items.length) {
      if (!loop) {
        stopCycle(state);
        syncWidget(ctx, state);
        return;
      }
      state.index = (next + state.items.length) % state.items.length;
    } else {
      state.index = next;
    }
    prepareCurrentImage(state, ctx, { forceReload: true })
      .catch((error) => {
        stopCycle(state);
        ctx?.ui?.notify?.(`kitty image cycle stopped: ${error.message}`, "warning");
      })
      .finally(() => {
        if (state.cycle === cycle && cycle.running) cycle.inFlight = false;
      });
  }, Math.max(50, intervalMs)));
}

function startAnimation(state, ctx, { intervalMs = 250, loop = true } = {}) {
  stopAnimation(state);
  state.animation = { running: true, intervalMs, loop };
  state.animationTimer = keepTimerFromHoldingProcess(setInterval(() => {
    if (!state.visible || state.items.length === 0) {
      stopAnimation(state);
      syncWidget(ctx, state);
      return;
    }
    const animation = state.animation;
    if (animation.inFlight) return;
    animation.inFlight = true;
    const next = state.index + 1;
    if (next >= state.items.length) {
      if (!loop) {
        stopAnimation(state);
        syncWidget(ctx, state);
        return;
      }
      state.index = 0;
    } else {
      state.index = next;
    }
    prepareCurrentImage(state, ctx, { forceReload: true })
      .catch((error) => {
        stopAnimation(state);
        ctx?.ui?.notify?.(`kitty image animation stopped: ${error.message}`, "warning");
      })
      .finally(() => {
        if (state.animation === animation && animation.running) animation.inFlight = false;
      });
  }, Math.max(50, intervalMs)));
}


// Build a prepared transmit payload for one item (the per-entry analogue of
// state.currentCommand) used by the multi-image paged side panel (bd-502d6a).
// Reuses an unchanged `existing` payload (matching signature) so animation /
// cycle frames do not re-read base64, and clears the id's transmit-once guard
// only when the payload is actually rebuilt so the next render re-uploads it.
async function buildPreparedPayload(state, item, existing) {
  const useMemory = state.config.transferMode === "memory" || (
    state.config.transferMode === "auto" && shouldUseInMemoryTransfer(process.env)
  );
  const transport = useMemory ? "memory" : "file";
  const zIndex = state.config.background ? DEFAULT_BG_Z_INDEX : state.config.zIndex;
  const signature = `${item.id}:${transport}:${zIndex}:${state.config.passthrough}:${state.config.chunkSize}`;
  if (existing && existing.signature === signature) return existing;
  const pngBase64 = useMemory ? await fileToBase64(item.path) : undefined;
  state.transmittedSignatures?.delete?.(item.id);
  return {
    itemId: item.id,
    signature,
    transport,
    pngBase64,
    filePath: useMemory ? undefined : item.path,
    zIndex,
    passthrough: state.config.passthrough,
    chunkSize: state.config.chunkSize,
    rendered: undefined,
  };
}

// Prepare per-entry payloads for the multi-image rightOverlay side panel
// (bd-502d6a). Only active for 2+ images in a (non-inline) side-overlay
// placement; otherwise it clears state.pagePrepared so the single-image side
// panel path is unaffected. When any payload is (re)built it also widens the
// scoped clear-previous delete to exclude every current page image, so the
// sibling images are not evicted by the single-image prepare's [current.id]
// exclusion.
async function preparePagePayloads(state) {
  const placement = resolvePlacement(state);
  const multiImageSidePanel = state.items.length >= 2
    && isSideOverlayPlacement(placement)
    && !shouldUseInlineRightPlacement(state);
  if (!multiImageSidePanel) {
    state.pagePrepared = undefined;
    return;
  }
  const prepared = state.pagePrepared instanceof Map ? state.pagePrepared : new Map();
  const liveIds = new Set(state.items.map((item) => item.id));
  for (const id of [...prepared.keys()]) if (!liveIds.has(id)) prepared.delete(id);
  let changed = false;
  for (const item of state.items) {
    const existing = prepared.get(item.id);
    const next = await buildPreparedPayload(state, item, existing);
    if (next !== existing) changed = true;
    prepared.set(item.id, next);
  }
  state.pagePrepared = prepared;
  if (changed) {
    state.lastDeleteCommand = state.config.clearPrevious
      // Eviction (images dropped from the list): free their terminal image data
      // (d=I) and stop tracking them so ownedImageIds + the IOSurface store do
      // not grow without bound. Current items are kept (bd-b94fa1).
      ? releaseOwnedImageData(state, { keepIds: state.items.map((item) => item.id) })
      : "";
  }
}

async function prepareCurrentImage(state, ctx, { forceReload = false } = {}) {
  const current = state.items[state.index];
  if (!current) return;
  const useMemory = state.config.transferMode === "memory" || (
    state.config.transferMode === "auto" && shouldUseInMemoryTransfer(process.env)
  );
  const transport = useMemory ? "memory" : "file";
  const zIndex = state.config.background ? DEFAULT_BG_Z_INDEX : state.config.zIndex;
  const signature = `${current.id}:${transport}:${zIndex}:${state.config.passthrough}:${state.config.chunkSize}`;

  if (!forceReload && state.currentCommand?.signature === signature) return;

  const pngBase64 = useMemory ? await fileToBase64(current.path) : undefined;
  // A freshly prepared currentCommand means the payload (or its transport)
  // changed, so any prior transmit-once guard entry for this image is stale and
  // must be cleared to force a re-upload on the next render (bd-d6fa1b).
  state.transmittedSignatures?.delete?.(current.id);
  // Streams now reuse a SINGLE stable image id and overwrite it each frame
  // (bd-ded98d element (d)), so the active id is normally the only owned stream
  // surface and this free is a no-op safety net. It remains because (a) it stays
  // correct for any frame that still carried a per-frame fallback id (a stream
  // started before the stable id was seeded, or a non-stream multi-id path), and
  // (b) it preserves the bd-1be5ca guarantee: free every superseded frame's DATA
  // (d=I) and prune it from ownedImageIds, keeping only the live frame, so a
  // long-running stream can never accumulate one resident bitmap / macOS
  // IOSurface per frame within a session. The multi-image page reclaim in
  // preparePagePayloads only runs for 2+ images in side-overlay mode, and a
  // stream replaces items down to the single live frame, so neither that reclaim
  // nor the single-image placement-only delete below would otherwise free a
  // superseded bitmap.
  if (state.stream && state.config.clearPrevious) {
    state.lastDeleteCommand = releaseOwnedImageData(state, { keepIds: [current.id] });
  } else {
    state.lastDeleteCommand = state.config.clearPrevious
      ? buildScopedDeleteCommand(state, { excludeIds: [current.id] })
      : "";
  }
  state.currentCommand = {
    itemId: current.id,
    signature,
    transport,
    pngBase64,
    filePath: useMemory ? undefined : current.path,
    zIndex,
    passthrough: state.config.passthrough,
    chunkSize: state.config.chunkSize,
    rendered: undefined,
  };
  await preparePagePayloads(state).catch(() => {});
  syncWidget(ctx, state);
}

async function collectPngFiles(directory, { recursive = false, limit = 200 } = {}) {
  const entries = [];
  async function visit(dir) {
    if (entries.length >= limit) return;
    const children = await readdir(dir, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const child of children) {
      if (entries.length >= limit) break;
      const absolute = path.join(dir, child.name);
      if (child.isDirectory()) {
        if (recursive) await visit(absolute);
      } else if (child.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(child.name).toLowerCase())) {
        entries.push(absolute);
      }
    }
  }
  await visit(directory);
  return entries;
}

async function buildItem(cwd, inputPath, label) {
  const absolutePath = resolveUserPath(cwd, inputPath);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error(`Image path is not a file: ${absolutePath}`);
  if (!isSupportedKittyPngPath(absolutePath)) {
    throw new Error(`Native kitty preview currently accepts PNG/APNG files. Convert to PNG first: ${absolutePath}`);
  }
  const dimensions = await readPngDimensions(absolutePath).catch(() => undefined);
  // Add a per-mtime/size suffix so re-captured stream frames at the same path
  // get unique kitty image ids. This keeps scoped-delete able to evict the
  // previous frame without affecting unrelated images in the terminal.
  return {
    id: kittyPreviewImageId(kittyPreviewItemName({ absolutePath, mtimeMs: info.mtimeMs, size: info.size })),
    path: absolutePath,
    label: label || relativeLabel(cwd, absolutePath),
    mediaType: "image/png",
    width: dimensions?.width,
    height: dimensions?.height,
    addedAt: Date.now(),
  };
}







function resolveVisionModel(ctx, params = {}) {
  // Precedence: per-call describeModel -> KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL ->
  // settings.json (kittyImagePreview.describeModel) -> default github-copilot
  // model (with fallback chain). Auth is unchanged: the resolved model is fed to
  // ctx.modelRegistry.getApiKeyAndHeaders, so github-copilot models reuse pi's
  // Copilot token (bd-02c6ff).
  return resolveDescribeModel(ctx, { params }).model;
}

async function describeImageFile(filePath, item, ctx, params = {}, signal) {
  const model = resolveVisionModel(ctx, params);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  const extra = params.describePrompt ? `\n\nAdditional instruction: ${params.describePrompt}` : "";
  const response = await complete(
    model,
    {
      systemPrompt: "You are a precise visual description assistant. Return only objective visual observations.",
      messages: [{
        role: "user",
        timestamp: Date.now(),
        content: [
          { type: "text", text: `${IMAGE_DESCRIPTION_PROMPT}${extra}\n\nImage label: ${item?.label || path.basename(filePath)}${item?.width && item?.height ? ` (${item.width}×${item.height})` : ""}` },
          { type: "image", data: await fileToBase64(filePath), mimeType: item?.mediaType || "image/png" },
        ],
      }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal,
      maxTokens: clampInteger(params.describeMaxTokens, 1200, 128, 8000),
    },
  );
  if (response.stopReason === "aborted") throw new Error("Image description aborted.");
  const text = response.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  return {
    text,
    model: `${model.provider}/${model.id}`,
    usage: response.usage,
    stopReason: response.stopReason,
  };
}

async function maybeDescribeImage(item, ctx, params = {}, signal, onUpdate) {
  if (!params.describe) return undefined;
  onUpdate?.({ content: [{ type: "text", text: `Describing ${item.label} with a vision model...` }] });
  return describeImageFile(item.path, item, ctx, params, signal);
}



async function runTendrilJson(pi, args, { signal, timeout = 30_000 } = {}) {
  const result = await pi.exec("tendril", args, { signal, timeout });
  const envelope = parseJsonEnvelope(result.stdout, `tendril ${args[0] || ""}`);
  if (result.code !== 0 || envelope.status === "error") {
    const message = envelope.error?.message || result.stderr || `tendril exited with code ${result.code}`;
    const code = envelope.error?.code ? ` (${envelope.error.code})` : "";
    throw new Error(`tendril ${args[0] || "command"} failed${code}: ${message}`);
  }
  return envelope;
}


async function resolveTendrilTarget(pi, params, signal) {
  if (params.window && params.display) throw new Error("Specify only one of window or display.");
  if (params.window) return { kind: "window", id: String(params.window), source: "explicit" };
  if (params.display) return { kind: "display", id: String(params.display), source: "explicit" };

  const envelope = await runTendrilJson(pi, ["list", "--json"], { signal, timeout: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) });
  let targets = Array.isArray(envelope.data?.targets) ? envelope.data.targets : [];
  targets = targets.filter((target) => target?.capabilities?.capture && target.id && target.kind);
  if (params.targetName) {
    const needle = String(params.targetName).toLowerCase();
    targets = targets.filter((target) => targetText(target).includes(needle));
  }
  const targetKind = params.targetKind || "display";
  const kinds = targetKind === "auto" ? ["display", "window"] : [targetKind];
  for (const kind of kinds) {
    const match = targets.find((target) => target.kind === kind);
    if (match) return { ...match, id: String(match.id), source: "list" };
  }
  const fallback = targets[0];
  if (fallback) return { ...fallback, id: String(fallback.id), source: "list" };
  throw new Error("No capture-capable Tendril targets found.");
}

// buildTendrilCaptureArgs is imported from
// ./kitty-image-preview/cli-commands.js (extracted in bd-e1914a).

async function describeTendrilTargetFullResolution(pi, target, ctx, params, signal, onUpdate, fallbackItem) {
  if (!params.describe && params.describeIntervalSecs === undefined) return undefined;
  const dir = getDescribeTempDir(ctx);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `describe-${timestampForFilename()}-${sanitizeFilenamePart(target.kind)}-${sanitizeFilenamePart(target.id)}.png`);
  try {
    const fullParams = fullResolutionDescribeParams(params);
    const args = buildTendrilCaptureArgs(fullParams, target, filePath);
    onUpdate?.({ content: [{ type: "text", text: `Capturing full-resolution frame for VLM description...` }] });
    await runTendrilJson(pi, args, {
      signal,
      timeout: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) + 5_000,
    });
    const item = await buildItem(ctx.cwd, filePath, `${fallbackItem?.label || defaultScreenshotLabel(target)} full-resolution description frame`);
    return await describeImageFile(filePath, item, ctx, { ...params, describe: true }, signal);
  } catch (error) {
    if (!fallbackItem) throw error;
    ctx.ui?.notify?.(`Full-resolution description capture failed; describing preview frame: ${error.message}`, "warning");
    return describeImageFile(fallbackItem.path, fallbackItem, ctx, { ...params, describe: true }, signal);
  } finally {
    await unlinkIfExists(filePath).catch(() => {});
  }
}

async function unlinkIfExists(filePath) {
  if (!filePath) return;
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function cleanupStreamFiles(stream) {
  if (!stream) return;
  const files = [stream.framePaths?.[0], stream.framePaths?.[1]];
  if (stream.ownsSourcePath) files.push(stream.sourcePath);
  await Promise.all(files.filter(Boolean).map((file) => unlinkIfExists(file)));
}

// buildPlaywrightCliScreenshotArgs / buildPlaywrightCliScreenshotCommand are
// imported from ./kitty-image-preview/cli-commands.js (extracted in bd-e1914a).

async function runPlaywrightCliScreenshot(pi, stream) {
  const args = buildPlaywrightCliScreenshotArgs(stream.params, stream.sourcePath);
  const result = await pi.exec("playwright-cli", args, {
    timeout: clampInteger(stream.params.timeoutMs, 30_000, 1_000, 120_000),
  });
  if (result.code !== 0) {
    const message = String(result.stderr || result.stdout || `playwright-cli exited with code ${result.code}`).trim();
    throw new Error(message);
  }
}

async function maybeDescribeStreamFrame(pi, state, ctx, stream, item, params, signal) {
  const intervalSeconds = params.describeIntervalSecs === undefined
    ? (params.describe ? DEFAULT_DESCRIBE_INTERVAL_SECONDS : undefined)
    : clampInteger(params.describeIntervalSecs, DEFAULT_DESCRIBE_INTERVAL_SECONDS, 1, 86_400);
  if (!params.describe && intervalSeconds === undefined) return;
  const now = Date.now();
  if (stream.descriptionInFlight) return;
  if (stream.lastDescriptionAt && intervalSeconds !== undefined && now - stream.lastDescriptionAt < intervalSeconds * 1000) return;
  stream.lastDescriptionAt = now;
  stream.descriptionInFlight = true;
  const describePromise = stream.source === "tendril"
    ? describeTendrilTargetFullResolution(pi, stream.target, ctx, params, signal, undefined, item)
    : describeImageFile(stream.describeSourcePath || item.path, item, ctx, { ...params, describe: true }, signal);
  describePromise
    .then((description) => {
      stream.latestDescription = { ...description, frame: stream.frameCount, path: item.path, at: Date.now() };
      ctx.ui?.setStatus?.(WIDGET_ID, `🖼 stream ${stream.frameCount} • described`);
    })
    .catch((error) => {
      stream.lastDescriptionError = error.message;
    })
    .finally(() => {
      stream.descriptionInFlight = false;
    });
}

async function captureTendrilStreamFrame(pi, ctx, state, stream) {
  if (!stream?.running || stream.capturing) return;
  stream.capturing = true;
  const frameIndex = stream.nextFrameIndex % 2;
  stream.nextFrameIndex += 1;
  const outputPath = stream.framePaths[frameIndex];
  const controller = new AbortController();
  stream.currentController = controller;
  try {
    await unlinkIfExists(outputPath);
    const args = buildTendrilCaptureArgs(stream.params, stream.target, outputPath);
    await runTendrilJson(pi, args, {
      signal: controller.signal,
      timeout: clampInteger(stream.params.timeoutMs, 30_000, 1_000, 120_000) + 5_000,
    });
    if (!stream.running) return;
    const item = await buildItem(ctx.cwd, outputPath, `stream ${stream.target.kind} ${stream.target.id} frame ${stream.frameCount + 1}`);
    // Reuse the stream's single stable image id and overwrite it each frame
    // instead of minting a fresh per-frame id (bd-ded98d element (d)).
    item.id = resolveStreamFrameId(stream, item.id);
    replaceItems(state, [item]);
    state.index = 0;
    state.visible = true;
    stream.latestPath = outputPath;
    stream.latestItem = item;
    stream.frameCount += 1;
    stream.lastFrameAt = Date.now();
    stream.lastError = undefined;
    await prepareCurrentImage(state, ctx, { forceReload: true });
    syncWidget(ctx, state);
    await maybeDescribeStreamFrame(pi, state, ctx, stream, item, stream.params, controller.signal);
    const previousPath = stream.framePaths[1 - frameIndex];
    if (previousPath !== stream.latestPath) await unlinkIfExists(previousPath).catch(() => {});
  } catch (error) {
    if (!stream.running || controller.signal.aborted) return;
    stream.lastError = error.message;
    ctx.ui?.notify?.(`kitty image stream frame failed: ${error.message}`, "warning");
  } finally {
    stream.capturing = false;
    stream.currentController = undefined;
  }
}

async function captureFileStreamFrame(pi, ctx, state, stream) {
  if (!stream?.running || stream.capturing) return;
  stream.capturing = true;
  const sourcePath = stream.sourcePath;
  try {
    if (stream.source === "playwright-cli") await runPlaywrightCliScreenshot(pi, stream);
    const sourceInfo = await stat(sourcePath);
    if (!sourceInfo.isFile()) throw new Error(`Playwright screenshot path is not a file: ${sourcePath}`);
    const signature = `${sourceInfo.mtimeMs}:${sourceInfo.size}`;
    if (signature === stream.sourceSignature) return;
    stream.sourceSignature = signature;
    const frameIndex = stream.nextFrameIndex % 2;
    stream.nextFrameIndex += 1;
    const outputPath = stream.framePaths[frameIndex];
    await copyFile(sourcePath, outputPath);
    if (!stream.running) return;
    const item = await buildItem(ctx.cwd, outputPath, `playwright mirror frame ${stream.frameCount + 1}`);
    // Reuse the stream's single stable image id and overwrite it each frame
    // instead of minting a fresh per-frame id (bd-ded98d element (d)).
    item.id = resolveStreamFrameId(stream, item.id);
    replaceItems(state, [item]);
    state.index = 0;
    state.visible = true;
    stream.latestPath = outputPath;
    stream.latestItem = item;
    stream.frameCount += 1;
    stream.lastFrameAt = Date.now();
    stream.lastError = undefined;
    stream.consecutiveErrors = 0;
    await prepareCurrentImage(state, ctx, { forceReload: true });
    syncWidget(ctx, state);
    await maybeDescribeStreamFrame(pi, state, ctx, stream, item, stream.params, stream.currentController?.signal);
    const previousPath = stream.framePaths[1 - frameIndex];
    if (previousPath !== stream.latestPath) await unlinkIfExists(previousPath).catch(() => {});
  } catch (error) {
    if (!stream.running) return;
    stream.consecutiveErrors = (stream.consecutiveErrors || 0) + 1;
    stream.lastError = error?.code === "ENOENT"
      ? `Waiting for Playwright screenshot at ${sourcePath}`
      : error.message;
    if (stream.source === "playwright-cli" && stream.stopAfterErrors && stream.consecutiveErrors >= stream.stopAfterErrors) {
      stream.running = false;
      if (stream.timer) clearTimeout(stream.timer);
      stream.lastError = `${stream.lastError} (stopped after ${stream.consecutiveErrors} consecutive errors)`;
    }
  } finally {
    stream.capturing = false;
  }
}

async function captureAnyStreamFrame(pi, ctx, state, stream) {
  if (stream?.source === "playwright-file" || stream?.source === "playwright-cli") {
    return captureFileStreamFrame(pi, ctx, state, stream);
  }
  return captureTendrilStreamFrame(pi, ctx, state, stream);
}

function scheduleNextStreamFrame(pi, ctx, state, stream) {
  if (!stream?.running) return;
  stream.timer = keepTimerFromHoldingProcess(setTimeout(async () => {
    await captureAnyStreamFrame(pi, ctx, state, stream);
    scheduleNextStreamFrame(pi, ctx, state, stream);
  }, stream.intervalMs));
}

async function stopStream(state, { cleanup = false } = {}) {
  const stream = state.stream;
  if (!stream) return undefined;
  state.stream = undefined;
  stream.running = false;
  if (stream.timer) {
    clearTimeout(stream.timer);
    stream.timer = undefined;
  }
  stream.currentController?.abort?.();
  if (cleanup) await cleanupStreamFiles(stream).catch(() => {});
  return stream;
}

export default function kittyImagePreviewExtension(pi) {
  const state = {
    visible: false,
    index: 0,
    items: [],
    currentCommand: undefined,
    lastDeleteCommand: "",
    animationTimer: undefined,
    animation: { running: false },
    cycleTimer: undefined,
    cycle: { running: false },
    stream: undefined,
    ownedImageIds: new Set(),
    config: {
      columns: DEFAULT_COLUMNS,
      rows: undefined,
      minRows: 4,
      maxRows: DEFAULT_MAX_ROWS,
      zIndex: DEFAULT_Z_INDEX,
      background: false,
      showCaption: true,
      clearPrevious: true,
      placement: AUTO_PLACEMENT,
      placementId: kittyPreviewDefaultPlacementId(),
      transferMode: "auto",
      passthrough: "auto",
      placementMode: "auto",
      chunkSize: 4096,
    },
  };

  pi.on("session_start", async (_event, ctx) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName?.startsWith(TOOL_PREFIX)) {
        restorePublicState(state, entry.message.details);
      }
    }
    // Cross-generation startup reclaim (bd-b257e8 / bd-ad43f8): images transmitted
    // by a PRIOR session persist as IOSurfaces in the terminal. Because managed
    // agents now use a stable (pid-free) image-id namespace, those prior-session
    // ids — restored above into state.ownedImageIds — are addressable by THIS
    // process, so free their DATA (uppercase d=I) on restore to reclaim
    // prior-generation orphans instead of leaving them resident until a
    // WindowServer restart. The current image is excluded: with stable ids it is
    // the same id the prior generation already uploaded, so it stays resident
    // (no free+re-upload race); non-current items re-upload on navigation since
    // the transmit-once guard is cleared just below.
    const restoredCurrent = state.items[state.index];
    const startupReclaim = buildScopedDeleteCommand(state, {
      freeData: true,
      excludeIds: restoredCurrent ? [restoredCurrent.id] : [],
    });
    if (startupReclaim) flashDeleteWidget(ctx, state, startupReclaim);
    // A session_start fires on a fresh terminal attach/restore. In unicode
    // passthrough mode the new terminal does not hold any previously uploaded
    // image, so clear the transmit-once guard to force a re-upload of the
    // current image's payload on the next render (bd-d6fa1b).
    resetTransmissionGuard(state);
    // Reattach: the new terminal holds none of the multi-image page payloads, so
    // clear each page entry's render memo too, forcing a fresh upload per image
    // on the next render (the per-id transmit guard above is also cleared).
    if (state.pagePrepared instanceof Map) {
      for (const payload of state.pagePrepared.values()) payload.rendered = undefined;
    }
    if (state.visible && state.items[state.index]) {
      await prepareCurrentImage(state, ctx).catch((error) => {
        if (ctx.hasUI) ctx.ui.notify(`kitty image preview restore failed: ${error.message}`, "warning");
      });
      syncWidget(ctx, state);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAnimation(state);
    stopCycle(state);
    void stopStream(state, { cleanup: true });
    state.visible = false;
    if (ctx?.hasUI) {
      const ownedDelete = releaseOwnedImageData(state, { keepIds: [] });
      clearOwnedImageIds(state);
      if (ownedDelete) flashDeleteWidget(ctx, state, ownedDelete);
      ctx.ui.setStatus(WIDGET_ID, undefined);
    } else {
      // Headless shutdown: flashDeleteWidget early-returns without a UI, so emit
      // the owned-data free (d=I) through a non-UI writer instead of only
      // forgetting the ids (bd-ded98d element (e)).
      runHeadlessOwnedFree(ctx, state);
    }
  });

  pi.registerTool({
    name: "kitty_image_preview_add",
    label: "Kitty Image Preview Add",
    description: "Add one PNG/APNG image to the persistent kitty graphics preview widget and optionally show it immediately.",
    promptSnippet: "Add PNG/APNG images to a persistent terminal preview widget rendered with the kitty graphics protocol.",
    promptGuidelines: [
      "Use kitty_image_preview_add or kitty_image_preview_add_folder to show visual artifacts in the terminal for the operator.",
      "Prefer PNG/APNG inputs. The native kitty protocol path avoids shelling out to kitty icat.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to a PNG/APNG image. Leading @ is accepted and stripped." }),
      label: Type.Optional(Type.String({ description: "Optional display label. Defaults to a path relative to cwd." })),
      show: Type.Optional(Type.Boolean({ description: "Show this image immediately. Defaults to true." })),
      ...describeParameterSchema(),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number({ description: "Target image width in terminal cells." })),
        rows: Type.Optional(Type.Number({ description: "Target image height in terminal cells. If omitted, aspect ratio is estimated." })),
        maxRows: Type.Optional(Type.Number({ description: "Maximum auto-sized widget rows." })),
        minRows: Type.Optional(Type.Number({ description: "Minimum auto-sized widget rows." })),
        zIndex: Type.Optional(Type.Number({ description: "Kitty z-index. Negative draws under text." })),
        background: Type.Optional(Type.Boolean({ description: "Use an extremely negative z-index suitable for background-image style placement." })),
        showCaption: Type.Optional(Type.Boolean({ description: "Render a text caption over the reserved image area." })),
        clearPrevious: Type.Optional(Type.Boolean({ description: "Delete previous visible placements before drawing the current image." })),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: auto, above/below the editor widget, or the fixed right-side panel.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport. auto uses memory inside tmux, file otherwise.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode. auto detects tmux.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux and cursor placement otherwise.")),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      applyConfig(state, params.config);
      const item = await buildItem(ctx.cwd, params.path, params.label);
      pushItems(state, [item]);
      if (params.show !== false) {
        state.index = state.items.length - 1;
        state.visible = true;
        await prepareCurrentImage(state, ctx, { forceReload: true });
      }
      syncWidget(ctx, state);
      const description = await maybeDescribeImage(item, ctx, params, signal, onUpdate);
      return {
        content: makeContent(state, [
          `Added ${item.label}.`,
          description?.text ? `Description (${description.model}):\n${description.text}` : "",
        ]),
        details: makeDetails(state, { added: item, description }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_capture",
    label: "Kitty Image Preview Capture",
    description: "Capture a screenshot with the first-party tendril CLI into the Pi session screenshot folder, add it to the kitty preview list, and show it immediately.",
    promptSnippet: "Capture a current Tendril screenshot and immediately show it in the kitty terminal preview widget.",
    promptGuidelines: [
      "Use kitty_image_preview_capture when the user asks to show the current screen, window, UI state, or latest screenshot in the terminal.",
      "If no target is provided, it automatically chooses the first capture-capable display from tendril list.",
    ],
    parameters: Type.Object({
      window: Type.Optional(Type.String({ description: "Explicit Tendril window id to capture. Mutually exclusive with display." })),
      display: Type.Optional(Type.String({ description: "Explicit Tendril display id to capture. Mutually exclusive with window." })),
      targetKind: Type.Optional(stringEnum(["auto", "display", "window"], "Target kind to auto-select from tendril list when window/display is omitted. Defaults to display.")),
      targetName: Type.Optional(Type.String({ description: "Case-insensitive substring matched against Tendril target title/name/app_name/id during auto-selection." })),
      outputDir: Type.Optional(Type.String({ description: "Screenshot output directory. Defaults to a kitty-image-preview-screenshots folder beside the Pi session file." })),
      filename: Type.Optional(Type.String({ description: "Optional output filename, with or without .png. Defaults to timestamp-target.png." })),
      label: Type.Optional(Type.String({ description: "Optional preview label. Defaults to a screenshot label with target and time." })),
      replace: Type.Optional(Type.Boolean({ description: "Replace the current preview list with this screenshot. Defaults to true; set false to append." })),
      maxWidth: Type.Optional(Type.Number({ description: "Optional Tendril capture --max-width in pixels." })),
      maxHeight: Type.Optional(Type.Number({ description: "Optional Tendril capture --max-height in pixels." })),
      compression: Type.Optional(Type.String({ description: "Optional Tendril capture --compression value." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Tendril list/capture timeout in milliseconds. Defaults to 30000." })),
      ...describeParameterSchema(),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: auto, above/below the editor widget, or the fixed right-side panel.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      applyConfig(state, params.config);
      const target = await resolveTendrilTarget(pi, params, signal);
      const now = new Date();
      const output = buildScreenshotOutputPath(ctx, params, target, now);
      await mkdir(output.dir, { recursive: true });
      onUpdate?.({ content: [{ type: "text", text: `Capturing ${target.kind} ${target.id} with Tendril...` }] });
      const args = buildTendrilCaptureArgs(params, target, output.path);
      const capture = await runTendrilJson(pi, args, {
        signal,
        timeout: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) + 5_000,
      });
      const item = await buildItem(ctx.cwd, output.path, params.label || defaultScreenshotLabel(target, now));
      if (params.replace !== false) {
        stopAnimation(state);
        stopCycle(state);
        state.items = [];
      }
      pushItems(state, [item]);
      state.index = state.items.length - 1;
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      syncWidget(ctx, state);
      const description = params.describe
        ? await describeTendrilTargetFullResolution(pi, target, ctx, params, signal, onUpdate, item)
        : undefined;
      return {
        content: makeContent(state, [
          `Captured ${target.kind} ${target.id} to ${output.path}.`,
          description?.text ? `Description (${description.model}):\n${description.text}` : "",
        ]),
        details: makeDetails(state, {
          capture: {
            target: { kind: target.kind, id: target.id, title: target.title, name: target.name, appName: target.app_name },
            outputPath: output.path,
            outputDir: output.dir,
            tendrilArgs: args,
            tendril: capture,
          },
          added: item,
          description,
        }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_add_folder",
    label: "Kitty Image Preview Add Folder",
    description: "Add a folder/series of PNG/APNG images to the persistent kitty graphics preview widget.",
    promptSnippet: "Add a folder or image series to the kitty terminal preview widget.",
    parameters: Type.Object({
      path: Type.String({ description: "Directory containing PNG/APNG images." }),
      recursive: Type.Optional(Type.Boolean({ description: "Recurse into subdirectories. Defaults to false." })),
      limit: Type.Optional(Type.Number({ description: "Maximum images to add. Defaults to 200." })),
      replace: Type.Optional(Type.Boolean({ description: "Replace the existing preview list instead of appending. Defaults to false." })),
      showIndex: Type.Optional(Type.Number({ description: "Zero-based index among newly added images to show. Defaults to 0." })),
      ...describeParameterSchema(),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: auto, above/below the editor widget, or the fixed right-side panel.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      applyConfig(state, params.config);
      const directory = resolveUserPath(ctx.cwd, params.path);
      const files = await collectPngFiles(directory, {
        recursive: Boolean(params.recursive),
        limit: clampInteger(params.limit, 200, 1, 5000),
      });
      if (files.length === 0) throw new Error(`No PNG/APNG images found in ${directory}`);
      const items = [];
      for (const file of files) items.push(await buildItem(ctx.cwd, file));
      if (params.replace) state.items = [];
      const startIndex = state.items.length;
      pushItems(state, items);
      state.index = startIndex + clampInteger(params.showIndex, 0, 0, items.length - 1);
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      syncWidget(ctx, state);
      const current = state.items[state.index];
      const description = current ? await maybeDescribeImage(current, ctx, params, signal, onUpdate) : undefined;
      return {
        content: makeContent(state, [
          `Added ${items.length} image(s) from ${relativeLabel(ctx.cwd, directory)}.`,
          description?.text ? `Description (${description.model}):\n${description.text}` : "",
        ]),
        details: makeDetails(state, { addedCount: items.length, added: items, description }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_show",
    label: "Kitty Image Preview Show",
    description: "Navigate or control the persistent kitty graphics preview widget: current, next, previous, index, first, last, hide, clear.",
    promptSnippet: "Navigate the kitty image preview with next, previous, indexed, hide, and clear actions.",
    parameters: Type.Object({
      action: stringEnum(["current", "next", "previous", "index", "first", "last", "hide", "clear"], "Preview navigation action."),
      index: Type.Optional(Type.Number({ description: "Zero-based image index for action=index." })),
      ...describeParameterSchema(),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: auto, above/below the editor widget, or the fixed right-side panel.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      applyConfig(state, params.config);
      if (params.action === "clear") {
        state.lastDeleteCommand = releaseOwnedImageData(state, { keepIds: [] });
        clearOwnedImageIds(state);
        state.visible = false;
        state.items = [];
        state.index = 0;
        state.currentCommand = undefined;
        syncWidget(ctx, state);
        stopAnimation(state);
        stopCycle(state);
        flashDeleteWidget(ctx, state, state.lastDeleteCommand);
        return { content: [{ type: "text", text: "Cleared kitty image preview." }], details: makeDetails(state) };
      }
      if (params.action === "hide") {
        state.lastDeleteCommand = buildScopedDeleteCommand(state);
        state.visible = false;
        stopAnimation(state);
        stopCycle(state);
        flashDeleteWidget(ctx, state, state.lastDeleteCommand);
        setTimeout(() => syncWidget(ctx, state), 120);
        return { content: [{ type: "text", text: "Hid kitty image preview. Use /image-show to restore it." }], details: makeDetails(state) };
      }
      if (state.items.length === 0) throw new Error("No images have been added yet.");
      if (params.action === "next") state.index = (state.index + 1) % state.items.length;
      if (params.action === "previous") state.index = (state.index - 1 + state.items.length) % state.items.length;
      if (params.action === "first") state.index = 0;
      if (params.action === "last") state.index = state.items.length - 1;
      if (params.action === "index") state.index = clampInteger(params.index, state.index, 0, state.items.length - 1);
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      syncWidget(ctx, state);
      const current = state.items[state.index];
      const description = current ? await maybeDescribeImage(current, ctx, params, signal, onUpdate) : undefined;
      return {
        content: makeContent(state, [description?.text ? `Description (${description.model}):\n${description.text}` : ""]),
        details: makeDetails(state, { description }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_animate",
    label: "Kitty Image Preview Animate",
    description: "Start or stop lightweight animation by cycling the loaded preview image series in the persistent kitty widget.",
    promptSnippet: "Animate a loaded kitty image series by cycling preview frames at an interval.",
    parameters: Type.Object({
      action: stringEnum(["start", "stop"], "Animation control action."),
      intervalMs: Type.Optional(Type.Number({ description: "Frame interval in milliseconds. Defaults to 250; minimum 50." })),
      loop: Type.Optional(Type.Boolean({ description: "Loop when the end of the series is reached. Defaults to true." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "stop") {
        stopAnimation(state);
        syncWidget(ctx, state);
        return { content: [{ type: "text", text: "Stopped kitty image preview animation." }], details: makeDetails(state) };
      }
      if (state.items.length === 0) throw new Error("No images have been added yet.");
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      startAnimation(state, ctx, {
        intervalMs: clampInteger(params.intervalMs, 250, 50, 60_000),
        loop: params.loop !== false,
      });
      syncWidget(ctx, state);
      return {
        content: makeContent(state, [`Started animation at ${state.animation.intervalMs}ms per frame.`]),
        details: makeDetails(state, { animation: { ...state.animation } }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_stream_start",
    label: "Kitty Image Preview Stream Start",
    description: "Start a lightweight Tendril screenshot stream into the kitty preview using a two-file temp buffer. Frames are UI-only and are not added to agent context.",
    promptSnippet: "Start an ephemeral screen/window stream in the kitty image preview without accumulating images in context or on disk.",
    parameters: Type.Object({
      window: Type.Optional(Type.String({ description: "Explicit Tendril window id to capture. Mutually exclusive with display." })),
      display: Type.Optional(Type.String({ description: "Explicit Tendril display id to capture. Mutually exclusive with window." })),
      targetKind: Type.Optional(stringEnum(["auto", "display", "window"], "Target kind to auto-select from tendril list when window/display is omitted. Defaults to display.")),
      targetName: Type.Optional(Type.String({ description: "Case-insensitive substring matched against Tendril target title/name/app_name/id during auto-selection." })),
      maxWidth: Type.Optional(Type.Number({ description: "Optional Tendril capture --max-width in pixels." })),
      maxHeight: Type.Optional(Type.Number({ description: "Optional Tendril capture --max-height in pixels." })),
      compression: Type.Optional(Type.String({ description: "Optional Tendril capture --compression value." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Tendril list/capture timeout in milliseconds. Defaults to 30000." })),
      intervalMs: Type.Optional(Type.Number({ description: "Requested delay between completed captures. Defaults to 1000ms. Use 0 for max non-overlapping capture rate." })),
      ...streamDescribeParameterSchema(),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: auto, above/below the editor widget, or the fixed right-side panel.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      await stopStream(state, { cleanup: true });
      stopAnimation(state);
      applyConfig(state, params.config);
      const target = await resolveTendrilTarget(pi, params, signal);
      const dir = getStreamDir(ctx);
      await mkdir(dir, { recursive: true });
      const stream = {
        running: true,
        source: "tendril",
        target,
        params: { ...params, timeoutMs: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) },
        dir,
        framePaths: [path.join(dir, "frame-a.png"), path.join(dir, "frame-b.png")],
        imageId: kittyPreviewStreamImageId(),
        intervalMs: clampInteger(params.intervalMs, DEFAULT_STREAM_INTERVAL_MS, 0, 60_000),
        nextFrameIndex: 0,
        frameCount: 0,
        startedAt: Date.now(),
        latestPath: undefined,
        latestItem: undefined,
        timer: undefined,
        capturing: false,
        currentController: undefined,
        latestDescription: undefined,
        lastDescriptionAt: undefined,
        descriptionInFlight: false,
      };
      state.stream = stream;
      onUpdate?.({ content: [{ type: "text", text: `Starting stream from ${target.kind} ${target.id}...` }] });
      await captureTendrilStreamFrame(pi, ctx, state, stream);
      scheduleNextStreamFrame(pi, ctx, state, stream);
      return {
        content: makeContent(state, [streamStatusLine(stream), "Frames use a two-file temp buffer and are not appended to session context."]),
        details: makeDetails(state, { stream: { target, dir, intervalMs: stream.intervalMs, latestPath: stream.latestPath } }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_playwright_start",
    label: "Kitty Image Preview Playwright Start",
    description: "Start a Playwright visual mirror by watching a PNG file that Playwright overwrites after DOM actions. The user sees browser state while the agent can continue using DOM-only context.",
    promptSnippet: "Mirror a Playwright browser screenshot file into the kitty preview without adding frames to model context.",
    parameters: Type.Object({
      screenshotPath: Type.Optional(Type.String({ description: "PNG path for screenshots. Defaults to a temp path returned in the tool result." })),
      pollMs: Type.Optional(Type.Number({ description: "Polling/capture interval. Defaults to 250ms." })),
      autoScreenshot: Type.Optional(Type.Boolean({ description: "Automatically run playwright-cli screenshot on every poll. Defaults to true. Set false to only watch a file written by external Playwright code." })),
      stopAfterErrors: Type.Optional(Type.Number({ description: "Stop auto screenshot mode after this many consecutive playwright-cli errors. Defaults to 20; set 0 to keep retrying." })),
      timeoutMs: Type.Optional(Type.Number({ description: "playwright-cli screenshot timeout in milliseconds. Defaults to 30000." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Affects returned Playwright screenshot snippets. Defaults to false." })),
      session: Type.Optional(Type.String({ description: "Optional playwright-cli session passed as -s=<session>." })),
      ref: Type.Optional(Type.String({ description: "Optional playwright-cli element ref for element screenshots." })),
      ...streamDescribeParameterSchema(),
      config: Type.Optional(Type.Object({
        columns: Type.Optional(Type.Number()),
        rows: Type.Optional(Type.Number()),
        maxRows: Type.Optional(Type.Number()),
        minRows: Type.Optional(Type.Number()),
        zIndex: Type.Optional(Type.Number()),
        background: Type.Optional(Type.Boolean()),
        showCaption: Type.Optional(Type.Boolean()),
        clearPrevious: Type.Optional(Type.Boolean()),
        placement: Type.Optional(stringEnum(PREVIEW_PLACEMENTS, "Where Pi should mount the preview: auto, above/below the editor widget, or the fixed right-side panel.")),
        transferMode: Type.Optional(stringEnum(["auto", "memory", "file"], "Kitty transfer transport.")),
        passthrough: Type.Optional(stringEnum(["auto", "tmux", "none"], "Escape passthrough mode.")),
        placementMode: Type.Optional(stringEnum(["auto", "unicode", "cursor"], "Graphics placement mode. auto uses Unicode placeholders inside tmux.")),
      })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await stopStream(state, { cleanup: true });
      stopAnimation(state);
      applyConfig(state, params.config);
      const dir = getStreamDir(ctx);
      await mkdir(dir, { recursive: true });
      const sourcePath = params.screenshotPath
        ? resolveUserPath(ctx.cwd, params.screenshotPath)
        : path.join(dir, "playwright-source.png");
      state.items = [];
      state.index = 0;
      state.visible = false;
      state.currentCommand = undefined;
      syncWidget(ctx, state);
      const autoScreenshot = params.autoScreenshot !== false;
      const stream = {
        running: true,
        source: autoScreenshot ? "playwright-cli" : "playwright-file",
        target: { kind: "playwright", id: path.basename(sourcePath), source: "file" },
        params,
        dir,
        sourcePath,
        ownsSourcePath: !params.screenshotPath,
        describeSourcePath: sourcePath,
        framePaths: [path.join(dir, "playwright-frame-a.png"), path.join(dir, "playwright-frame-b.png")],
        imageId: kittyPreviewStreamImageId(),
        intervalMs: clampInteger(params.pollMs, 250, 50, 60_000),
        nextFrameIndex: 0,
        frameCount: 0,
        startedAt: Date.now(),
        latestPath: undefined,
        latestItem: undefined,
        timer: undefined,
        capturing: false,
        currentController: new AbortController(),
        stopAfterErrors: clampInteger(params.stopAfterErrors, 20, 0, 10_000) || undefined,
        consecutiveErrors: 0,
        latestDescription: undefined,
        lastDescriptionAt: undefined,
        descriptionInFlight: false,
      };
      state.stream = stream;
      await captureFileStreamFrame(pi, ctx, state, stream);
      scheduleNextStreamFrame(pi, ctx, state, stream);
      const jsSnippet = `await page.screenshot({ path: ${JSON.stringify(sourcePath)}, fullPage: ${params.fullPage === true ? "true" : "false"} });`;
      const cliCommand = buildPlaywrightCliScreenshotCommand(params, sourcePath);
      return {
        content: makeContent(state, [
          `Started Playwright visual mirror ${autoScreenshot ? "capturing via playwright-cli" : "watching"} ${sourcePath}.`,
          stream.frameCount === 0 ? (autoScreenshot ? `Waiting for playwright-cli screenshot to succeed. ${stream.lastError || ""}` : "Waiting for Playwright to write the first PNG.") : streamStatusLine(stream),
          autoScreenshot ? `Auto-running: ${cliCommand}` : `After DOM-changing playwright-cli actions, run: ${cliCommand}`,
          `If using raw Playwright JS instead, run: ${jsSnippet}`,
          "Frames are display-only unless sampled/described explicitly.",
        ]),
        details: makeDetails(state, { playwrightMirror: { sourcePath, pollMs: stream.intervalMs, autoScreenshot, cliCommand, jsSnippet, lastError: stream.lastError } }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_stream_stop",
    label: "Kitty Image Preview Stream Stop",
    description: "Stop the active kitty screenshot stream. Optionally hide the preview and clean temporary frame files.",
    promptSnippet: "Stop the active ephemeral kitty screenshot stream.",
    parameters: Type.Object({
      hide: Type.Optional(Type.Boolean({ description: "Hide the preview after stopping. Defaults to false." })),
      cleanup: Type.Optional(Type.Boolean({ description: "Delete stream temp frame files. Defaults to true when hide=true, otherwise false so the latest visible frame remains valid." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cleanup = params.cleanup ?? Boolean(params.hide);
      const stream = await stopStream(state, { cleanup });
      if (params.hide) {
        state.visible = false;
        flashDeleteWidget(ctx, state, buildScopedDeleteCommand(state));
        setTimeout(() => syncWidget(ctx, state), 120);
      } else {
        syncWidget(ctx, state);
      }
      return {
        content: [{ type: "text", text: stream ? `Stopped stream. ${streamStatusLine({ ...stream, running: true })}` : "No stream was running." }],
        details: makeDetails(state, { stoppedStream: stream ? { frameCount: stream.frameCount, latestPath: stream.latestPath, cleanup } : undefined }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_stream_status",
    label: "Kitty Image Preview Stream Status",
    description: "Report the active kitty screenshot stream status, including latest frame path and latest VLM description metadata if enabled.",
    promptSnippet: "Inspect the active ephemeral kitty screenshot stream.",
    parameters: Type.Object({}),
    async execute() {
      const stream = state.stream;
      const lines = [
        streamStatusLine(stream),
        stream?.lastError ? `lastError=${stream.lastError}` : "",
        stream?.lastDescriptionError ? `lastDescriptionError=${stream.lastDescriptionError}` : "",
        stream?.latestDescription?.text ? `latestDescription (${stream.latestDescription.model}, frame ${stream.latestDescription.frame}):\n${stream.latestDescription.text}` : "",
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: makeDetails(state, { stream: stream ? {
          running: stream.running,
          target: stream.target,
          intervalMs: stream.intervalMs,
          frameCount: stream.frameCount,
          latestPath: stream.latestPath,
          lastFrameAt: stream.lastFrameAt,
          latestDescription: stream.latestDescription,
          lastError: stream.lastError,
        } : undefined }),
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_stream_sample",
    label: "Kitty Image Preview Stream Sample",
    description: "Persist the latest stream frame to the session screenshot folder and optionally describe it with a vision model.",
    promptSnippet: "Persist or describe one selected frame from the active ephemeral stream.",
    parameters: Type.Object({
      outputDir: Type.Optional(Type.String({ description: "Optional output directory. Defaults to the session screenshot folder." })),
      filename: Type.Optional(Type.String({ description: "Optional output filename, with or without .png." })),
      label: Type.Optional(Type.String({ description: "Optional sample label." })),
      addToGallery: Type.Optional(Type.Boolean({ description: "Add the persisted sample to the preview gallery. Defaults to false while streaming." })),
      ...describeParameterSchema(),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const stream = state.stream;
      if (!stream?.latestPath || !stream.latestItem) throw new Error("No stream frame is available to sample.");
      const target = stream.target;
      const now = new Date();
      const output = buildScreenshotOutputPath(ctx, {
        outputDir: params.outputDir,
        filename: params.filename || `stream-sample-${timestampForFilename(now)}`,
      }, target, now);
      await mkdir(output.dir, { recursive: true });
      await copyFile(stream.latestPath, output.path);
      const item = await buildItem(ctx.cwd, output.path, params.label || `stream sample ${target.kind} ${target.id} ${now.toLocaleTimeString()}`);
      if (params.addToGallery) {
        pushItems(state, [item]);
        state.index = state.items.length - 1;
        state.visible = true;
        await prepareCurrentImage(state, ctx, { forceReload: true });
        syncWidget(ctx, state);
      }
      const description = await maybeDescribeImage(item, ctx, params, signal, onUpdate);
      return {
        content: makeContent(state, [
          `Sampled latest stream frame to ${output.path}.`,
          description?.text ? `Description (${description.model}):\n${description.text}` : "",
        ]),
        details: makeDetails(state, { sample: item, outputPath: output.path, description }),
      };
    },
  });

  function previewDiagnostics() {
    const current = state.items[state.index];
    const passthroughDetected = detectKittyPassthroughMode(process.env);
    const passthrough = state.config.passthrough === "auto" ? passthroughDetected : state.config.passthrough;
    const memoryAuto = shouldUseInMemoryTransfer(process.env);
    const transport = state.config.transferMode === "auto" ? (memoryAuto ? "memory" : "file") : state.config.transferMode;
    const placement = state.config.placementMode === "auto"
      ? (shouldRenderUnicodePlaceholders(state, { placement: resolvePlacement(state) }) ? "unicode" : "cursor")
      : state.config.placementMode;
    const placementId = state.config.placementId;
    const unicodePlacement24 = placementId ? (placementId % 0x1000000 || 1) : undefined;
    return {
      requested: {
        transferMode: state.config.transferMode,
        passthrough: state.config.passthrough,
        placementMode: state.config.placementMode,
      },
      resolved: {
        transport,
        passthrough,
        passthroughDetected,
        placement,
        ssh: isRemoteSshSession(process.env),
        memoryAuto,
      },
      ids: {
        imageId: current?.id,
        imageHex: current?.id !== undefined ? `0x${Number(current.id).toString(16)}` : undefined,
        placementId,
        placementHex: placementId !== undefined ? `0x${Number(placementId).toString(16)}` : undefined,
        unicodePlacement24,
        unicodePlacement24Hex: unicodePlacement24 !== undefined ? `0x${Number(unicodePlacement24).toString(16)}` : undefined,
        ownedCount: state.ownedImageIds?.size || 0,
        transmittedGuardCount: state.transmittedSignatures?.size || 0,
      },
      currentCommand: state.currentCommand ? {
        transport: state.currentCommand.transport,
        signature: state.currentCommand.signature,
        hasInlinePayload: Boolean(state.currentCommand.pngBase64),
        hasFilePath: Boolean(state.currentCommand.filePath),
      } : undefined,
    };
  }

  pi.registerTool({
    name: "kitty_image_preview_status",
    label: "Kitty Image Preview Status",
    description: "Report the current kitty image preview state, terminal passthrough detection, and loaded image list.",
    promptSnippet: "Inspect current kitty image preview state and loaded image list.",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = serializePublicState(state);
      const diagnostics = previewDiagnostics();
      const lines = [
        summarizeCurrent(state),
        `visible=${state.visible} images=${state.items.length} passthroughDetected=${diagnostics.resolved.passthroughDetected} ssh=${diagnostics.resolved.ssh} memoryAuto=${diagnostics.resolved.memoryAuto}`,
        `resolved transport=${diagnostics.resolved.transport} passthrough=${diagnostics.resolved.passthrough} placement=${diagnostics.resolved.placement}`,
        diagnostics.ids.imageId !== undefined
          ? `ids image=${diagnostics.ids.imageId} (${diagnostics.ids.imageHex}) placement=${diagnostics.ids.placementId} (${diagnostics.ids.placementHex}) unicodePlacement24=${diagnostics.ids.unicodePlacement24} (${diagnostics.ids.unicodePlacement24Hex}) owned=${diagnostics.ids.ownedCount} guard=${diagnostics.ids.transmittedGuardCount}`
          : undefined,
        diagnostics.currentCommand
          ? `currentCommand transport=${diagnostics.currentCommand.transport} inlinePayload=${diagnostics.currentCommand.hasInlinePayload} filePath=${diagnostics.currentCommand.hasFilePath}`
          : undefined,
        ...state.items.map((item, index) => `${index === state.index ? "→" : " "} ${index}: ${item.label}`),
      ].filter(Boolean);
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kittyImagePreviewState: snapshot, diagnostics },
      };
    },
  });

  pi.registerTool({
    name: "kitty_image_preview_cycle",
    label: "Kitty Image Preview Cycle",
    description: "Start or stop a timed cycling mode that advances through the loaded preview images on a fixed interval. Equivalent to /image-start-cycle and /image-stop-cycle.",
    promptSnippet: "Start or stop timed cycling through the kitty image preview gallery.",
    parameters: Type.Object({
      action: stringEnum(["start", "stop"], "Cycle control action."),
      intervalSeconds: Type.Optional(Type.Number({ description: "Seconds between transitions when action=start. Defaults to 5." })),
      direction: Type.Optional(stringEnum(["forward", "backward"], "Cycle direction. Defaults to forward.")),
      loop: Type.Optional(Type.Boolean({ description: "Wrap around at gallery edges. Defaults to true." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "stop") {
        stopCycle(state);
        syncWidget(ctx, state);
        return { content: [{ type: "text", text: "Stopped kitty image preview cycle." }], details: makeDetails(state) };
      }
      if (state.items.length === 0) throw new Error("No images have been added yet.");
      state.visible = true;
      await prepareCurrentImage(state, ctx, { forceReload: true });
      const intervalSeconds = clampInteger(params.intervalSeconds, 5, 1, 3600);
      startCycle(state, ctx, {
        intervalMs: intervalSeconds * 1000,
        direction: params.direction === "backward" ? -1 : 1,
        loop: params.loop !== false,
      });
      syncWidget(ctx, state);
      return {
        content: makeContent(state, [`Started cycling every ${intervalSeconds}s ${params.direction === "backward" ? "backward" : "forward"}.`]),
        details: makeDetails(state, { cycle: { ...state.cycle } }),
      };
    },
  });

  function registerImageCommand(names, description, handler) {
    for (const name of names) pi.registerCommand(name, { description, handler });
  }

  function noImages(ctx) {
    ctx.ui?.notify?.("No kitty preview images loaded.", "warning");
  }

  async function navigateCommand(ctx, direction) {
    if (state.items.length === 0) {
      noImages(ctx);
      return;
    }
    advanceIndex(state, direction);
    state.visible = true;
    await prepareCurrentImage(state, ctx, { forceReload: true });
    syncWidget(ctx, state);
    ctx.ui?.notify?.(`${summarizeCurrent(state)} ${imageControlHint(state, { includeCount: true })}`, "info");
  }

  async function showCommand(ctx) {
    if (state.items.length === 0) {
      noImages(ctx);
      return;
    }
    state.visible = true;
    await prepareCurrentImage(state, ctx, { forceReload: true });
    syncWidget(ctx, state);
    ctx.ui?.notify?.(`${summarizeCurrent(state)} ${imageControlHint(state, { includeCount: true })}`, "info");
  }

  function hideCommand(ctx) {
    if (state.items.length === 0) {
      noImages(ctx);
      return;
    }
    state.lastDeleteCommand = buildScopedDeleteCommand(state);
    state.visible = false;
    stopAnimation(state);
    stopCycle(state);
    flashDeleteWidget(ctx, state, state.lastDeleteCommand);
    setTimeout(() => syncWidget(ctx, state), 120);
    ctx.ui?.notify?.(`Hid kitty preview. Use /image-show to restore ${state.items.length} ${pluralizeImages(state.items.length)}.`, "info");
  }

  function clearCommand(ctx) {
    if (state.items.length === 0) {
      noImages(ctx);
      return;
    }
    state.lastDeleteCommand = releaseOwnedImageData(state, { keepIds: [] });
    clearOwnedImageIds(state);
    state.visible = false;
    state.items = [];
    state.index = 0;
    state.currentCommand = undefined;
    stopAnimation(state);
    stopCycle(state);
    syncWidget(ctx, state);
    flashDeleteWidget(ctx, state, state.lastDeleteCommand);
    ctx.ui?.notify?.("Cleared kitty image preview.", "info");
  }

  function statusCommand(ctx) {
    syncWidget(ctx, state);
    const controls = imageControlHint(state, { includeCount: true });
    ctx.ui?.notify?.(`${summarizeCurrent(state)} Controls: ${controls}`, "info");
  }

  async function startCycleCommand(args, ctx) {
    if (state.items.length === 0) {
      noImages(ctx);
      return;
    }
    const arg = Array.isArray(args) ? args[0] : args;
    const seconds = clampInteger(arg, 5, 1, 3600);
    state.visible = true;
    await prepareCurrentImage(state, ctx, { forceReload: true });
    startCycle(state, ctx, { intervalMs: seconds * 1000, direction: 1, loop: true });
    syncWidget(ctx, state);
    ctx.ui?.notify?.(`Cycling kitty preview every ${seconds}s. Use /image-stop-cycle to stop.`, "info");
  }

  function stopCycleCommand(ctx) {
    stopCycle(state);
    syncWidget(ctx, state);
    ctx.ui?.notify?.("Stopped kitty preview cycle.", "info");
  }

  async function configCommand(args, ctx) {
    const tokens = tokenizeConfigArgs(args);
    if (tokens.length === 0) {
      ctx.ui?.notify?.(`image preview config: ${formatConfigSummary(state.config)}\n${configUsageHint()}`, "info");
      return;
    }
    let parsed;
    try {
      parsed = parseConfigPatch(tokens);
    } catch (error) {
      ctx.ui?.notify?.(`/image-config: ${error.message}`, "warning");
      return;
    }
    const changes = applyConfigPatch(state.config, parsed.patch);
    if (changes.length === 0) {
      ctx.ui?.notify?.(`image preview config unchanged: ${formatConfigSummary(state.config)}`, "info");
      return;
    }
    if (state.visible && state.items[state.index]) {
      await prepareCurrentImage(state, ctx, { forceReload: true });
    }
    syncWidget(ctx, state);
    const summary = changes.map((c) => `${c.key}: ${c.from === undefined ? "auto" : c.from} \u2192 ${c.to === undefined ? "auto" : c.to}`).join(", ");
    ctx.ui?.notify?.(`Updated image preview config — ${summary}.`, "info");
  }

  async function passthroughProbeCommand(ctx) {
    const mode = detectKittyPassthroughMode(process.env);
    const writers = enumerateGraphicsWriters(ctx);
    if (writers.length === 0) {
      ctx.ui?.notify?.("kitty passthrough probe: no terminal writer is reachable from this session (no ctx.ui.write / ui.terminal.write / terminal.write), so a raw kitty graphics escape cannot be emitted at all. That itself is the failure: the host exposes no output path for raw kitty sequences.", "warning");
      return;
    }
    const { entries } = buildPassthroughProbePlan({ writerNames: writers.map((w) => w.name), mode, env: process.env });
    const byName = new Map(entries.map((e) => [e.name, e]));
    const emitted = [];
    for (const w of writers) {
      const entry = byName.get(w.name);
      if (!entry) continue;
      try {
        w.write(entry.label);
        w.write(entry.command);
        w.write("\n");
        emitted.push(w.name);
      } catch (error) {
        ctx.ui?.notify?.(`kitty passthrough probe: write via ${w.name} failed: ${error.message}`, "warning");
      }
    }
    ctx.ui?.notify?.(`kitty passthrough probe: passthrough mode=${mode}; emitted a magenta test cell through ${emitted.length} path(s): ${emitted.join(", ") || "none"}. Whichever label shows a magenta cell is the working kitty output path; a blank cell or raw escape text means that path does not reach the kitty client.`, "info");
  }

  registerImageCommand(["kitty-image-preview", "image-status", "image-preview"],
    "Show kitty image preview extension status and quick usage.",
    async (_args, ctx) => statusCommand(ctx));

  registerImageCommand(["image-config"],
    "Show or update image preview render params at runtime (placement, placementMode, transferMode, passthrough, zIndex, columns, rows, maxRows, minRows, background, showCaption, clearPrevious). Call with no args to print current config.",
    configCommand);

  registerImageCommand(["image-next"],
    "Show the next image in the kitty multiviewer gallery.",
    async (_args, ctx) => navigateCommand(ctx, 1));

  registerImageCommand(["image-prev", "image-previous"],
    "Show the previous image in the kitty multiviewer gallery.",
    async (_args, ctx) => navigateCommand(ctx, -1));

  registerImageCommand(["image-first"],
    "Show the first image in the kitty multiviewer gallery.",
    async (_args, ctx) => {
      if (state.items.length === 0) return noImages(ctx);
      state.index = 0;
      return showCommand(ctx);
    });

  registerImageCommand(["image-last"],
    "Show the last image in the kitty multiviewer gallery.",
    async (_args, ctx) => {
      if (state.items.length === 0) return noImages(ctx);
      state.index = state.items.length - 1;
      return showCommand(ctx);
    });

  registerImageCommand(["image-show"],
    "Show or restore the current kitty image preview.",
    async (_args, ctx) => showCommand(ctx));

  registerImageCommand(["image-hide"],
    "Hide the kitty image preview without forgetting the loaded gallery.",
    async (_args, ctx) => hideCommand(ctx));

  registerImageCommand(["image-clear"],
    "Clear the kitty image preview gallery and delete its terminal placements.",
    async (_args, ctx) => clearCommand(ctx));

  registerImageCommand(["image-start-cycle", "image-cycle"],
    "Start cycling kitty multiviewer images. Optional argument: interval in seconds (default 5).",
    startCycleCommand);

  registerImageCommand(["image-stop-cycle"],
    "Stop the kitty multiviewer cycling timer.",
    async (_args, ctx) => stopCycleCommand(ctx));

  registerImageCommand(["image-passthrough-probe", "kitty-passthrough-probe"],
    "Emit a tiny kitty graphics test cell through each available terminal output path to diagnose which path reaches the kitty client (raw-placeholder / blank-pixel failures).",
    async (_args, ctx) => passthroughProbeCommand(ctx));
}
