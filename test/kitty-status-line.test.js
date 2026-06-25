import test from "node:test";
import assert from "node:assert/strict";

import {
  imageControlHint,
  imageStatusLine,
  imageSeparatorLine,
  imageHeaderLine,
  imageControlsLine,
  defaultScreenshotLabel,
  streamStatusLine,
} from "../extensions/kitty-image-preview/status-line.js";

function makeLabeledState({ items = 1, index = 0, showCaption = true } = {}) {
  return {
    items: Array.from({ length: items }, (_, i) => ({ id: i, label: `HE-${300 + i} preview` })),
    index,
    config: { showCaption },
  };
}

test("imageSeparatorLine fills the width with a horizontal rule", () => {
  assert.equal(imageSeparatorLine(5), "\u2500\u2500\u2500\u2500\u2500");
  assert.equal(imageSeparatorLine(0).length, 1);
  assert.equal(imageSeparatorLine(3, "-"), "---");
});

test("imageHeaderLine shows label with a (current/total) counter", () => {
  assert.equal(imageHeaderLine(makeLabeledState({ items: 2, index: 1 }), 80), "HE-301 preview (2/2)");
  assert.equal(imageHeaderLine(makeLabeledState({ items: 2, index: 0 }), 80), "HE-300 preview (1/2)");
  // Truncates to width.
  assert.ok(imageHeaderLine(makeLabeledState({ items: 2, index: 0 }), 8).length <= 8);
  // Empty state yields an empty header.
  assert.equal(imageHeaderLine({ items: [], index: 0, config: {} }, 80), "");
});

function makeState({ items = 0, visible = true, index = 0, animation, cycle } = {}) {
  return {
    items: Array.from({ length: items }, (_, i) => ({ id: i, label: `img${i}` })),
    visible,
    index,
    animation,
    cycle,
  };
}

test("imageControlHint returns the status hint when no images are loaded", () => {
  assert.equal(imageControlHint(makeState({ items: 0 })), "/image-status");
  assert.equal(imageControlHint(makeState({ items: 0 }), { includeCount: true }), "/image-status");
});

test("imageControlHint shows show/clear when hidden, with pluralized count", () => {
  assert.equal(imageControlHint(makeState({ items: 3, visible: false })), "/image-show /image-clear");
  assert.equal(
    imageControlHint(makeState({ items: 3, visible: false }), { includeCount: true }),
    "/image-show /image-clear 3 images",
  );
  assert.equal(
    imageControlHint(makeState({ items: 1, visible: false }), { includeCount: true }),
    "/image-show /image-clear 1 image",
  );
});

test("imageControlHint adds prev/next nav only with multiple visible images", () => {
  assert.equal(imageControlHint(makeState({ items: 1, visible: true })), "/image-hide /image-clear");
  assert.equal(
    imageControlHint(makeState({ items: 1, visible: true }), { includeCount: true }),
    "/image-hide /image-clear 1/1",
  );
  assert.equal(
    imageControlHint(makeState({ items: 3, visible: true, index: 1 }), { includeCount: true }),
    "/image-prev /image-next /image-hide /image-clear 2/3",
  );
});

test("imageStatusLine is undefined with no images and a hidden line when hidden", () => {
  assert.equal(imageStatusLine(makeState({ items: 0 }), undefined), undefined);
  assert.equal(
    imageStatusLine(makeState({ items: 2, visible: false }), undefined),
    "🖼 hidden 2 images — /image-show /image-clear",
  );
});

test("imageStatusLine renders the visible line with label and control hint", () => {
  assert.equal(
    imageStatusLine(makeState({ items: 1, visible: true, index: 0 }), { label: "pic" }),
    "🖼 1/1 pic — /image-hide /image-clear",
  );
  // no current label -> no label segment.
  assert.equal(
    imageStatusLine(makeState({ items: 1, visible: true, index: 0 }), undefined),
    "🖼 1/1 — /image-hide /image-clear",
  );
});

test("imageStatusLine adds animation and cycle markers", () => {
  assert.equal(
    imageStatusLine(
      makeState({ items: 3, visible: true, index: 1, animation: { running: true } }),
      { label: "b" },
    ),
    "🖼 ▶ 2/3 b — /image-prev /image-next /image-hide /image-clear",
  );
  // cycle marker rounds intervalMs to whole seconds.
  assert.equal(
    imageStatusLine(
      makeState({ items: 1, visible: true, index: 0, cycle: { running: true, intervalMs: 5000 } }),
      { label: "c" },
    ),
    "🖼 ⟳5s 1/1 c — /image-hide /image-clear",
  );
  // both markers together.
  assert.equal(
    imageStatusLine(
      makeState({
        items: 1,
        visible: true,
        index: 0,
        animation: { running: true },
        cycle: { running: true, intervalMs: 2500 },
      }),
      { label: "c" },
    ),
    "🖼 ▶ ⟳3s 1/1 c — /image-hide /image-clear",
  );
});

test("imageControlsLine is empty with no images and a truncated controls hint otherwise (bd-dbaf7e)", () => {
  assert.equal(imageControlsLine(makeState({ items: 0 }), 40), "");
  assert.equal(
    imageControlsLine(makeState({ items: 3, visible: true, index: 0 }), 80),
    "controls: /image-prev /image-next /image-hide /image-clear 1/3",
  );
  // Truncated to the available width.
  assert.ok(imageControlsLine(makeState({ items: 3, visible: true }), 10).length <= 10);
});

test("defaultScreenshotLabel selects the best name and prefixes screenshot/kind (bd-dbaf7e)", () => {
  const date = new Date("2020-01-02T03:04:05Z");
  // title > name > app_name > id precedence.
  assert.ok(defaultScreenshotLabel({ kind: "display", title: "T", name: "N", id: "x" }, date).startsWith("screenshot display T "));
  assert.ok(defaultScreenshotLabel({ kind: "window", name: "N", id: "x" }, date).startsWith("screenshot window N "));
  assert.ok(defaultScreenshotLabel({ kind: "window", app_name: "App", id: "x" }, date).startsWith("screenshot window App "));
  assert.ok(defaultScreenshotLabel({ kind: "window", id: "w1" }, date).startsWith("screenshot window w1 "));
  // The time portion (toLocaleTimeString) is locale/TZ-dependent, so only assert it is present.
  assert.match(defaultScreenshotLabel({ kind: "window", id: "w1" }, date), /screenshot window w1 .+/);
});

test("streamStatusLine summarizes running and not-running streams (bd-dbaf7e)", () => {
  assert.equal(streamStatusLine(null), "No kitty image preview stream is running.");
  assert.equal(streamStatusLine({ running: false }), "No kitty image preview stream is running.");
  const line = streamStatusLine({
    running: true,
    startedAt: Date.now() - 2000,
    frameCount: 10,
    intervalMs: 500,
    target: { kind: "display", id: "d1" },
    latestPath: "/tmp/x.png",
  });
  assert.ok(line.startsWith("Streaming display d1: frames=10 "));
  assert.match(line, /fps=[\d.]+/); // fps is timing-derived, assert shape not exact value
  assert.match(line, /interval=500ms latest=\/tmp\/x\.png$/);
});
