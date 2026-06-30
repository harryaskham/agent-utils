// Image-preview widget render core, extracted from kitty-image-preview.js so it
// can be exercised headlessly without importing the command-registration path
// (which pulls in @sinclair/typebox via schema.js and @earendil-works/pi-ai). This
// is the "thin test seam" requested by bd-c75d9e: it lets a widget-level smoke
// drive KittyImagePreviewWidget.render twice and assert the bd-d6fa1b
// transmit-once / placement-only-on-repaint invariants at the widget boundary,
// not just on buildCurrentDisplayCommand. The module only depends on the
// schema-free preview submodules plus the kitty-graphics primitives, mirroring
// the bd-e1914a modularization of display-commands/status-line/etc.

import { clampInteger, renderPlaceholderLines, truncatePlainText } from "./text-utils.js";
import { previewViewportRowLimit, previewImageRowLimit, composePagedSidePanelLines } from "./layout.js";
import { DEFAULT_COLUMNS } from "./constants.js";
import { resolvePlacement, shouldRenderUnicodePlaceholders } from "./placement.js";
import { imageControlsLine, imageSeparatorLine, imageHeaderLine } from "./status-line.js";
import { buildCurrentDisplayCommand } from "./display-commands.js";
import {
  MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE,
  buildKittyUnicodePlaceholderLines,
  estimateRowsForImage,
} from "../kitty-graphics.js";

export function renderCurrentImageLines(state, current, {
  columns,
  rows,
  lineWidth = columns,
  useUnicodePlaceholders = false,
  leadingSpaces = 0,
  frame = false,
  prepared = undefined,
} = {}) {
  const command = buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders, prepared);
  const leftPadding = " ".repeat(Math.max(0, leadingSpaces));
  const commandPrefix = `${state.lastDeleteCommand || ""}${command}`;
  state.lastDeleteCommand = "";

  // Framed unicode mode renders: hline / name (n/max) / image / hline. The
  // caption lives on its own header line rather than being embedded into the
  // first placeholder row (bd-9b5b18). The transmit/display escape command still
  // rides on the very first emitted line so kitty receives it once. Only the
  // main inline widget frames; the side panel opts out to keep its tight
  // bottom-aligned geometry.
  if (useUnicodePlaceholders && frame) {
    const imageLines = buildKittyUnicodePlaceholderLines({
      imageId: current.id,
      placementId: state.config.placementId,
      columns,
      rows,
      width: lineWidth,
    });
    const framed = [imageSeparatorLine(lineWidth)];
    if (state.config.showCaption) framed.push(imageHeaderLine(state, lineWidth));
    framed.push(...imageLines, imageSeparatorLine(lineWidth));
    return framed.map((line, index) => `${leftPadding}${index === 0 ? commandPrefix : ""}${line}`);
  }

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
  return imageLines.map((line, index) => `${leftPadding}${index === 0 ? commandPrefix : ""}${line}`);
}

// Side-panel name header for one packed page entry: "n/total label", padded to
// the panel width so the column stays rectangular (Part C-wire, bd-502d6a).
// Pure over its arguments plus state.items.length.
export function sidePanelEntryHeaderLine(state, entry, width) {
  const cols = Math.max(0, Math.trunc(Number(width) || 0));
  if (cols <= 0) return "";
  const total = Array.isArray(state?.items) ? state.items.length : 0;
  const counter = `${Math.trunc(entry?.index ?? 0) + 1}/${total}`;
  const label = entry?.label ? `${counter} ${entry.label}` : counter;
  return truncatePlainText(label, cols).padEnd(cols);
}

