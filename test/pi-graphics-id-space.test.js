import test from "node:test";
import assert from "node:assert/strict";

import {
  PI_GRAPHICS_IMAGE_ID_BAND_BASE,
  PI_GRAPHICS_IMAGE_ID_BAND_SIZE,
  piGraphicsIdScope,
  piGraphicsImageId,
  piGraphicsPlacementId,
  piGraphicsPlaceholderPlacementId,
} from "../extensions/pi-graphics/id-space.js";
import { buildKittyUnicodePlaceholderCell } from "../extensions/kitty-graphics.js";

// bd-470314: pi-graphics editor-chrome image ids must live in a reserved high
// band so they stay disjoint from the 24-bit Unicode placeholder placement band
// and always encode their high byte via the placeholder diacritic (never collapse
// to 24 bits). This lowers cross-module kitty image-id aliasing with pi-tui's
// native read-image renderer and our sibling kitty-image-preview extension.

const PLACEHOLDER_PLACEMENT_FLOOR = 0x800000;
const PLACEHOLDER_PLACEMENT_CEIL = 0x1000000; // exclusive (24-bit truecolor)
const BAND_CEIL = PI_GRAPHICS_IMAGE_ID_BAND_BASE + PI_GRAPHICS_IMAGE_ID_BAND_SIZE; // exclusive

const EDITOR_CHROME_NAMES = [
  "editor-border-relative-top-120x1",
  "editor-border-anchor-top-120",
  "editor-border-joined-unicode-bottom-120x2",
  "editor-cursor-glow-3-2-1-8x16",
  "footer-underlay-placement-120",
  "box-rail-anchor-placement-info-top-120",
  "editor-row-background-120-8x16",
];

test("pi-graphics image ids fold into the reserved high band", () => {
  const options = { env: { PI_GRAPHICS_ID_NAMESPACE: "band-session" }, pid: 4242, cwd: "/repo" };
  // Band constants are coherent and stay inside the 32-bit namespace.
  assert.equal(PI_GRAPHICS_IMAGE_ID_BAND_BASE >>> 0, PI_GRAPHICS_IMAGE_ID_BAND_BASE);
  assert.ok(PI_GRAPHICS_IMAGE_ID_BAND_BASE >= 0x01000000, "band base keeps the high byte non-zero");
  assert.ok(BAND_CEIL <= 0xffffffff, "band stays below the 32-bit ceiling");

  for (const name of EDITOR_CHROME_NAMES) {
    const id = piGraphicsImageId(name, options);
    assert.equal(id >>> 0, id, `${name}: id is a uint32`);
    assert.ok(id >= PI_GRAPHICS_IMAGE_ID_BAND_BASE && id < BAND_CEIL, `${name}: id stays in the reserved band`);
    // Disjoint from the 24-bit placeholder placement band.
    assert.ok(
      id < PLACEHOLDER_PLACEMENT_FLOOR || id >= PLACEHOLDER_PLACEMENT_CEIL,
      `${name}: id must not alias the placeholder placement band`,
    );
    // High byte must be non-zero and encodable as a placeholder diacritic (<= 0xff).
    const highByte = Math.floor(id / 0x1000000);
    assert.ok(highByte > 0 && highByte <= 0xff, `${name}: high byte ${highByte} is placeholder-encodable`);
  }
});

test("banded image ids round-trip through the Unicode placeholder high-byte diacritic", () => {
  const options = { env: { PI_GRAPHICS_ID_NAMESPACE: "band-session" }, pid: 4242, cwd: "/repo" };
  for (const name of EDITOR_CHROME_NAMES) {
    const imageId = piGraphicsImageId(name, options);
    const placementId = piGraphicsPlaceholderPlacementId(`${name}-placement`, options);
    // Must not throw: a high byte beyond the diacritic table would raise here.
    const cell = buildKittyUnicodePlaceholderCell({ imageId, placementId, row: 0, column: 0 });
    assert.equal(typeof cell, "string");
    assert.ok(cell.length > 0, `${name}: placeholder cell is non-empty`);
  }
});

