import test from "node:test";
import assert from "node:assert/strict";

import {
  KITTY_IMAGE_PREVIEW_ID_PREFIX,
  kittyPreviewDefaultPlacementId,
  kittyPreviewImageId,
  kittyPreviewItemName,
  kittyPreviewPlaceholderPlacementId,
} from "../extensions/kitty-image-preview/id-space.js";
import { piGraphicsImageId, piGraphicsPlaceholderPlacementId } from "../extensions/pi-graphics/id-space.js";

test("kitty preview ids delegate to the pi-graphics scoped namespace", () => {
  const options = { env: { CACO_AGENT_ID: "agent-a" }, pid: 1234, cwd: "/repo" };
  const name = "item./tmp/example.png.10.20";

  assert.equal(
    kittyPreviewImageId(name, options),
    piGraphicsImageId(`${KITTY_IMAGE_PREVIEW_ID_PREFIX}.${name}`, options),
  );
  assert.equal(
    kittyPreviewImageId(name, options),
    kittyPreviewImageId(name, { ...options, pid: 5678 }),
    "managed-agent (CACO_AGENT_ID) ids drop the pid salt so a restart reuses + overwrites (frees) prior images instead of orphaning unreachable cross-pid IOSurfaces (bd-ad43f8)",
  );
});

test("kitty preview Unicode placement ids use the 24-bit placeholder-safe allocator", () => {
  const options = { env: { CACO_AGENT_ID: "agent-a" }, pid: 1234, cwd: "/repo" };
  const placement = kittyPreviewPlaceholderPlacementId("placement.main", options);

  assert.equal(
    placement,
    piGraphicsPlaceholderPlacementId(`${KITTY_IMAGE_PREVIEW_ID_PREFIX}.placement.main`, options),
  );
  assert.ok(placement >= 0x800000, "placeholder ids allocate from the high half of 24-bit truecolor space");
  assert.ok(placement <= 0xffffff, "placeholder ids remain encodable by Unicode underline truecolor");
  assert.equal(kittyPreviewDefaultPlacementId(options), placement);
});

test("kittyPreviewItemName preserves the file identity inputs used for stream frame churn", () => {
  assert.equal(
    kittyPreviewItemName({ absolutePath: "/tmp/frame.png", mtimeMs: 42.5, size: 99 }),
    "item./tmp/frame.png.42.5.99",
  );
});
