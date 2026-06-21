import test from "node:test";
import assert from "node:assert/strict";

import { enumerateGraphicsWriters } from "../extensions/kitty-image-preview/display-commands.js";
import {
  PROBE_PNG_BASE64,
  probeImageId,
  probePlacementId,
  buildPassthroughProbePlan,
} from "../extensions/kitty-image-preview/passthrough-probe.js";

// bd-15374a: a host passthrough probe emits a tiny kitty graphics test cell
// through every available terminal output path so the operator can see which
// path reaches the outer kitty client (raw-placeholder / blank-pixel failures).

test("enumerateGraphicsWriters: returns every reachable writer in precedence order, each bound", () => {
  const sinks = { uiWrite: [], uiTerm: [], term: [] };
  const ctx = {
    ui: {
      write: (c) => sinks.uiWrite.push(c),
      terminal: { write: (c) => sinks.uiTerm.push(c) },
    },
    terminal: { write: (c) => sinks.term.push(c) },
  };
  const writers = enumerateGraphicsWriters(ctx);
  assert.deepEqual(writers.map((w) => w.name), ["ui.write", "ui.terminal.write", "terminal.write"]);
  writers.find((w) => w.name === "ui.write").write("a");
  writers.find((w) => w.name === "ui.terminal.write").write("b");
  writers.find((w) => w.name === "terminal.write").write("c");
  assert.deepEqual(sinks, { uiWrite: ["a"], uiTerm: ["b"], term: ["c"] });
});

test("enumerateGraphicsWriters: omits missing paths and returns [] when none are reachable", () => {
  const partial = enumerateGraphicsWriters({ terminal: { write: () => {} } });
  assert.deepEqual(partial.map((w) => w.name), ["terminal.write"]);
  assert.deepEqual(enumerateGraphicsWriters({}), []);
  assert.deepEqual(enumerateGraphicsWriters(undefined), []);
});

test("probeImageId / probePlacementId: stable per name and distinct across writer names", () => {
  assert.equal(typeof probeImageId("ui.write"), "number");
  assert.equal(probeImageId("ui.write"), probeImageId("ui.write"), "stable across calls");
  assert.notEqual(probeImageId("ui.write"), probeImageId("terminal.write"), "distinct per writer");
  assert.notEqual(probePlacementId("ui.write"), probePlacementId("terminal.write"));
});

test("buildPassthroughProbePlan: one labeled transmit+display command per writer name", () => {
  const plan = buildPassthroughProbePlan({
    writerNames: ["ui.write", "terminal.write"],
    mode: "none",
  });
  assert.equal(plan.mode, "none");
  assert.equal(plan.entries.length, 2);
  for (const entry of plan.entries) {
    assert.equal(entry.label, `[kitty-probe ${entry.name}] `);
    assert.match(entry.command, /a=T/, "transmit+display action");
    assert.match(entry.command, /f=100/, "PNG payload format");
    assert.ok(entry.command.length > 0);
  }
  assert.notEqual(plan.entries[0].command, plan.entries[1].command, "distinct image ids per writer");
});

test("buildPassthroughProbePlan: empty writer set yields an empty plan", () => {
  const plan = buildPassthroughProbePlan({ writerNames: [], mode: "auto" });
  assert.deepEqual(plan.entries, []);
  assert.equal(plan.mode, "auto");
});

test("buildPassthroughProbePlan: the detected passthrough mode changes the wire wrapping", () => {
  const none = buildPassthroughProbePlan({ writerNames: ["ui.write"], mode: "none" });
  const tmux = buildPassthroughProbePlan({ writerNames: ["ui.write"], mode: "tmux" });
  assert.equal(none.mode, "none");
  assert.equal(tmux.mode, "tmux");
  assert.notEqual(none.entries[0].command, tmux.entries[0].command, "tmux wraps the escape differently from none");
  assert.match(tmux.entries[0].command, /tmux;/, "tmux passthrough is DCS-wrapped");
});

test("PROBE_PNG_BASE64 is a small embedded PNG payload", () => {
  assert.equal(typeof PROBE_PNG_BASE64, "string");
  assert.ok(PROBE_PNG_BASE64.startsWith("iVBOR"), "PNG magic in base64");
  assert.ok(PROBE_PNG_BASE64.length < 400, "stays a tiny embedded payload");
  // Decodes to a valid PNG signature.
  const bytes = Buffer.from(PROBE_PNG_BASE64, "base64");
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
});
