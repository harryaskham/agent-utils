// Headless structural harness for the kitty image-preview render output
// (bd-3623f7). The multi-placement side panel and scrollback behaviour cannot be
// validated headlessly by the implementing agent (the running Pi session loads
// the pinned package, not the checkout), so render work has had to land
// "foundation + pure unit tests" and defer the wiring to an operator validation
// window. This module narrows that gap: it parses the transmit/placeholder
// escape output that the render path emits into a structured model and provides
// assertion helpers, so multi-image render changes (per-entry name headers,
// transmit-once-per-image-id, scoped deletes, page navigation) can be checked
// structurally in `node --test` without a live kitty terminal.
//
// Design boundary: this is a PURE analyzer over render OUTPUT (an array of lines
// or a joined string). It does NOT import the live render path
// (renderTuiWithSidePanel / prepareCurrentImage / renderSidePanelPageLines),
// which is under active development on bd-502d6a — so it never collides with
// that surface and works unchanged for both the existing single-image widget and
// the upcoming multi-image side panel. Feed it whatever lines a render produced.

import {
  KITTY_UNICODE_PLACEHOLDER,
  decodePlaceholderDiacritic,
  parseKittyGraphicsCommands,
} from "../kitty-graphics.js";

// Kitty graphics actions that carry/identify a transmitted PNG payload upload:
//   T  transmit + display (cursor placement)
//   t  transmit only
//   f  transmit animation frame
// A command with one of these actions, an image id (`i`), and a non-empty
// base64 payload is a real upload of image bytes. Continuation chunks of a
// chunked upload carry only `m` (no `i`), so they are not double-counted.
const UPLOAD_ACTIONS = new Set(["T", "t", "f"]);

function rendersToLines(linesOrText) {
  if (Array.isArray(linesOrText)) return linesOrText.map((line) => String(line ?? ""));
  return String(linesOrText ?? "").split("\n");
}

