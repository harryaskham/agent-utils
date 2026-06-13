import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPngDisplayCommand,
  buildPngVirtualPlacementCommand,
  buildDeleteCommand,
  buildKittyUnicodePlaceholderLines,
  serializeKittyGraphicsCommand,
  decodePlaceholderDiacritic,
  parseKittyGraphicsCommands,
  stableKittyImageId,
} from "../extensions/kitty-graphics.js";
import {
  parseUnicodePlaceholderRuns,
  parseRenderedImageOutput,
  summarizeRenderSequence,
  assertTransmitOncePerImageId,
  assertNoOrphanPlaceholders,
  assertDistinctImageIdsOncePerRender,
} from "../extensions/kitty-image-preview/render-harness.js";
import { renderCurrentImageLines } from "../extensions/kitty-image-preview/widget.js";

// bd-3623f7: a headless structural harness for the kitty transmit/placeholder
// escape output, so multi-image render changes can be asserted in `node --test`
// without a live kitty terminal.

const SHORT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// ---------------------------------------------------------------------------
// Low-level command parsing (inverse of serializeKittyGraphics*).
// ---------------------------------------------------------------------------

test("parseKittyGraphicsCommands decodes control keys + payload of a transmit/display command", () => {
  const id = 0x817abc;
  const command = buildPngDisplayCommand({
    imageId: id,
    placementId: 7,
    pngBase64: SHORT_PNG_BASE64,
    columns: 10,
    rows: 4,
    zIndex: 0,
    passthrough: "none",
  });
  const parsed = parseKittyGraphicsCommands(command);
  assert.equal(parsed.length, 1, "single short payload is one command");
  const { control, payloadBase64 } = parsed[0];
  assert.equal(control.a, "T", "transmit + display");
  assert.equal(control.i, String(id));
  assert.equal(control.p, "7");
  assert.equal(control.t, "d", "inline (direct) transport");
  assert.equal(payloadBase64, SHORT_PNG_BASE64);
});

test("parseKittyGraphicsCommands splits a chunked upload into ordered chunks with continuation flags", () => {
  const bigPayload = "A".repeat(1700);
  const command = buildPngDisplayCommand({
    imageId: 42,
    placementId: 1,
    pngBase64: bigPayload,
    columns: 8,
    rows: 4,
    passthrough: "none",
    chunkSize: 512,
  });
  const parsed = parseKittyGraphicsCommands(command);
  assert.ok(parsed.length >= 2, "payload over the chunk size yields multiple commands");
  assert.equal(parsed[0].control.i, "42", "first chunk carries the image id");
  assert.equal(parsed[0].control.m, "1", "first chunk flags more data");
  assert.equal(parsed.at(-1).control.m, "0", "final chunk flags no more data");
  assert.equal(parsed.at(-1).control.i, undefined, "continuation chunks omit the image id");
  const reassembled = parsed.map((entry) => entry.payloadBase64).join("");
  assert.equal(reassembled, bigPayload, "chunk payloads reassemble to the original");
});

test("parseKittyGraphicsCommands unwraps tmux passthrough framing", () => {
  const raw = serializeKittyGraphicsCommand(
    { a: "d", d: "i", i: 99, p: 3 },
    "",
    { passthrough: "none" },
  );
  const tmuxWrapped = serializeKittyGraphicsCommand(
    { a: "d", d: "i", i: 99, p: 3 },
    "",
    { passthrough: "tmux" },
  );
  assert.notEqual(raw, tmuxWrapped, "tmux mode wraps the sequence differently");
  const parsed = parseKittyGraphicsCommands(tmuxWrapped);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].control.a, "d");
  assert.equal(parsed[0].control.d, "i");
  assert.equal(parsed[0].control.i, "99");
});

test("parseKittyGraphicsCommands handles a delete command with no payload", () => {
  const command = buildDeleteCommand({ imageId: 5, placementId: 2, passthrough: "none" });
  const [parsed] = parseKittyGraphicsCommands(command);
  assert.equal(parsed.control.a, "d");
  assert.equal(parsed.payloadBase64, "");
});

// ---------------------------------------------------------------------------
// Unicode placeholder decoding.
// ---------------------------------------------------------------------------

test("decodePlaceholderDiacritic returns undefined for non-diacritic characters", () => {
  assert.equal(decodePlaceholderDiacritic("a"), undefined);
  assert.equal(decodePlaceholderDiacritic(undefined), undefined);
});

test("parseUnicodePlaceholderRuns reconstructs the full 32-bit image id, row, and cell count", () => {
  const imageId = stableKittyImageId("agent-utils-render-harness-placeholder-test");
  const placementId = stableKittyImageId("agent-utils-render-harness-placeholder-placement");
  const lines = buildKittyUnicodePlaceholderLines({
    imageId,
    placementId,
    columns: 4,
    rows: 2,
    width: 12,
  });
  const runs = parseUnicodePlaceholderRuns(lines);
  assert.equal(runs.length, 2, "one run per placeholder row");
  assert.equal(runs[0].imageId, imageId, "row 0 reconstructs the full image id");
  assert.equal(runs[1].imageId, imageId, "row 1 reconstructs the full image id");
  assert.equal(runs[0].row, 0);
  assert.equal(runs[1].row, 1);
  assert.equal(runs[0].cellCount, 4, "four placeholder cells across the column width");
  assert.ok(runs[0].placementColorId !== undefined, "placement underline color decodes");
});

