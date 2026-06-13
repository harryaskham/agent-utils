import test from "node:test";
import assert from "node:assert/strict";

import {
  renderSidePanelPageLines,
  sidePanelEntryHeaderLine,
} from "../extensions/kitty-image-preview/widget.js";
import { packImagesIntoPages } from "../extensions/kitty-image-preview/layout.js";
import { resetTransmissionGuard } from "../extensions/kitty-image-preview/display-commands.js";
import { stableKittyImageId } from "../extensions/kitty-graphics.js";

// Headless coverage for the Part C-wire multi-image paged side-panel assembler
// (bd-502d6a). Mirrors the widget-smoke seam: drive renderSidePanelPageLines
// with forced unicode placeholders + per-entry prepared payloads and assert the
// bd-d6fa1b transmit-once-per-image invariant plus the name-header composition.

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeItem(name) {
  const id = stableKittyImageId(`agent-utils-paged-sidepanel-${name}`);
  return { id, label: name, width: 64, height: 64, path: `/tmp/${name}.png` };
}

function makeState(items) {
  return {
    visible: true,
    index: 0,
    items,
    lastDeleteCommand: "",
    ownedImageIds: new Set(items.map((i) => i.id)),
    transmittedSignatures: new Map(),
    config: {
      columns: 40,
      rows: undefined,
      minRows: 4,
      maxRows: 24,
      zIndex: 0,
      background: false,
      showCaption: true,
      clearPrevious: true,
      placement: "rightOverlay",
      placementId: stableKittyImageId("agent-utils-paged-sidepanel-placement"),
      transferMode: "memory",
      passthrough: "tmux",
      placementMode: "auto",
      chunkSize: 4096,
    },
    // No single currentCommand: the paged path supplies per-entry payloads.
    currentCommand: undefined,
  };
}

function preparedFor(item) {
  return {
    itemId: item.id,
    signature: `${item.id}:memory:0:tmux:4096`,
    transport: "memory",
    pngBase64: PNG_BASE64,
    filePath: undefined,
    zIndex: 0,
    passthrough: "tmux",
    chunkSize: 4096,
    rendered: undefined,
  };
}

function countMatches(text, re) {
  return (text.match(re) || []).length;
}

const IMAGE_WIDTH = 10;
const PADDING = 2;
const TOTAL_WIDTH = IMAGE_WIDTH + PADDING;
const ROWS = 30;

function packed(items) {
  return packImagesIntoPages(items, { columnWidth: IMAGE_WIDTH, availableRows: ROWS, headerRows: 1 });
}

test("sidePanelEntryHeaderLine renders a padded n/total label", () => {
  const items = [makeItem("alpha"), makeItem("beta")];
  const state = makeState(items);
  const header = sidePanelEntryHeaderLine(state, { index: 1, label: "beta" }, 12);
  assert.equal(header.length, 12, "padded to the panel width");
  assert.match(header, /^2\/2 beta/, "shows 1-based counter and label");
  // Zero width yields an empty header (rail disabled).
  assert.equal(sidePanelEntryHeaderLine(state, { index: 0, label: "x" }, 0), "");
});

test("renderSidePanelPageLines transmits each page image once and emits its header", () => {
  const items = [makeItem("alpha"), makeItem("beta")];
  const state = makeState(items);
  const preparedById = new Map(items.map((i) => [i.id, preparedFor(i)]));
  const pages = packed(items);
  const page = pages[0];

  const first = renderSidePanelPageLines(state, {
    page,
    rows: ROWS,
    totalWidth: TOTAL_WIDTH,
    imageWidth: IMAGE_WIDTH,
    padding: PADDING,
    useUnicodePlaceholders: true,
    preparedById,
  });
  assert.equal(first.length, ROWS, "fills the exact row budget");
  const firstText = first.join("\n");
  // One upload per packed-page entry, virtual placement, headers present.
  assert.equal(countMatches(firstText, /a=T/g), page.entries.length, "each page image uploads exactly once");
  assert.match(firstText, /U=1/, "uses virtual (unicode) placement");
  for (const entry of page.entries) {
    assert.ok(firstText.includes(entry.label), `header for ${entry.label} is present`);
  }

  // Repaint: the id-keyed transmit-once guard suppresses every re-upload while
  // the placeholder cells still carry the placement.
  const second = renderSidePanelPageLines(state, {
    page,
    rows: ROWS,
    totalWidth: TOTAL_WIDTH,
    imageWidth: IMAGE_WIDTH,
    padding: PADDING,
    useUnicodePlaceholders: true,
    preparedById,
  });
  const secondText = second.join("\n");
  assert.equal(countMatches(secondText, /a=T/g), 0, "no image re-uploads on repaint");
  assert.match(secondText, /\u{10EEEE}/u, "repaint still emits placeholder cells");

  // A terminal reattach (guard reset) re-transmits every page image once.
  resetTransmissionGuard(state);
  for (const prepared of preparedById.values()) prepared.rendered = undefined;
  const third = renderSidePanelPageLines(state, {
    page,
    rows: ROWS,
    totalWidth: TOTAL_WIDTH,
    imageWidth: IMAGE_WIDTH,
    padding: PADDING,
    useUnicodePlaceholders: true,
    preparedById,
  });
  assert.equal(countMatches(third.join("\n"), /a=T/g), page.entries.length, "reattach re-uploads each image once");
});

test("renderSidePanelPageLines emits placeholder-only cells when an entry has no prepared payload", () => {
  const items = [makeItem("alpha"), makeItem("beta")];
  const state = makeState(items);
  // Only the first image has a prepared payload; the second renders its
  // placeholder cells with no upload (the live wiring fills these in).
  const preparedById = new Map([[items[0].id, preparedFor(items[0])]]);
  const page = packed(items)[0];
  const lines = renderSidePanelPageLines(state, {
    page,
    rows: ROWS,
    totalWidth: TOTAL_WIDTH,
    imageWidth: IMAGE_WIDTH,
    padding: PADDING,
    useUnicodePlaceholders: true,
    preparedById,
  });
  const text = lines.join("\n");
  assert.equal(countMatches(text, /a=T/g), 1, "only the prepared image uploads");
  assert.match(text, /\u{10EEEE}/u, "both images still render placeholder cells");
});

test("renderSidePanelPageLines guards degenerate inputs", () => {
  const state = makeState([makeItem("alpha")]);
  assert.deepEqual(renderSidePanelPageLines(state, { page: undefined, rows: 10, totalWidth: 4, imageWidth: 2 }), []);
  assert.deepEqual(renderSidePanelPageLines(state, { page: { entries: [] }, rows: 0, totalWidth: 4, imageWidth: 2 }), []);
});