function toInt(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function colorTriplet(match) {
  if (!match) return undefined;
  return (((Number(match[1]) << 16) | (Number(match[2]) << 8) | Number(match[3])) >>> 0);
}

// Normalize a raw {control, payloadBase64} command (from parseKittyGraphicsCommands)
// into a structurally meaningful record. Numeric protocol keys are decoded; the
// raw control map is retained for callers that need an uncommon key.
export function normalizeGraphicsCommand(command) {
  const control = command.control || {};
  const hasPayload = Boolean(command.payloadBase64 && command.payloadBase64.length);
  const imageId = control.i === undefined ? undefined : toInt(control.i);
  return {
    action: control.a,
    imageId,
    placementId: control.p === undefined ? undefined : toInt(control.p),
    columns: toInt(control.c),
    rows: toInt(control.r),
    zIndex: toInt(control.z),
    transport: control.t,
    format: control.f === undefined ? undefined : toInt(control.f),
    virtual: control.U === "1",
    deleteMode: control.d,
    more: control.m === "1",
    isContinuationChunk: control.i === undefined && control.m !== undefined,
    quiet: toInt(control.q),
    isUpload: UPLOAD_ACTIONS.has(control.a) && imageId !== undefined && hasPayload,
    isPlacement: control.a === "p",
    isDelete: control.a === "d",
    hasPayload,
    payloadLength: hasPayload ? command.payloadBase64.length : 0,
    control,
    raw: command.raw,
  };
}

// Decode the Unicode placeholder cells in render output. buildKittyUnicodePlaceholderLines
// emits, per row, an SGR truecolor image-id prefix (38;2;R;G;B → low 24 bits of
// the image id), an optional underline-color placement id (58;2;R;G;B), and a
// run of placeholder cells whose first cell carries combining diacritics for
// row, optional column, and optional image-id high byte. Each emitted line is
// self-contained, so we decode per line. Returns one run per line containing
// placeholders.
export function parseUnicodePlaceholderRuns(linesOrText) {
  const lines = rendersToLines(linesOrText);
  const runs = [];
  lines.forEach((rawLine, lineIndex) => {
    const line = String(rawLine ?? "");
    if (!line.includes(KITTY_UNICODE_PLACEHOLDER)) return;
    const low24 = colorTriplet(line.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/));
    const placementColorId = colorTriplet(line.match(/\x1b\[58;2;(\d+);(\d+);(\d+)m/));

    const chars = Array.from(line);
    const firstCell = chars.indexOf(KITTY_UNICODE_PLACEHOLDER);
    const diacritics = [];
    for (let index = firstCell + 1; index < chars.length; index += 1) {
      const value = decodePlaceholderDiacritic(chars[index]);
      if (value === undefined) break;
      diacritics.push(value);
    }
    const cellCount = chars.reduce((count, char) => count + (char === KITTY_UNICODE_PLACEHOLDER ? 1 : 0), 0);
    const row = diacritics[0];
    const column = diacritics[1];
    const highByte = diacritics[2] ?? 0;
    const imageId = low24 === undefined ? undefined : ((highByte * 0x1000000 + low24) >>> 0);

    runs.push({
      lineIndex,
      imageId,
      imageIdLow24: low24,
      imageIdHighByte: highByte,
      placementColorId,
      row,
      column,
      cellCount,
    });
  });
  return runs;
}

// Parse one render (array of lines or joined string) into a structural model:
// the normalized graphics commands, decoded placeholder runs, and the sets of
// image ids that were uploaded / placed / deleted / referenced by placeholders.
export function parseRenderedImageOutput(linesOrText) {
  const lines = rendersToLines(linesOrText);
  const text = lines.join("\n");
  const commands = parseKittyGraphicsCommands(text).map(normalizeGraphicsCommand);
  const placeholderRuns = parseUnicodePlaceholderRuns(lines);

  const transmittedImageIds = new Set();
  const placedImageIds = new Set();
  const deletedImageIds = new Set();
  for (const command of commands) {
    if (command.imageId === undefined) continue;
    if (command.isUpload) transmittedImageIds.add(command.imageId);
    if (command.isPlacement) placedImageIds.add(command.imageId);
    if (command.isDelete) deletedImageIds.add(command.imageId);
  }
  const placeholderImageIds = new Set(
    placeholderRuns.map((run) => run.imageId).filter((id) => id !== undefined),
  );

  return {
    lines,
    text,
    commands,
    placeholderRuns,
    transmittedImageIds,
    placedImageIds,
    deletedImageIds,
    placeholderImageIds,
  };
}

// A render sequence is an array of renders (a sequence of repaints). Each render
// is a string or an array of lines. To analyze a single render, pass [render].
function normalizeRenderSequence(renders) {
  if (renders === undefined || renders === null) return [];
  if (typeof renders === "string") return [renders];
  if (!Array.isArray(renders)) return [renders];
  return renders;
}

// Aggregate per-image-id counts across a sequence of renders: payload uploads,
// placement-only commands, delete commands, and the number of renders in which
// each image id appears as a placeholder.
export function summarizeRenderSequence(renders) {
  const parsed = normalizeRenderSequence(renders).map(parseRenderedImageOutput);
  const byImage = new Map();
  const ensure = (id) => {
    if (!byImage.has(id)) byImage.set(id, { uploads: 0, placements: 0, deletes: 0, placeholderFrames: 0 });
    return byImage.get(id);
  };
  for (const render of parsed) {
    for (const command of render.commands) {
      if (command.imageId === undefined) continue;
      if (command.isUpload) ensure(command.imageId).uploads += 1;
      else if (command.isPlacement) ensure(command.imageId).placements += 1;
      else if (command.isDelete) ensure(command.imageId).deletes += 1;
    }
    for (const id of render.placeholderImageIds) ensure(id).placeholderFrames += 1;
  }
  return { parsed, byImage };
}

function reportFailure(assertFn, message) {
  if (typeof assertFn === "function") {
    assertFn(false, message);
    return;
  }
  throw new Error(message);
}

// Assert the bd-d6fa1b transmit-once invariant structurally across a sequence of
// renders: every image id that appears uploads its payload exactly `expected`
// times (default 1). This catches the regression a multi-image wiring is most
// prone to — re-transmitting a PNG payload on every repaint — and, unlike a bare
// /a=T/ regex, distinguishes per-image-id so an N-image page is checked
// id-by-id. `perImageExpected` overrides the expectation for specific ids (e.g.
// a deliberate reattach re-transmit). Returns the per-image summary map.
export function assertTransmitOncePerImageId(renders, { expected = 1, perImageExpected, assert: assertFn } = {}) {
  const { byImage } = summarizeRenderSequence(renders);
  for (const [imageId, stats] of byImage) {
    const want = perImageExpected?.[imageId] ?? expected;
    if (stats.uploads !== want) {
      reportFailure(
        assertFn,
        `transmit-once violation: image ${imageId} uploaded ${stats.uploads} time(s) across the render sequence, expected ${want}`,
      );
    }
  }
  return byImage;
}

// Assert that every placeholder-referenced image id was transmitted in the same
// render or an earlier render of the sequence — i.e. no placeholder anchors an
// image the terminal was never sent. A real terminal would render such an
// orphan placeholder as tofu.
export function assertNoOrphanPlaceholders(renders, { assert: assertFn } = {}) {
  const sequence = normalizeRenderSequence(renders);
  const transmittedSoFar = new Set();
  sequence.forEach((render, index) => {
    const parsed = parseRenderedImageOutput(render);
    for (const id of parsed.transmittedImageIds) transmittedSoFar.add(id);
    for (const id of parsed.placeholderImageIds) {
      if (!transmittedSoFar.has(id)) {
        reportFailure(
          assertFn,
          `orphan placeholder: image ${id} is anchored by placeholder cells in render ${index} but was never transmitted`,
        );
      }
    }
  });
}

// Assert that a single render uploads/places each distinct image id exactly
// once and in stable id order — useful for the multi-image page where several
// distinct ids must each appear once with their own name header. `expectedImageIds`,
// when supplied, also asserts the exact set (and order) of image ids present.
export function assertDistinctImageIdsOncePerRender(render, { expectedImageIds, assert: assertFn } = {}) {
  const parsed = parseRenderedImageOutput(render);
  const uploadIds = parsed.commands.filter((command) => command.isUpload).map((command) => command.imageId);
  const seen = new Set();
  for (const id of uploadIds) {
    if (seen.has(id)) {
      reportFailure(assertFn, `duplicate upload in a single render: image ${id} uploaded more than once`);
    }
    seen.add(id);
  }
  if (Array.isArray(expectedImageIds)) {
    const actual = uploadIds.join(",");
    const want = expectedImageIds.map((id) => Number(id)).join(",");
    if (actual !== want) {
      reportFailure(assertFn, `unexpected uploaded image ids: got [${actual}], expected [${want}]`);
    }
  }
  return parsed;
}
