import test from "node:test";
import assert from "node:assert/strict";

import selfCompactExtension, {
  buildCompactCommand,
  sanitizeInstructions,
} from "../extensions/self-compact.js";

// bd-d71947: self_compact triggers compaction via the ExtensionContext's
// `ctx.compact({ customInstructions })` (the 5th arg to a tool's execute), NOT
// via pi.sendUserMessage("/compact") (which only replays text, never dispatches
// the slash command, so no compaction ran).
function makeHarness({ now } = {}) {
  const tools = new Map();
  const compactCalls = [];
  const handlers = new Map();
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    on(event, handler) {
      const arr = handlers.get(event) || [];
      arr.push(handler);
      handlers.set(event, arr);
    },
  };
  // The ExtensionContext handed to a tool's execute (5th arg). compact() is the
  // documented fire-and-forget compaction trigger.
  const ctx = {
    hasUI: false,
    compact(options) { compactCalls.push(options); },
  };
  const emit = (event, payload) => {
    for (const h of handlers.get(event) || []) h(payload);
  };
  return { pi, ctx, tools, compactCalls, handlers, emit };
}

function load(pi, opts) {
  return selfCompactExtension(pi, opts);
}

// Invoke the tool with the ctx as the 5th execute arg, matching Pi's real
// ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx) signature.
function run(h, toolCallId, params) {
  return h.tools.get("self_compact").execute(toolCallId, params, null, null, h.ctx);
}

test("registers a self_compact agent-visible tool", () => {
  const h = makeHarness();
  load(h.pi);
  const tool = h.tools.get("self_compact");
  assert.ok(tool, "self_compact tool should be registered");
  assert.equal(tool.label, "Self Compact");
  assert.match(tool.description, /\/compact/);
  assert.ok(tool.parameters?.properties?.instructions, "should accept instructions param");
  assert.ok(tool.parameters?.properties?.dryRun, "should accept dryRun param");
});

test("execute triggers ctx.compact (real compaction, no user-message replay)", async () => {
  const h = makeHarness();
  load(h.pi);
  const result = await run(h, "tool-1", {});
  assert.equal(h.compactCalls.length, 1, "ctx.compact should be called once");
  assert.equal(h.compactCalls[0].customInstructions, undefined, "no instructions -> undefined");
  assert.equal(typeof h.compactCalls[0].onError, "function", "should pass an onError handler");
  assert.equal(result.details.queued, true);
  assert.equal(result.details.command, "/compact");
});

test("execute with instructions passes sanitized customInstructions to ctx.compact", async () => {
  const h = makeHarness();
  load(h.pi);
  const result = await run(h, "tool-1", { instructions: "focus on the current bead implementation" });
  assert.equal(h.compactCalls.length, 1);
  assert.equal(h.compactCalls[0].customInstructions, "focus on the current bead implementation");
  assert.equal(result.details.command, "/compact focus on the current bead implementation");
  assert.equal(result.details.queued, true);
});

test("dry-run reports the command without triggering compaction", async () => {
  const h = makeHarness();
  load(h.pi);
  const result = await run(h, "tool-1", { dryRun: true });
  assert.equal(h.compactCalls.length, 0, "dry-run must not compact");
  assert.equal(result.details.queued, false);
  assert.equal(result.details.dryRun, true);
  assert.match(result.content[0].text, /Would trigger compaction \(`\/compact`\)/);
});

test("rate-limit skips a second self-compaction within the minimum interval", async () => {
  let clock = 1_000_000;
  const h = makeHarness();
  load(h.pi, { now: () => clock });

  const first = await run(h, "t1", {});
  assert.equal(first.details.queued, true);
  assert.equal(h.compactCalls.length, 1);

  clock += 5_000; // 5s later — within the 30s default window
  const second = await run(h, "t2", {});
  assert.equal(second.details.queued, false);
  assert.equal(second.details.reason, "rate_limited");
  assert.equal(h.compactCalls.length, 1, "no second compaction should fire");

  clock += 30_000; // now well past the window
  const third = await run(h, "t3", {});
  assert.equal(third.details.queued, true);
  assert.equal(h.compactCalls.length, 2);
});

test("dry-run is not rate-limited and does not consume the window", async () => {
  let clock = 0;
  const h = makeHarness();
  load(h.pi, { now: () => clock });
  await run(h, "t1", { dryRun: true });
  await run(h, "t2", { dryRun: true });
  // A real compaction right after dry-runs must still succeed.
  const real = await run(h, "t3", {});
  assert.equal(real.details.queued, true);
  assert.equal(h.compactCalls.length, 1);
});

test("session_compact event advances the rate-limit reference point", async () => {
  let clock = 0;
  const h = makeHarness();
  load(h.pi, { now: () => clock });

  clock = 10_000;
  h.emit("session_compact", {}); // a real compaction happened at t=10s
  clock = 20_000; // 10s after the compaction — still within the 30s window
  const blocked = await run(h, "t1", {});
  assert.equal(blocked.details.queued, false, "should be rate-limited relative to the actual compaction");
  assert.equal(h.compactCalls.length, 0);
});

test("missing ctx.compact is reported, not thrown", async () => {
  const h = makeHarness();
  load(h.pi);
  // Simulate a runtime whose ExtensionContext has no compact().
  const result = await h.tools.get("self_compact").execute("t1", {}, null, null, { hasUI: false });
  assert.equal(result.details.queued, false);
  assert.equal(result.details.reason, "unsupported");
  assert.equal(h.compactCalls.length, 0);
});

test("disabled via PI_SELF_COMPACT_TOOL=0 registers no tool", () => {
  const prev = process.env.PI_SELF_COMPACT_TOOL;
  process.env.PI_SELF_COMPACT_TOOL = "0";
  try {
    const h = makeHarness();
    load(h.pi);
    assert.equal(h.tools.has("self_compact"), false);
  } finally {
    if (prev === undefined) delete process.env.PI_SELF_COMPACT_TOOL;
    else process.env.PI_SELF_COMPACT_TOOL = prev;
  }
});

test("buildCompactCommand + sanitizeInstructions: bound, single-line, strip leading slashes", () => {
  assert.equal(buildCompactCommand(), "/compact");
  assert.equal(buildCompactCommand(""), "/compact");
  assert.equal(buildCompactCommand("  keep the bead context  "), "/compact keep the bead context");
  // Leading slashes stripped so it can't re-shape into a different slash command.
  assert.equal(buildCompactCommand("/restart now"), "/compact restart now");
  // Control chars collapsed to spaces.
  assert.equal(sanitizeInstructions("a\nb\tc"), "a b c");
  // Bounded length.
  assert.equal(sanitizeInstructions("x".repeat(5000)).length, 2000);
});