test("pi-graphics image ids are deterministic and salted by namespace + pid", () => {
  const base = { env: { PI_GRAPHICS_ID_NAMESPACE: "alpha" }, pid: 11, cwd: "/repo" };
  const sameProcess = piGraphicsImageId("editor-border-relative-top-120x1", base);
  assert.equal(
    piGraphicsImageId("editor-border-relative-top-120x1", base),
    sameProcess,
    "stable within the same process/namespace for redraw caching",
  );
  assert.notEqual(
    sameProcess,
    piGraphicsImageId("editor-border-relative-top-120x1", { ...base, pid: 99 }),
    "pid salts the id to avoid cross-pane stale-image collisions",
  );
  assert.notEqual(
    sameProcess,
    piGraphicsImageId("editor-border-relative-top-120x1", { ...base, env: { PI_GRAPHICS_ID_NAMESPACE: "beta" } }),
    "namespace salts the id across unrelated sessions",
  );
  assert.equal(piGraphicsIdScope(base), "alpha:pid:11");
});

test("distinct editor-chrome names map to distinct banded image ids", () => {
  const options = { env: { PI_GRAPHICS_ID_NAMESPACE: "uniqueness" }, pid: 7, cwd: "/repo" };
  const ids = EDITOR_CHROME_NAMES.map((name) => piGraphicsImageId(name, options));
  assert.equal(new Set(ids).size, ids.length, "no intra-extension collisions across editor-chrome names");
});

test("real placement ids keep the full 32-bit namespace while placeholder placement ids stay 24-bit", () => {
  const options = { env: { PI_GRAPHICS_ID_NAMESPACE: "placements" }, pid: 3, cwd: "/repo" };
  const real = piGraphicsPlacementId("editor-border-relative-placement-top-120x1", options);
  const placeholder = piGraphicsPlaceholderPlacementId("editor-border-anchor-placement-top-120", options);
  assert.ok(real >= 1 && real <= 0xffffffff, "real placement ids use the full 32-bit namespace");
  assert.ok(
    placeholder >= PLACEHOLDER_PLACEMENT_FLOOR && placeholder < PLACEHOLDER_PLACEMENT_CEIL,
    "placeholder placement ids remain encodable by Unicode underline truecolor",
  );
});

// bd-ad43f8: managed Cacophony agents restart in place inside a persistent tmux
// pane. Their kitty image-id namespace must be STABLE across restarts (drop the
// pid salt) so a restart reuses + overwrites (and frees) prior images instead of
// orphaning unreachable cross-pid IOSurfaces — the dominant macOS WindowServer
// leak. Distinct agents must still get distinct namespaces; an explicit
// operator-configured namespace must still take precedence and pid-salt.
test("managed-agent ids (CACO_AGENT_ID) are stable across pid so restarts reuse + free prior images", () => {
  const env = { CACO_AGENT_ID: "agent-a", CACO_MANAGED_PI_AGENT: "1" };
  assert.equal(piGraphicsIdScope({ env, pid: 11, cwd: "/repo" }), "caco-agent:agent-a");
  assert.equal(
    piGraphicsIdScope({ env, pid: 11, cwd: "/repo" }),
    piGraphicsIdScope({ env, pid: 99, cwd: "/elsewhere" }),
    "namespace drops the pid salt for a managed agent (restart reuse)",
  );
  assert.equal(
    piGraphicsImageId("editor-border", { env, pid: 11 }),
    piGraphicsImageId("editor-border", { env, pid: 99 }),
    "the same agent restarting gets the SAME image id (overwrite/free, not orphan)",
  );
});

test("distinct managed agents still get distinct namespaces (no cross-pane collision without pid salt)", () => {
  assert.notEqual(
    piGraphicsIdScope({ env: { CACO_AGENT_ID: "agent-a" }, pid: 11 }),
    piGraphicsIdScope({ env: { CACO_AGENT_ID: "agent-b" }, pid: 11 }),
  );
  assert.notEqual(
    piGraphicsImageId("editor-border", { env: { CACO_AGENT_ID: "agent-a" }, pid: 11 }),
    piGraphicsImageId("editor-border", { env: { CACO_AGENT_ID: "agent-b" }, pid: 11 }),
  );
});

test("CACOPHONY_AGENT is honored as the managed-agent signal when CACO_AGENT_ID is absent", () => {
  assert.equal(piGraphicsIdScope({ env: { CACOPHONY_AGENT: "agent-z" }, pid: 5 }), "caco-agent:agent-z");
});

test("an explicit operator namespace still takes precedence over the managed-agent shortcut and pid-salts", () => {
  const env = { PI_GRAPHICS_ID_NAMESPACE: "explicit", CACO_AGENT_ID: "agent-a" };
  assert.equal(piGraphicsIdScope({ env, pid: 11, cwd: "/repo" }), "explicit:pid:11");
  assert.equal(
    piGraphicsIdScope({ env: { ...env, PI_GRAPHICS_ID_NAMESPACE_EXACT: "1" }, pid: 11 }),
    "explicit",
  );
});