// Assemble the multi-image side-panel lines for one packed page (Part C-wire,
// bd-502d6a). Reuses renderCurrentImageLines per packed-page entry so the
// bd-d6fa1b transmit-once / placement-only-on-repaint invariant holds per image
// id, and composes the per-entry name header + image block with
// composePagedSidePanelLines (header at the entry's startRow, image rows below,
// blank-filled, bottom-aligned). `preparedById` supplies each entry's prepared
// payload (the per-entry analogue of state.currentCommand); an entry with no
// prepared payload falls back to state.currentCommand and therefore emits only
// its placeholder cells (empty transmit prefix) until the live wiring prepares
// page payloads before render. The actual escape/transmit emission lives in the
// injected render seam, so this is unit-testable headlessly like the widget.
export function renderSidePanelPageLines(state, {
  page,
  rows,
  totalWidth,
  imageWidth,
  padding = 0,
  useUnicodePlaceholders = false,
  preparedById,
  bottomAlign = true,
} = {}) {
  const rowCount = Math.max(0, Math.trunc(Number(rows) || 0));
  if (rowCount <= 0 || !page) return [];
  const panelWidth = Math.max(0, Math.trunc(Number(totalWidth) || 0));
  const lineWidth = Math.max(1, Math.trunc(Number(imageWidth) || 1));
  const leadingSpaces = Math.max(0, Math.trunc(Number(padding) || 0));
  return composePagedSidePanelLines(page, {
    rows: rowCount,
    totalWidth: panelWidth,
    bottomAlign,
    renderHeaderLines: (entry) => [sidePanelEntryHeaderLine(state, entry, panelWidth)],
    renderImageLines: (entry) => renderCurrentImageLines(state, entry.item, {
      columns: Math.max(1, Math.trunc(entry?.imageWidth || lineWidth)),
      rows: Math.max(1, Math.trunc(entry?.imageRows || 1)),
      lineWidth,
      useUnicodePlaceholders,
      leadingSpaces,
      prepared: preparedById?.get?.(entry?.item?.id),
    }),
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
    const controls = imageControlsLine(state, availableWidth);
    const protocolMax = useUnicodePlaceholders ? MAX_KITTY_PLACEHOLDER_DIACRITIC_VALUE + 1 : 200;
    // Unicode framing reserves two hline rows plus an optional header row; the
    // legacy placeholder path reserves one controls row.
    const reservedRows = useUnicodePlaceholders
      ? 2 + (state.config.showCaption ? 1 : 0)
      : (controls ? 1 : 0);
    const rowLimit = previewImageRowLimit({ reservedRows, protocolMax });
    let rows = clampInteger(
      state.config.rows || estimateRowsForImage({
        imageWidth: current.width,
        imageHeight: current.height,
        columns,
        maxRows: Math.min(state.config.maxRows, rowLimit),
        minRows: Math.min(state.config.minRows, rowLimit),
      }),
      12,
      1,
      rowLimit,
    );

    // Streams repaint frequently. When the inline widget fallback is in use,
    // changing the widget row count is the scrollback-yanking path: Pi must
    // reserve a different number of terminal rows and the viewport jumps to the
    // live bottom. Lock the image row count on the first stream render and reuse
    // it for subsequent frames (bounded by the current protocol/viewport limit)
    // so frame dimension changes update in place instead of re-reserving rows.
    if (state.stream?.running) {
      if (!Number.isFinite(state.stream.lockedImageRows)) state.stream.lockedImageRows = rows;
      rows = clampInteger(state.stream.lockedImageRows, rows, 1, rowLimit);
    }

    const lines = renderCurrentImageLines(state, current, {
      columns,
      rows,
      lineWidth: availableWidth,
      useUnicodePlaceholders,
      frame: useUnicodePlaceholders,
    });
    // Unicode mode is self-framed (hline / name / image / hline) and omits the
    // separate controls footer; the status line still advertises the controls.
    if (useUnicodePlaceholders) return lines;
    const widgetRowLimit = previewViewportRowLimit();
    return controls && (widgetRowLimit === undefined || lines.length < widgetRowLimit) ? [...lines, controls] : lines;
  }

  invalidate() {}
}
