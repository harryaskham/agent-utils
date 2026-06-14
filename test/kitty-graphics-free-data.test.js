import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDeleteCommand,
  buildScopedDeleteCommand,
  buildDeleteByZIndexCommand,
  buildDeleteByZIndexBandCommand,
  stableKittyImageId,
} from "../extensions/kitty-graphics.js";
import { releaseOwnedImageData, buildScopedDeleteCommand as buildScopedDeleteCommandFromState } from "../extensions/kitty-image-preview/display-commands.js";

// bd-b94fa1: the kitty delete builders only ever emitted LOWERCASE delete modes
// (d=i / d=z / d=a), which delete the placement but keep the image DATA resident
// in the terminal's IOSurface/GPU store. Long-running/backgrounded pi agents
// therefore leaked one image generation per cycle and never reclaimed it. The
// freeData option emits the UPPERCASE mode (d=I / d=Z), which also frees the
// stored data. These tests pin that semantics and the preview eviction helper.

const NONE = { passthrough: "none" };

test("buildDeleteCommand: freeData uppercases the by-id delete mode (i -> I)", () => {
  const leak = buildDeleteCommand({ imageId: 1234, placementId: 7, ...NONE });
  assert.match(leak, /,d=i,/, "default by-id delete is placement-only (lowercase)");
  assert.doesNotMatch(leak, /,d=I,/);

  const freed = buildDeleteCommand({ imageId: 1234, placementId: 7, freeData: true, ...NONE });
  assert.match(freed, /,d=I,/, "freeData emits the uppercase free-data delete");
  assert.doesNotMatch(freed, /,d=i,/);
});

test("buildDeleteCommand: no-id default is d=A (already frees), freeData keeps it uppercase", () => {
  const all = buildDeleteCommand({ ...NONE });
  assert.match(all, /,d=A,|^.*d=A/, "no-id delete defaults to d=A");
  const allFree = buildDeleteCommand({ freeData: true, ...NONE });
  assert.match(allFree, /d=A/, "freeData on the no-id path stays uppercase A");
});

test("buildScopedDeleteCommand: freeData emits d=I per owned id; default stays d=i", () => {
  const ids = [stableKittyImageId("a"), stableKittyImageId("b"), stableKittyImageId("c")];
  const leak = buildScopedDeleteCommand({ ownedImageIds: ids, placementId: 9, ...NONE });
  assert.equal((leak.match(/,d=i,/g) || []).length, 3, "one lowercase delete per owned id");
  assert.doesNotMatch(leak, /,d=I,/);

  const freed = buildScopedDeleteCommand({ ownedImageIds: ids, placementId: 9, freeData: true, ...NONE });
  assert.equal((freed.match(/,d=I,/g) || []).length, 3, "one free-data delete per owned id");
  assert.doesNotMatch(freed, /,d=i,/);

  const partial = buildScopedDeleteCommand({ ownedImageIds: ids, excludeIds: [ids[1]], freeData: true, ...NONE });
  assert.equal((partial.match(/,d=I,/g) || []).length, 2, "excludeIds are skipped");
});

test("buildDeleteByZIndexCommand / band: freeData selects d=Z over d=z", () => {
  assert.match(buildDeleteByZIndexCommand({ zIndex: -5, ...NONE }), /,d=z,/);
  assert.match(buildDeleteByZIndexCommand({ zIndex: -5, freeData: true, ...NONE }), /,d=Z,/);

  const band = buildDeleteByZIndexBandCommand({ zIndices: [-1, -2], freeData: true, ...NONE });
  assert.equal((band.match(/,d=Z,/g) || []).length, 2, "band threads freeData to each z-index delete");
});

function makeState(ids) {
  return {
    ownedImageIds: new Set(ids),
    transmittedSignatures: new Map(ids.map((id) => [id, `${id}:sig`])),
    config: { placementId: 42, passthrough: "none" },
  };
}