// ---------------------------------------------------------------------------
// Render-path integration: drive the real single-image render and assert the
// bd-d6fa1b transmit-once invariant structurally.
// ---------------------------------------------------------------------------

function makeState(seed) {
  const id = stableKittyImageId(`agent-utils-render-harness-${seed}`);
  const item = { id, label: `harness-${seed}`, width: 64, height: 64, path: `/tmp/harness-${seed}.png` };
  return {
    visible: true,
    index: 0,
    items: [item],
    lastDeleteCommand: "",
    ownedImageIds: new Set([id]),
    transmittedSignatures: new Map(),
    config: {
      columns: 20,
      rows: undefined,
      minRows: 3,
      maxRows: 12,
      zIndex: 0,
      showCaption: false,
      placement: "auto",
      placementId: stableKittyImageId(`agent-utils-render-harness-placement-${seed}`),
      transferMode: "memory",
      passthrough: "tmux",
      placementMode: "auto",
      chunkSize: 4096,
    },
    currentCommand: {
      itemId: id,
      signature: `${id}:memory:0:tmux:4096`,
      transport: "memory",
      pngBase64: SHORT_PNG_BASE64,
      filePath: undefined,
      zIndex: 0,
      passthrough: "tmux",
      chunkSize: 4096,
      rendered: undefined,
    },
  };
}

function renderUnicodeOnce(state) {
  return renderCurrentImageLines(state, state.items[state.index], {
    columns: 16,
    rows: 3,
    lineWidth: 20,
    useUnicodePlaceholders: true,
    frame: false,
  });
}

test("parseRenderedImageOutput models the real single-image side-panel render", () => {
  const state = makeState("single");
  const render = renderUnicodeOnce(state);
  const parsed = parseRenderedImageOutput(render);

  assert.equal(parsed.transmittedImageIds.size, 1, "exactly one image transmitted");
  assert.ok(parsed.transmittedImageIds.has(state.items[0].id), "the transmitted id matches the item");
  assert.ok(parsed.placeholderImageIds.has(state.items[0].id), "placeholder cells anchor the same id");
  assert.ok(parsed.placeholderRuns.length >= 1, "placeholder rows decoded");
  const upload = parsed.commands.find((command) => command.isUpload);
  assert.ok(upload, "an upload command is present");
  assert.equal(upload.virtual, true, "side-panel upload uses a virtual (unicode) placement");
});

test("assertTransmitOncePerImageId passes on a steady repaint and no placeholders are orphaned", () => {
  const state = makeState("repaint");
  const first = renderUnicodeOnce(state);
  const second = renderUnicodeOnce(state);
  const third = renderUnicodeOnce(state);

  // First frame uploads; repaints are placement-only via the persistent
  // placeholder cells (bd-d6fa1b). Across the whole sequence the payload ships once.
  const summary = summarizeRenderSequence([first, second, third]);
  assert.equal(summary.byImage.get(state.items[0].id).uploads, 1, "payload uploaded exactly once");
  assert.equal(summary.byImage.get(state.items[0].id).placeholderFrames, 3, "placeholders persist every frame");

  assert.doesNotThrow(() => assertTransmitOncePerImageId([first, second, third]));
  assert.doesNotThrow(() => assertNoOrphanPlaceholders([first, second, third]));
});

// ---------------------------------------------------------------------------
// Multi-image discrimination: prove the harness separates per-image-id transmit
// counts, which a bare /a=T/ regex cannot, ahead of the bd-502d6a multi-image
// side-panel wiring.
// ---------------------------------------------------------------------------

test("the harness distinguishes per-image-id transmit-once across a multi-image page", () => {
  const stateA = makeState("page-A");
  const stateB = makeState("page-B");
  const idA = stateA.items[0].id;
  const idB = stateB.items[0].id;
  assert.notEqual(idA, idB, "the two page entries have distinct image ids");

  // page 1: both entries upload + place; page 2: repaint, placeholders only.
  const page1 = [...renderUnicodeOnce(stateA), ...renderUnicodeOnce(stateB)];
  const page2 = [...renderUnicodeOnce(stateA), ...renderUnicodeOnce(stateB)];

  assert.doesNotThrow(() => assertTransmitOncePerImageId([page1, page2]));
  assert.doesNotThrow(() =>
    assertDistinctImageIdsOncePerRender(page1, { expectedImageIds: [idA, idB] }),
  );

  const summary = summarizeRenderSequence([page1, page2]);
  assert.equal(summary.byImage.get(idA).uploads, 1);
  assert.equal(summary.byImage.get(idB).uploads, 1);
});

test("the harness catches a re-transmit regression that a bare a=T regex would miss", () => {
  const stateA = makeState("regression");
  const idA = stateA.items[0].id;
  const upload = renderUnicodeOnce(stateA); // first render carries the payload upload

  // Simulate a buggy multi-placement render that re-transmits the same image's
  // payload twice in a single page (e.g. per-entry payload prep that forgot the
  // transmit-once guard). A /a=T/ regex still matches "an upload happened"; the
  // structural harness counts two uploads of the same id and fails.
  const buggyPage = [...upload, ...upload];

  assert.match(buggyPage.join("\n"), /a=T/, "the naive regex still passes on the buggy render");
  assert.throws(
    () => assertDistinctImageIdsOncePerRender(buggyPage),
    /duplicate upload/,
    "the harness flags the duplicate single-render upload",
  );
  assert.throws(
    () => assertTransmitOncePerImageId([buggyPage]),
    new RegExp(`image ${idA} uploaded 2`),
    "the harness flags the per-image transmit-once violation",
  );
});
