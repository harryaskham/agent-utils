import { copyFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { complete, StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";

import {
  MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE,
  buildDeleteCommand,
  buildKittyUnicodePlaceholderLines,
  buildPngDisplayCommand,
  buildPngVirtualPlacementCommand,
  detectKittyPassthroughMode,
  estimateRowsForImage,
  fileToBase64,
  isSupportedKittyPngPath,
  readPngDimensions,
  shouldUseInMemoryTransfer,
  shouldUseUnicodePlaceholders,
  stableKittyImageId,
} from "./kitty-graphics.js";

const TOOL_PREFIX = "kitty_image_preview";
const WIDGET_ID = "kitty-image-preview";
const AUTO_PLACEMENT = "auto";
const SIDE_OVERLAY_PLACEMENT = "rightOverlay";
const DEFAULT_Z_INDEX = -10;
const DEFAULT_BG_Z_INDEX = -1073741824;
const DEFAULT_COLUMNS = 48;
const DEFAULT_MAX_ROWS = 24;
const DEFAULT_STREAM_INTERVAL_MS = 1000;
const DEFAULT_DESCRIBE_INTERVAL_SECONDS = 30;
const DEFAULT_DESCRIBE_MODEL = "litellm-anthropic/claude-opus-4-7";
const SIDE_PANEL_LAYOUT_SYMBOL = Symbol.for("agent-utils.kittyImagePreview.sidePanelLayout");
const SIDE_PANEL_MAX_WIDTH_RATIO = 0.5;
const SIDE_PANEL_LEFT_PADDING = 2;
const AUTO_SIDE_MIN_COLUMNS = 100;
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
const WIDGET_PLACEMENTS = ["aboveEditor", "belowEditor"];
const PREVIEW_PLACEMENTS = [AUTO_PLACEMENT, ...WIDGET_PLACEMENTS, SIDE_OVERLAY_PLACEMENT];

function stringEnum(values, description) {
  return StringEnum(values, { description });
}

function normalizeMaybeAtPath(input) {
  if (typeof input !== "string") return input;
  return input.startsWith("@") ? input.slice(1) : input;
}

function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

function resolveUserPath(cwd, inputPath) {
  const normalized = expandHome(normalizeMaybeAtPath(inputPath));
  return path.resolve(cwd, normalized);
}

function relativeLabel(cwd, absolutePath) {
  const relative = path.relative(cwd, absolutePath);
  return relative && !relative.startsWith("..") ? relative : absolutePath;
}

function sanitizeFilenamePart(value) {
  return String(value || "item")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function serializePublicState(state) {
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
  };
}

function restorePublicState(state, details) {
  const snapshot = details?.kittyImagePreviewState;
  if (!snapshot || !Array.isArray(snapshot.items)) return;
  state.visible = Boolean(snapshot.visible);
  state.index = clampInteger(snapshot.index, 0, 0, Math.max(0, snapshot.items.length - 1));
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
}

function summarizeCurrent(state) {
  const current = state.items[state.index];
  if (!current) return "No image is loaded.";
  const dims = current.width && current.height ? ` (${current.width}×${current.height})` : "";
  const mode = state.config.transferMode === "auto" ? "auto" : state.config.transferMode;
  return `Showing ${state.index + 1}/${state.items.length}: ${current.label}${dims}; placement=${state.config.placement}, transfer=${mode}, graphicsPlacement=${state.config.placementMode}, z=${state.config.zIndex}.`;
}

function renderPlaceholderLines(width, rows, text) {
  const line = " ".repeat(Math.max(1, width));
  const output = Array.from({ length: Math.max(1, rows) }, () => line);
  if (text) output[0] = `${text}${line}`.slice(0, Math.max(1, width));
  return output;
}

function renderCurrentImageLines(state, current, {
  columns,
  rows,
  lineWidth = columns,
  useUnicodePlaceholders = false,
  leadingSpaces = 0,
} = {}) {
  const command = buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders);
  const label = state.config.showCaption
    ? `kitty image ${state.index + 1}/${state.items.length}: ${current.label}`
    : "";
  const imageLines = useUnicodePlaceholders
    ? buildKittyUnicodePlaceholderLines({
      imageId: current.id,
      placementId: state.config.placementId,
      columns,
      rows,
      width: lineWidth,
      caption: label,
    })
    : renderPlaceholderLines(lineWidth, rows, label);
  const leftPadding = " ".repeat(Math.max(0, leadingSpaces));
  const commandPrefix = `${state.lastDeleteCommand || ""}${command}`;
  state.lastDeleteCommand = "";
  return imageLines.map((line, index) => `${leftPadding}${index === 0 ? commandPrefix : ""}${line}`);
}

export function isSideOverlayPlacement(placement) {
  return placement === SIDE_OVERLAY_PLACEMENT;
}

function shouldRenderUnicodePlaceholders(state, options = {}) {
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

export class KittyImagePreviewWidget {
  constructor(state, options = {}) {
    this.state = state;
    this.options = options;
  }

  render(width) {
    const state = this.state;
    if (!state.visible || state.items.length === 0) return [];
    const current = state.items[state.index];
    const availableWidth = Math.max(1, Math.trunc(width || 1));
    const columns = Math.min(availableWidth, clampInteger(state.config.columns, DEFAULT_COLUMNS, 1, 4096));
    const useUnicodePlaceholders = shouldRenderUnicodePlaceholders(state, {
      ...this.options,
      placement: this.options.placement ?? resolvePlacement(state),
    });
    const rows = clampInteger(
      state.config.rows || estimateRowsForImage({
        imageWidth: current.width,
        imageHeight: current.height,
        columns,
        maxRows: state.config.maxRows,
        minRows: state.config.minRows,
      }),
      12,
      1,
      useUnicodePlaceholders ? MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1 : 200,
    );

    return renderCurrentImageLines(state, current, {
      columns,
      rows,
      lineWidth: availableWidth,
      useUnicodePlaceholders,
    });
  }

  invalidate() {}
}

function sideOverlayWidth(state) {
  return clampInteger(state.config.columns, DEFAULT_COLUMNS, 1, 4096);
}

function sideOverlayMaxHeight(state) {
  return clampInteger(state.config.rows || state.config.maxRows, DEFAULT_MAX_ROWS, 1, MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1);
}

function configuredPassthroughMode(state) {
  return state.config.passthrough === "auto" ? detectKittyPassthroughMode(process.env) : state.config.passthrough;
}

function shouldUseInlineRightPlacement(state) {
  return configuredPassthroughMode(state) === "tmux";
}

function currentTerminalColumns() {
  const columns = Number(process.stdout?.columns ?? process.env.COLUMNS);
  return Number.isFinite(columns) && columns > 0 ? Math.trunc(columns) : undefined;
}

function shouldAutoUseSidePanel(state) {
  if (shouldUseInlineRightPlacement(state)) return false;
  const columns = currentTerminalColumns();
  return columns === undefined || columns >= AUTO_SIDE_MIN_COLUMNS;
}

function resolvePlacement(state) {
  if (state.config.placement !== AUTO_PLACEMENT) return state.config.placement;
  return shouldAutoUseSidePanel(state) ? SIDE_OVERLAY_PLACEMENT : "aboveEditor";
}

function estimatedRowsForColumns(item, columns) {
  const columnCount = Math.max(1, Math.trunc(columns || 1));
  if (!item?.width || !item?.height) return Math.max(1, Math.ceil(columnCount * 0.5));
  return estimateRowsForImage({
    imageWidth: item.width,
    imageHeight: item.height,
    columns: columnCount,
    maxRows: MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1,
    minRows: 1,
  });
}

function fitImageColumnsForRows(item, maxColumns, maxRows) {
  const columnLimit = Math.max(1, Math.trunc(maxColumns || 1));
  const rowLimit = Math.max(1, Math.trunc(maxRows || 1));
  let low = 1;
  let high = columnLimit;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (estimatedRowsForColumns(item, mid) <= rowLimit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function buildSidePanelLayout(state, terminalWidth, availableRows = DEFAULT_MAX_ROWS) {
  const width = Math.max(1, Math.trunc(terminalWidth || 1));
  // Keep at least one text column. On absurdly narrow terminals, disable the
  // side rail rather than generating lines wider than the terminal.
  const maxTotalWidth = Math.max(0, Math.min(Math.floor(width * SIDE_PANEL_MAX_WIDTH_RATIO), width - 1));
  const rowLimit = Math.max(0, Math.trunc(availableRows || 0));
  if (maxTotalWidth < 1 || rowLimit < 1) {
    return { mainWidth: width, imageWidth: 0, imageRows: 0, padding: 0, totalWidth: 0 };
  }
  const maxRows = Math.min(
    state.config.rows === undefined ? rowLimit : clampInteger(state.config.rows, rowLimit, 1, rowLimit),
    MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1,
  );
  if (maxRows < 1) {
    return { mainWidth: width, imageWidth: 0, imageRows: 0, padding: 0, totalWidth: 0 };
  }
  const padding = Math.min(SIDE_PANEL_LEFT_PADDING, Math.max(0, maxTotalWidth - 1));
  const maxImageWidth = Math.max(1, maxTotalWidth - padding);
  const current = state.items[state.index];
  const imageWidth = fitImageColumnsForRows(current, maxImageWidth, maxRows);
  const imageRows = Math.min(maxRows, estimatedRowsForColumns(current, imageWidth));
  const totalWidth = Math.min(maxTotalWidth, imageWidth + padding);
  return {
    mainWidth: Math.max(1, width - totalWidth),
    imageWidth,
    imageRows,
    padding: Math.max(0, totalWidth - imageWidth),
    totalWidth,
  };
}

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

function componentContains(root, target, seen = new Set()) {
  if (!root || !target || seen.has(root)) return false;
  if (root === target) return true;
  seen.add(root);
  if (!Array.isArray(root.children)) return false;
  return root.children.some((child) => componentContains(child, target, seen));
}

function findEditorBoundaryIndex(tui) {
  const children = Array.isArray(tui?.children) ? tui.children : [];
  const focusedIndex = children.findIndex((child) => componentContains(child, tui.focusedComponent));
  if (focusedIndex >= 0) return focusedIndex;
  // Pi's interactive layout ends with editorContainer, widgetBelow, footer.
  return Math.max(0, children.length - 3);
}

function renderChildren(children, width) {
  const lines = [];
  for (const child of children) lines.push(...child.render(width));
  return lines;
}

function renderSidePanelImageLines(state, rows, layout) {
  const current = state.items[state.index];
  const blank = " ".repeat(layout.totalWidth);
  if (!current || rows <= 0) return [];
  // Side-panel rendering must not use direct cursor placement. Direct kitty
  // placement can move the terminal cursor while Pi is doing differential
  // redraws, which pushes full-screen copies into scrollback on every update
  // and is especially bad during animation. Virtual placement + Unicode
  // placeholders anchors the image to these cells without scrolling.
  const useUnicodePlaceholders = shouldRenderUnicodePlaceholders(state, {
    forceUnicodePlaceholders: true,
    forceSideOverlay: false,
  });
  const maxRows = useUnicodePlaceholders ? MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1 : 200;
  const imageRows = Math.max(1, Math.min(rows, layout.imageRows || rows, maxRows));
  const imageLines = renderCurrentImageLines(state, current, {
    columns: layout.imageWidth,
    rows: imageRows,
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

function renderTuiWithSidePanel(tui, originalRender, width, state) {
  const placement = resolvePlacement(state);
  if (!state.visible || state.items.length === 0 || !isSideOverlayPlacement(placement) || shouldUseInlineRightPlacement(state)) {
    return originalRender.call(tui, width);
  }
  const terminalWidth = Math.max(1, Math.trunc(width || tui?.terminal?.columns || 1));
  const terminalHeight = Math.max(1, Math.trunc(tui?.terminal?.rows || 1));
  const children = Array.isArray(tui.children) ? tui.children : [];
  const editorBoundary = findEditorBoundaryIndex(tui);
  const bottomLines = renderChildren(children.slice(editorBoundary), terminalWidth);
  const bottomVisibleRows = Math.min(bottomLines.length, Math.max(0, terminalHeight - 1));
  const panelRows = Math.max(0, terminalHeight - bottomVisibleRows);
  if (panelRows <= 0) return originalRender.call(tui, width);

  let layout = buildSidePanelLayout(state, terminalWidth, panelRows);
  if (layout.totalWidth < 1 || layout.imageRows < 1) return originalRender.call(tui, width);
  let topLines = renderChildren(children.slice(0, editorBoundary), layout.mainWidth);
  let combined = [];
  let visiblePanelRows = 0;
  let panelStart = 0;

  const calculateVisiblePanel = () => {
    combined = [
      ...topLines.map((line) => `${line}\x1b[${layout.mainWidth + 1}G${" ".repeat(layout.totalWidth)}`),
      ...bottomLines,
    ];
    const viewportTop = Math.max(0, combined.length - terminalHeight);
    panelStart = Math.min(topLines.length, viewportTop);
    const panelEnd = Math.min(topLines.length, panelStart + panelRows);
    visiblePanelRows = Math.max(0, panelEnd - panelStart);
  };

  calculateVisiblePanel();
  if (visiblePanelRows === 0) return combined;

  const refinedLayout = buildSidePanelLayout(state, terminalWidth, visiblePanelRows);
  if (refinedLayout.totalWidth >= 1 && refinedLayout.imageRows >= 1 && (
    refinedLayout.mainWidth !== layout.mainWidth || refinedLayout.imageRows !== layout.imageRows
  )) {
    layout = refinedLayout;
    topLines = renderChildren(children.slice(0, editorBoundary), layout.mainWidth);
    calculateVisiblePanel();
    if (visiblePanelRows === 0) return combined;
  }

  const moveToPanel = `\x1b[${layout.mainWidth + 1}G`;
  const blankPanel = " ".repeat(layout.totalWidth);
  const panelLines = renderSidePanelImageLines(state, visiblePanelRows, layout);
  for (let index = 0; index < visiblePanelRows; index += 1) {
    const lineIndex = panelStart + index;
    combined[lineIndex] = `${topLines[lineIndex]}${moveToPanel}${panelLines[index] ?? blankPanel}`;
  }
  return combined;
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
      overlay.component = new KittyImagePreviewWidget(state, { forceUnicodePlaceholders: true });
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
  if (!state.visible || state.items.length === 0) {
    ctx.ui.setWidget(WIDGET_ID, undefined);
    clearSidePresentation(state);
    ctx.ui.setStatus(WIDGET_ID, undefined);
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
  const animation = state.animation?.running ? " ▶" : "";
  ctx.ui.setStatus(WIDGET_ID, `🖼${animation} ${state.index + 1}/${state.items.length} ${current?.label ?? ""}`);
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

function stopAnimation(state) {
  if (state.animationTimer) clearInterval(state.animationTimer);
  state.animationTimer = undefined;
  state.animation = { running: false };
}

function startAnimation(state, ctx, { intervalMs = 250, loop = true } = {}) {
  stopAnimation(state);
  state.animation = { running: true, intervalMs, loop };
  state.animationTimer = setInterval(() => {
    if (!state.visible || state.items.length === 0) {
      stopAnimation(state);
      syncWidget(ctx, state);
      return;
    }
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
    prepareCurrentImage(state, ctx, { forceReload: true }).catch((error) => {
      stopAnimation(state);
      ctx?.ui?.notify?.(`kitty image animation stopped: ${error.message}`, "warning");
    });
  }, Math.max(50, intervalMs));
}

function buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders = false) {
  const prepared = state.currentCommand;
  if (!prepared || prepared.itemId !== current.id) return "";
  const placementMode = useUnicodePlaceholders ? "unicode" : "cursor";
  const signature = `${columns}:${rows}:${prepared.zIndex}:${prepared.transport}:${prepared.passthrough}:${prepared.chunkSize}:${placementMode}:${state.config.placementId}`;
  if (prepared.rendered?.signature === signature) return prepared.rendered.command;
  const command = useUnicodePlaceholders
    ? buildPngVirtualPlacementCommand({
      imageId: current.id,
      placementId: state.config.placementId,
      pngBase64: prepared.pngBase64,
      filePath: prepared.filePath,
      columns,
      rows,
      passthrough: prepared.passthrough,
      chunkSize: prepared.chunkSize,
    })
    : buildPngDisplayCommand({
      imageId: current.id,
      placementId: state.config.placementId,
      pngBase64: prepared.pngBase64,
      filePath: prepared.filePath,
      columns,
      rows,
      zIndex: prepared.zIndex,
      passthrough: prepared.passthrough,
      chunkSize: prepared.chunkSize,
    });
  prepared.rendered = { signature, command };
  return command;
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
  state.lastDeleteCommand = state.config.clearPrevious
    ? buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough })
    : "";
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
  return {
    id: stableKittyImageId(`${absolutePath}:${info.mtimeMs}:${info.size}`),
    path: absolutePath,
    label: label || relativeLabel(cwd, absolutePath),
    mediaType: "image/png",
    width: dimensions?.width,
    height: dimensions?.height,
    addedAt: Date.now(),
  };
}

function applyConfig(state, config = {}) {
  if (!config || typeof config !== "object") return;
  if (config.columns !== undefined) state.config.columns = clampInteger(config.columns, state.config.columns, 1, 4096);
  if (config.rows !== undefined) state.config.rows = clampInteger(config.rows, state.config.rows, 1, 200);
  if (config.maxRows !== undefined) state.config.maxRows = clampInteger(config.maxRows, state.config.maxRows, 1, 200);
  if (config.minRows !== undefined) state.config.minRows = clampInteger(config.minRows, state.config.minRows, 1, 200);
  if (config.zIndex !== undefined) state.config.zIndex = clampInteger(config.zIndex, state.config.zIndex, -2147483648, 2147483647);
  if (typeof config.background === "boolean") state.config.background = config.background;
  if (typeof config.showCaption === "boolean") state.config.showCaption = config.showCaption;
  if (typeof config.clearPrevious === "boolean") state.config.clearPrevious = config.clearPrevious;
  if (PREVIEW_PLACEMENTS.includes(config.placement)) state.config.placement = config.placement;
  if (["auto", "memory", "file"].includes(config.transferMode)) state.config.transferMode = config.transferMode;
  if (["auto", "tmux", "none"].includes(config.passthrough)) state.config.passthrough = config.passthrough;
  if (["auto", "unicode", "cursor"].includes(config.placementMode)) state.config.placementMode = config.placementMode;
  if (config.placementId !== undefined) state.config.placementId = clampInteger(config.placementId, state.config.placementId, 1, 2147483647);
  if (config.chunkSize !== undefined) state.config.chunkSize = clampInteger(config.chunkSize, state.config.chunkSize, 512, 65536);
  state.currentCommand = undefined;
}

function makeDetails(state, extra = {}) {
  return {
    ...extra,
    kittyImagePreviewState: serializePublicState(state),
  };
}

function makeContent(state, extraLines = []) {
  return [{ type: "text", text: [summarizeCurrent(state), ...extraLines].filter(Boolean).join("\n") }];
}

function describeParameterSchema() {
  return {
    describe: Type.Optional(Type.Boolean({ description: "Send this still image to a vision model and include an objective visual description in the tool result. Defaults to false." })),
    describeModel: Type.Optional(Type.String({ description: `Vision model as provider/model. Defaults to KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL or ${DEFAULT_DESCRIBE_MODEL}.` })),
    describePrompt: Type.Optional(Type.String({ description: "Optional extra instruction appended to the default objective image-description prompt." })),
    describeMaxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens for image description. Defaults to 1200." })),
  };
}

function streamDescribeParameterSchema() {
  return {
    describe: Type.Optional(Type.Boolean({ description: "Describe the first stream frame with a vision model. Defaults to false unless describeIntervalSecs is set." })),
    describeIntervalSecs: Type.Optional(Type.Number({ description: "If set, describe the first stream frame and then the next completed frame after each interval. Descriptions are status metadata only, not image attachments." })),
    describeModel: Type.Optional(Type.String({ description: `Vision model as provider/model. Defaults to KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL or ${DEFAULT_DESCRIBE_MODEL}.` })),
    describePrompt: Type.Optional(Type.String({ description: "Optional extra instruction appended to the default objective image-description prompt." })),
    describeMaxTokens: Type.Optional(Type.Number({ description: "Maximum output tokens for stream frame descriptions. Defaults to 1200." })),
  };
}

function parseModelSpec(spec) {
  if (!spec) return undefined;
  const slash = String(spec).indexOf("/");
  if (slash <= 0 || slash === String(spec).length - 1) throw new Error(`Vision model must be provider/model, got: ${spec}`);
  return { provider: String(spec).slice(0, slash), modelId: String(spec).slice(slash + 1) };
}

function resolveVisionModel(ctx, params = {}) {
  const spec = parseModelSpec(params.describeModel || process.env.KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL);
  const model = spec ? ctx.modelRegistry?.find?.(spec.provider, spec.modelId) : ctx.model;
  if (!model) {
    throw new Error(`Vision model ${params.describeModel || process.env.KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL} is not registered. Pass describeModel as provider/model.`);
  }
  if (Array.isArray(model.input) && !model.input.includes("image")) {
    throw new Error(`Model ${model.provider}/${model.id} does not advertise image input support. Pass describeModel with an image-capable model.`);
  }
  return model;
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

function fullResolutionDescribeParams(params = {}) {
  const full = { ...params };
  delete full.maxWidth;
  delete full.maxHeight;
  return full;
}

function parseJsonEnvelope(stdout, commandName) {
  const trimmed = String(stdout || "").trim();
  if (!trimmed) throw new Error(`${commandName} returned no JSON output`);
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error(`${commandName} returned invalid JSON: ${error.message}`);
  }
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

function targetText(target) {
  return [target.title, target.name, target.app_name, target.id].filter(Boolean).join(" ").toLowerCase();
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

function getSessionScreenshotDir(ctx, outputDir) {
  if (outputDir) return resolveUserPath(ctx.cwd, outputDir);
  if (process.env.KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR) {
    return resolveUserPath(ctx.cwd, process.env.KITTY_IMAGE_PREVIEW_SCREENSHOT_DIR);
  }
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (sessionFile) {
    const sessionId = sanitizeFilenamePart(path.basename(sessionFile).replace(/\.jsonl?$/i, ""));
    return path.join(path.dirname(sessionFile), "kitty-image-preview-screenshots", sessionId);
  }
  return path.join(os.tmpdir(), "pi-kitty-image-preview", `pid-${process.pid}`);
}

function buildScreenshotOutputPath(ctx, params, target, date = new Date()) {
  const dir = getSessionScreenshotDir(ctx, params.outputDir);
  const filename = params.filename
    ? sanitizeFilenamePart(params.filename.replace(/\.png$/i, ""))
    : `${timestampForFilename(date)}-${sanitizeFilenamePart(target.kind)}-${sanitizeFilenamePart(target.id)}`;
  return {
    dir,
    path: path.join(dir, `${filename}.png`),
  };
}

function buildTendrilCaptureArgs(params, target, outputPath) {
  const args = [
    "capture",
    "--json",
    "--format",
    "png",
    "--output",
    outputPath,
    "--timeout-ms",
    String(clampInteger(params.timeoutMs, 30_000, 1_000, 120_000)),
    target.kind === "window" ? "--window" : "--display",
    String(target.id),
  ];
  if (params.maxWidth !== undefined) args.push("--max-width", String(clampInteger(params.maxWidth, 0, 1, 100_000)));
  if (params.maxHeight !== undefined) args.push("--max-height", String(clampInteger(params.maxHeight, 0, 1, 100_000)));
  if (params.compression !== undefined) args.push("--compression", String(params.compression));
  return args;
}

function defaultScreenshotLabel(target, date = new Date()) {
  const name = target.title || target.name || target.app_name || target.id;
  return `screenshot ${target.kind} ${name} ${date.toLocaleTimeString()}`;
}

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

function sessionTempId(ctx) {
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return sessionFile
    ? sanitizeFilenamePart(path.basename(sessionFile).replace(/\.jsonl?$/i, ""))
    : `pid-${process.pid}`;
}

function getStreamDir(ctx) {
  return path.join(os.tmpdir(), "pi-kitty-image-preview-stream", sessionTempId(ctx));
}

function getDescribeTempDir(ctx) {
  return path.join(os.tmpdir(), "pi-kitty-image-preview-describe", sessionTempId(ctx));
}

async function unlinkIfExists(filePath) {
  if (!filePath) return;
  await unlink(filePath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function cleanupStreamFiles(stream) {
  if (!stream) return;
  await Promise.all([stream.framePaths?.[0], stream.framePaths?.[1]].filter(Boolean).map((file) => unlinkIfExists(file)));
}

function streamStatusLine(stream) {
  if (!stream?.running) return "No kitty image preview stream is running.";
  const elapsedSeconds = Math.max(0.001, (Date.now() - stream.startedAt) / 1000);
  const fps = stream.frameCount / elapsedSeconds;
  return `Streaming ${stream.target.kind} ${stream.target.id}: frames=${stream.frameCount} fps=${fps.toFixed(2)} interval=${stream.intervalMs}ms latest=${stream.latestPath || "none"}`;
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
  describeTendrilTargetFullResolution(pi, stream.target, ctx, params, signal, undefined, item)
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

async function captureStreamFrame(pi, ctx, state, stream) {
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
    state.items = [item];
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

function scheduleNextStreamFrame(pi, ctx, state, stream) {
  if (!stream?.running) return;
  stream.timer = setTimeout(async () => {
    await captureStreamFrame(pi, ctx, state, stream);
    scheduleNextStreamFrame(pi, ctx, state, stream);
  }, stream.intervalMs);
}

async function stopStream(state, { cleanup = false } = {}) {
  const stream = state.stream;
  if (!stream) return undefined;
  state.stream = undefined;
  stream.running = false;
  if (stream.timer) clearTimeout(stream.timer);
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
    stream: undefined,
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
      placementId: stableKittyImageId("agent-utils-kitty-image-preview-placement"),
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
    if (state.visible && state.items[state.index]) {
      await prepareCurrentImage(state, ctx).catch((error) => {
        if (ctx.hasUI) ctx.ui.notify(`kitty image preview restore failed: ${error.message}`, "warning");
      });
      syncWidget(ctx, state);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAnimation(state);
    void stopStream(state, { cleanup: true });
    state.visible = false;
    if (ctx?.hasUI) {
      flashDeleteWidget(ctx, state, buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough }));
      ctx.ui.setStatus(WIDGET_ID, undefined);
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
      state.items.push(item);
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
        state.items = [];
      }
      state.items.push(item);
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
      state.items.push(...items);
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
        state.lastDeleteCommand = buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough });
        state.visible = false;
        state.items = [];
        state.index = 0;
        state.currentCommand = undefined;
        syncWidget(ctx, state);
        stopAnimation(state);
        flashDeleteWidget(ctx, state, state.lastDeleteCommand);
        return { content: [{ type: "text", text: "Cleared kitty image preview." }], details: makeDetails(state) };
      }
      if (params.action === "hide") {
        state.lastDeleteCommand = buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough });
        state.visible = false;
        stopAnimation(state);
        flashDeleteWidget(ctx, state, state.lastDeleteCommand);
        return { content: [{ type: "text", text: "Hid kitty image preview." }], details: makeDetails(state) };
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
        target,
        params: { ...params, timeoutMs: clampInteger(params.timeoutMs, 30_000, 1_000, 120_000) },
        dir,
        framePaths: [path.join(dir, "frame-a.png"), path.join(dir, "frame-b.png")],
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
      await captureStreamFrame(pi, ctx, state, stream);
      scheduleNextStreamFrame(pi, ctx, state, stream);
      return {
        content: makeContent(state, [streamStatusLine(stream), "Frames use a two-file temp buffer and are not appended to session context."]),
        details: makeDetails(state, { stream: { target, dir, intervalMs: stream.intervalMs, latestPath: stream.latestPath } }),
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
        flashDeleteWidget(ctx, state, buildDeleteCommand({ deleteMode: "A", passthrough: state.config.passthrough }));
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
        state.items.push(item);
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

  pi.registerTool({
    name: "kitty_image_preview_status",
    label: "Kitty Image Preview Status",
    description: "Report the current kitty image preview state, terminal passthrough detection, and loaded image list.",
    promptSnippet: "Inspect current kitty image preview state and loaded image list.",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = serializePublicState(state);
      const lines = [
        summarizeCurrent(state),
        `visible=${state.visible} images=${state.items.length} passthroughDetected=${detectKittyPassthroughMode(process.env)} memoryAuto=${shouldUseInMemoryTransfer(process.env)}`,
        ...state.items.map((item, index) => `${index === state.index ? "→" : " "} ${index}: ${item.label}`),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { kittyImagePreviewState: snapshot },
      };
    },
  });

  pi.registerCommand("kitty-image-preview", {
    description: "Show kitty image preview extension status and quick usage.",
    handler: async (_args, ctx) => {
      syncWidget(ctx, state);
      ctx.ui.notify(summarizeCurrent(state), "info");
    },
  });
}