test("releaseOwnedImageData frees data for owned ids not in keepIds and stops tracking them", () => {
  const ids = [stableKittyImageId("x"), stableKittyImageId("y"), stableKittyImageId("z")];
  const state = makeState(ids);
  const keep = [ids[0]];

  const command = releaseOwnedImageData(state, { keepIds: keep });
  // Two ids freed (y, z) -> two uppercase free-data deletes.
  assert.equal((command.match(/,d=I,/g) || []).length, 2, "frees data for the two non-kept ids");
  assert.doesNotMatch(command, /,d=i,/, "never emits placement-only delete");

  // Kept id remains tracked; freed ids are removed from ownership + upload guard.
  assert.deepEqual([...state.ownedImageIds], [ids[0]], "only the kept id remains owned");
  assert.ok(state.transmittedSignatures.has(ids[0]), "kept id keeps its transmit guard");
  assert.ok(!state.transmittedSignatures.has(ids[1]), "freed id's transmit guard is invalidated");
  assert.ok(!state.transmittedSignatures.has(ids[2]), "freed id's transmit guard is invalidated");
});

test("releaseOwnedImageData with empty keepIds frees and untracks every owned id", () => {
  const ids = [stableKittyImageId("p"), stableKittyImageId("q")];
  const state = makeState(ids);
  const command = releaseOwnedImageData(state, { keepIds: [] });
  assert.equal((command.match(/,d=I,/g) || []).length, 2);
  assert.equal(state.ownedImageIds.size, 0, "all ids untracked after a full free");
  assert.equal(state.transmittedSignatures.size, 0, "all transmit-guard entries invalidated");
});

test("releaseOwnedImageData is a no-op (empty string) when nothing needs freeing", () => {
  const ids = [stableKittyImageId("only")];
  const state = makeState(ids);
  assert.equal(releaseOwnedImageData(state, { keepIds: ids }), "", "keeping every id frees nothing");
  assert.equal(releaseOwnedImageData({ ownedImageIds: new Set() }), "", "no owned ids frees nothing");
});

test("buildScopedDeleteCommand wrapper: freeData emits d=I and honors excludeIds (startup reclaim)", () => {
  const ids = [stableKittyImageId("cur"), stableKittyImageId("old1"), stableKittyImageId("old2")];
  const state = makeState(ids);
  // Default placement-only.
  assert.match(buildScopedDeleteCommandFromState(state, {}), /,d=i,/);
  // Startup reclaim: free all prior-session data EXCEPT the current image id.
  const reclaim = buildScopedDeleteCommandFromState(state, { freeData: true, excludeIds: [ids[0]] });
  assert.equal((reclaim.match(/,d=I,/g) || []).length, 2, "frees the two non-current owned ids");
  assert.doesNotMatch(reclaim, /,d=i,/, "reclaim never emits placement-only deletes");
  // The wrapper does NOT clear ownedImageIds (so re-shown images stay tracked).
  assert.equal(state.ownedImageIds.size, 3, "reclaim keeps ownership tracking intact");
});

test("stream supersede frees every prior frame's data and prunes ownership to the live frame (bd-1be5ca)", () => {
  // Each captured stream frame adds a fresh image id; prepareCurrentImage's
  // streaming branch reclaims the superseded frames via releaseOwnedImageData
  // (keepIds: [current]). This is what bounds a long-running stream to a single
  // resident bitmap instead of one per frame, the gap left by the multi-image
  // page reclaim (which only runs for 2+ side-panel images).
  const frames = ["f1", "f2", "f3", "f4", "f5"].map((n) => stableKittyImageId(n));
  const current = frames[frames.length - 1];
  const state = makeState(frames);

  const command = releaseOwnedImageData(state, { keepIds: [current] });
  assert.equal((command.match(/,d=I,/g) || []).length, frames.length - 1, "frees every superseded frame's data");
  assert.doesNotMatch(command, /,d=i,/, "stream reclaim never emits placement-only deletes");
  assert.deepEqual([...state.ownedImageIds], [current], "owned set is pruned to just the live frame");
  assert.equal(state.transmittedSignatures.size, 1, "only the live frame keeps a transmit guard");
});
