import test from "node:test";
import assert from "node:assert/strict";

import {
  serializePublicState,
  restorePublicState,
  trackOwnedItem,
  clearOwnedImageIds,
  pushItems,
  replaceItems,
  summarizeCurrent,
} from "../extensions/kitty-image-preview/state.js";

function makeState(overrides = {}) {
  return {
    visible: false,
    index: 0,
    config: {
      transferMode: "auto",
      placement: "aboveEditor",
      placementMode: "unicode",
      zIndex: -1,
    },
    items: [],
    ownedImageIds: new Set(),
    ...overrides,
  };
}

function makeItem(id, extra = {}) {
  return {
    id,
    path: `/imgs/${id}.png`,
    label: `img-${id}`,
    mediaType: "image/png",
    width: 10,
    height: 20,
    addedAt: 1000 + id,
    ...extra,
  };
}

test("serializePublicState captures a versioned snapshot of public fields", () => {
  const state = makeState({
    visible: true,
    index: 1,
    items: [makeItem(1), makeItem(2)],
    ownedImageIds: new Set([1, 2]),
  });
  const snap = serializePublicState(state);
  assert.equal(snap.version, 1);
  assert.equal(snap.visible, true);
  assert.equal(snap.index, 1);
  assert.deepEqual(snap.ownedImageIds, [1, 2]);
  assert.equal(snap.items.length, 2);
  assert.deepEqual(snap.items[0], {
    id: 1,
    path: "/imgs/1.png",
    label: "img-1",
    mediaType: "image/png",
    width: 10,
    height: 20,
    addedAt: 1001,
  });
  // config is copied, not shared.
  snap.config.zIndex = 99;
  assert.equal(state.config.zIndex, -1);
});

test("serialize -> restore round-trips state fidelity", () => {
  const source = makeState({
    visible: true,
    index: 1,
    items: [makeItem(1), makeItem(2)],
    ownedImageIds: new Set([1, 2]),
  });
  const snap = serializePublicState(source);

  const target = makeState();
  restorePublicState(target, { kittyImagePreviewState: snap });

  assert.equal(target.visible, true);
  assert.equal(target.index, 1);
  assert.equal(target.items.length, 2);
  assert.deepEqual(target.items.map((i) => i.id), [1, 2]);
  assert.deepEqual([...target.ownedImageIds], [1, 2]);
});

test("restorePublicState is a no-op without a valid snapshot", () => {
  const state = makeState({ visible: true, items: [makeItem(1)] });
  restorePublicState(state, undefined);
  restorePublicState(state, { kittyImagePreviewState: { items: "nope" } });
  assert.equal(state.visible, true);
  assert.equal(state.items.length, 1);
});

test("restorePublicState clamps index, filters bad items, and fills id fallback", () => {
  const state = makeState();
  restorePublicState(state, {
    kittyImagePreviewState: {
      visible: true,
      index: 99,
      items: [
        { path: "/a.png" }, // no id -> stableKittyImageId fallback
        { label: "no path, dropped" },
        makeItem(7),
      ],
    },
  });
  // two valid items survive (the path-less entry is dropped).
  assert.equal(state.items.length, 2);
  // Quirk (characterized, see bd note): index is clamped against the RAW
  // snapshot length (3 -> max 2), before filtering, so a dropped item can leave
  // index past the filtered array. Asserting actual behavior, not assumed.
  assert.equal(state.index, 2);
  assert.equal(Number.isFinite(state.items[0].id), true, "missing id is backfilled");
  assert.equal(state.items[0].label, "a.png", "label defaults to basename");
  // ownedImageIds falls back to all item ids when snapshot omits them.
  assert.deepEqual([...state.ownedImageIds].sort((x, y) => x - y), state.items.map((i) => i.id).sort((x, y) => x - y));
});

test("trackOwnedItem records numeric ids and ignores others", () => {
  const state = makeState();
  trackOwnedItem(state, makeItem(5));
  assert.deepEqual([...state.ownedImageIds], [5]);
  trackOwnedItem(state, { id: "not-a-number" });
  trackOwnedItem(state, null);
  assert.deepEqual([...state.ownedImageIds], [5]);
});

test("clearOwnedImageIds empties the owned set", () => {
  const state = makeState({ ownedImageIds: new Set([1, 2, 3]) });
  clearOwnedImageIds(state);
  assert.equal(state.ownedImageIds.size, 0);
});

test("pushItems appends items and tracks ownership", () => {
  const state = makeState();
  pushItems(state, [makeItem(1), makeItem(2)]);
  assert.deepEqual(state.items.map((i) => i.id), [1, 2]);
  assert.deepEqual([...state.ownedImageIds], [1, 2]);
});

test("replaceItems swaps the item list but retains previously-owned ids", () => {
  const state = makeState();
  pushItems(state, [makeItem(1), makeItem(2)]);
  replaceItems(state, [makeItem(3)]);
  // current items are replaced...
  assert.deepEqual(state.items.map((i) => i.id), [3]);
  // ...but old owned ids are intentionally retained for pending scoped deletes.
  assert.deepEqual([...state.ownedImageIds].sort((a, b) => a - b), [1, 2, 3]);
});

test("summarizeCurrent reports empty vs loaded state", () => {
  const empty = makeState();
  assert.equal(summarizeCurrent(empty), "No image is loaded.");

  const loaded = makeState({ index: 0, items: [makeItem(1)] });
  const summary = summarizeCurrent(loaded);
  assert.match(summary, /^Showing 1\/1: img-1 \(10×20\)/);
  assert.match(summary, /placement=aboveEditor/);
  assert.match(summary, /transfer=auto/);
  assert.match(summary, /z=-1\./);
});
