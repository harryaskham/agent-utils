#!/usr/bin/env node
// Runnable multi-image side-panel render smoke (bd-d433ca).
//
// Drives the LANDED paged side-panel render path for the image-preview sidebar
// (bd-502d6a):
//
//   packImagesIntoPages -> renderSidePanelPageLines
//     -> composePagedSidePanelLines + per-entry renderCurrentImageLines
//
// for a synthetic multi-image preview state, and validates the emitted kitty
// escape stream structurally with the bd-3623f7 render harness — transmit-once
// per image id, distinct ids once per page, no orphan placeholders — WITHOUT a
// live kitty terminal. This closes the dev loop that kept render iterations
// stuck waiting for a release + repin (the running Pi session loads the pinned
// package, not the checkout).
//
// It imports the schema-free preview submodules only (no schema.js/pi-ai), like
// the bd-c75d9e widget smoke, so it runs on any host.
//
// Usage:
//   node scripts/kitty-image-preview-multi-image-render-smoke.mjs
//     [--images N] [--width COLS] [--rows ROWS] [--passthrough none|tmux]
//     [--emit PATH]
//
//   --emit PATH writes the raw escape stream (page 0, first paint) to PATH so it
//   can be catted into a real kitty terminal for visual confirmation, e.g.
//   `--passthrough none --emit /tmp/page0.kitty` then `cat /tmp/page0.kitty` in
//   a kitty/Ghostty window.
//
// Exits non-zero on any structural violation.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

import { stableKittyImageId } from "../extensions/kitty-graphics.js";
import { packImagesIntoPages } from "../extensions/kitty-image-preview/layout.js";
import { renderSidePanelPageLines } from "../extensions/kitty-image-preview/widget.js";
import {
  parseRenderedImageOutput,
  assertTransmitOncePerImageId,
  assertDistinctImageIdsOncePerRender,
  assertNoOrphanPlaceholders,
} from "../extensions/kitty-image-preview/render-harness.js";

// Small syntactically valid base64 PNG. The command builders embed these bytes
// into the escape stream without decoding them, so any non-empty base64 payload
// exercises the transmit/placeholder path.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// A spread of aspect ratios so packing produces real width-fit/height-bound
// variety (tall, wide, square) and, with a small row budget, multiple pages.
const SHAPES = [
  { w: 64, h: 64 },
  { w: 128, h: 48 },
  { w: 48, h: 160 },
  { w: 96, h: 72 },
  { w: 200, h: 60 },
  { w: 60, h: 200 },
];

function parseArgs(argv) {
  const args = { images: 4, width: 24, rows: 40, passthrough: "none", emit: undefined };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--images") args.images = Math.max(1, Math.trunc(Number(next()) || 1));
    else if (arg === "--width") args.width = Math.max(1, Math.trunc(Number(next()) || 1));
    else if (arg === "--rows") args.rows = Math.max(1, Math.trunc(Number(next()) || 1));
    else if (arg === "--passthrough") args.passthrough = String(next() || "none");
    else if (arg === "--emit") args.emit = String(next() || "");
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function makeItems(count) {
  return Array.from({ length: count }, (_unused, index) => {
    const shape = SHAPES[index % SHAPES.length];
    const id = stableKittyImageId(`agent-utils-multi-image-render-smoke-${index}`);
    return { id, label: `image-${index}`, width: shape.w, height: shape.h, path: `/tmp/multi-${index}.png` };
  });
}

function makeState(items, passthrough) {
  return {
    visible: true,
    index: 0,
    items,
    lastDeleteCommand: "",
    ownedImageIds: new Set(items.map((item) => item.id)),
    transmittedSignatures: new Map(),
    config: {
      columns: 24,
      rows: undefined,
      minRows: 1,
      maxRows: 64,
      zIndex: 0,
      showCaption: false,
      placement: "rightOverlay",
      placementId: stableKittyImageId("agent-utils-multi-image-render-smoke-placement"),
      transferMode: "memory",
      passthrough,
      placementMode: "auto",
      chunkSize: 4096,
    },
    currentCommand: undefined,
  };
}

// Per-entry prepared payloads (the multi-image analogue of state.currentCommand):
// one prepared record per image id, each carrying its own bytes while sharing the
// id-keyed transmit-once guard on state.transmittedSignatures.
function preparedById(items, passthrough) {
  const map = new Map();
  for (const item of items) {
    map.set(item.id, {
      itemId: item.id,
      transport: "memory",
      passthrough,
      chunkSize: 4096,
      pngBase64: PNG_BASE64,
      filePath: undefined,
      zIndex: 0,
      rendered: undefined,
    });
  }
  return map;
}

function renderPage(state, page, args, prepared) {
  return renderSidePanelPageLines(state, {
    page,
    rows: args.rows,
    totalWidth: args.width,
    imageWidth: args.width,
    useUnicodePlaceholders: true,
    preparedById: prepared,
  });
}

function main() {
  const args = parseArgs(process.argv);
  const items = makeItems(args.images);
  const pages = packImagesIntoPages(items, {
    columnWidth: args.width,
    availableRows: args.rows,
    headerRows: 1,
  });

  assert.ok(pages.length >= 1, "packImagesIntoPages produced at least one page");

  const pageReports = [];
  let firstPageFirstPaint = null;

  pages.forEach((page, pageIndex) => {
    const entryIds = page.entries.map((entry) => entry.item.id);
    // Fresh state per page so the id-keyed transmit-once guard is isolated; render
    // the page twice to prove the repaint is placement-only (no re-transmit).
    const state = makeState(items, args.passthrough);
    const prepared = preparedById(items, args.passthrough);
    const firstPaint = renderPage(state, page, args, prepared);
    const repaint = renderPage(state, page, args, prepared);
    if (pageIndex === 0) firstPageFirstPaint = firstPaint;

    // Structural invariants on the real landed render output.
    assertDistinctImageIdsOncePerRender(firstPaint, { expectedImageIds: entryIds });
    assertTransmitOncePerImageId([firstPaint, repaint]);
    assertNoOrphanPlaceholders([firstPaint, repaint]);

    const parsed = parseRenderedImageOutput(firstPaint);
    assert.equal(firstPaint.length, args.rows, "page render fills exactly the row budget");
    assert.equal(
      parsed.transmittedImageIds.size,
      entryIds.length,
      "every packed-page entry transmits its payload once on the first paint",
    );
    for (const id of entryIds) {
      assert.ok(parsed.placeholderImageIds.has(id), `entry ${id} anchors placeholder cells`);
    }

    pageReports.push({
      page: pageIndex,
      entries: entryIds.length,
      imageIds: entryIds,
      rows: firstPaint.length,
      placeholderRuns: parsed.placeholderRuns.length,
    });
  });

  if (args.emit && firstPageFirstPaint) {
    writeFileSync(args.emit, `${firstPageFirstPaint.join("\n")}\n`);
  }

  const maxEntriesPerPage = pageReports.reduce((max, report) => Math.max(max, report.entries), 0);
  const result = {
    ok: true,
    images: items.length,
    width: args.width,
    rows: args.rows,
    passthrough: args.passthrough,
    pages: pages.length,
    maxEntriesPerPage,
    pageReports,
    emitted: args.emit || null,
  };
  console.log(JSON.stringify(result, null, 2));
}

main();
