import test from "node:test";
import assert from "node:assert/strict";

import { stableKittyImageId } from "../extensions/kitty-graphics.js";
import { packImagesIntoPages } from "../extensions/kitty-image-preview/layout.js";
import { renderSidePanelPageLines } from "../extensions/kitty-image-preview/widget.js";
import {
  parseRenderedImageOutput,
  assertTransmitOncePerImageId,
  assertDistinctImageIdsOncePerRender,
  assertNoOrphanPlaceholders,
} from "../extensions/kitty-image-preview/render-harness.js";

// bd-d433ca: durable node --test guard that drives the LANDED multi-image
// side-panel render path (packImagesIntoPages -> renderSidePanelPageLines ->
// composePagedSidePanelLines + per-entry renderCurrentImageLines, bd-502d6a)
// and asserts the emitted escape stream structurally via the bd-3623f7 harness.
// The runnable companion is scripts/kitty-image-preview-multi-image-render-smoke.mjs.

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const WIDTH = 24;
const ROWS = 40;

// Two wide images so both pack onto a single page (exercising the multi-image
// composition: two distinct ids, two name headers, one transmit each).
function makeItems() {
  return [0, 1].map((seed) => ({
    id: stableKittyImageId(`agent-utils-multi-image-render-test-${seed}`),
    label: `image-${seed}`,
    width: 128,
    height: 48,
    path: `/tmp/multi-image-render-test-${seed}.png`,
  }));
}

function makeState(items) {
  return {
    visible: true,
    index: 0,
    items,
    lastDeleteCommand: "",
    ownedImageIds: new Set(items.map((item) => item.id)),
    transmittedSignatures: new Map(),
    config: {
      columns: WIDTH,
      rows: undefined,
      minRows: 1,
      maxRows: 64,
      zIndex: 0,
      showCaption: false,
      placement: "rightOverlay",
      placementId: stableKittyImageId("agent-utils-multi-image-render-test-placement"),
      transferMode: "memory",
      passthrough: "none",
      placementMode: "auto",
      chunkSize: 4096,
    },
    currentCommand: undefined,
  };
}

function preparedById(items) {
  const map = new Map();
  for (const item of items) {
    map.set(item.id, {
      itemId: item.id,
      transport: "memory",
      passthrough: "none",
      chunkSize: 4096,
      pngBase64: PNG_BASE64,
      filePath: undefined,
      zIndex: 0,
      rendered: undefined,
    });
  }
  return map;
}

function renderPage(state, page, prepared) {
  return renderSidePanelPageLines(state, {
    page,
    rows: ROWS,
    totalWidth: WIDTH,
    imageWidth: WIDTH,
    useUnicodePlaceholders: true,
    preparedById: prepared,
  });
}

test("packImagesIntoPages packs two wide images onto a single multi-entry page", () => {
  const items = makeItems();
  const pages = packImagesIntoPages(items, { columnWidth: WIDTH, availableRows: ROWS, headerRows: 1 });
  assert.equal(pages.length, 1, "both wide images fit on one page");
  assert.equal(pages[0].entries.length, 2, "the page has two entries");
});

test("renderSidePanelPageLines transmits each entry once with its own name header", () => {
  const items = makeItems();
  const [idA, idB] = items.map((item) => item.id);
  const pages = packImagesIntoPages(items, { columnWidth: WIDTH, availableRows: ROWS, headerRows: 1 });
  const state = makeState(items);
  const prepared = preparedById(items);

  const firstPaint = renderPage(state, pages[0], prepared);
  const text = firstPaint.join("\n");

  assert.equal(firstPaint.length, ROWS, "the page fills exactly the row budget");
  // Per-entry name headers ("n/total label") for both entries.
  assert.match(text, /1\/2 image-0/, "first entry name header present");
  assert.match(text, /2\/2 image-1/, "second entry name header present");

  const parsed = parseRenderedImageOutput(firstPaint);
  assert.deepEqual(
    [...parsed.transmittedImageIds].sort((a, b) => a - b),
    [idA, idB].sort((a, b) => a - b),
    "both distinct image ids transmit on the first paint",
  );
  assert.ok(parsed.placeholderImageIds.has(idA) && parsed.placeholderImageIds.has(idB),
    "both ids anchor placeholder cells");

  // Each id appears exactly once as an upload, in packed (top-to-bottom) order.
  assertDistinctImageIdsOncePerRender(firstPaint, { expectedImageIds: [idA, idB] });
});

test("a repaint is placement-only and transmit-once holds per image id", () => {
  const items = makeItems();
  const pages = packImagesIntoPages(items, { columnWidth: WIDTH, availableRows: ROWS, headerRows: 1 });
  const state = makeState(items);
  const prepared = preparedById(items);

  const firstPaint = renderPage(state, pages[0], prepared);
  const repaint = renderPage(state, pages[0], prepared);

  const repaintParsed = parseRenderedImageOutput(repaint);
  assert.equal(repaintParsed.transmittedImageIds.size, 0, "repaint re-transmits nothing");
  assert.equal(repaintParsed.placeholderImageIds.size, 2, "repaint still anchors both images via placeholders");

  assert.doesNotThrow(() => assertTransmitOncePerImageId([firstPaint, repaint]));
  assert.doesNotThrow(() => assertNoOrphanPlaceholders([firstPaint, repaint]));
});
