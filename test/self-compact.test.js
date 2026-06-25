import test from "node:test";
import assert from "node:assert/strict";

import selfCompactExtension, {
  buildCompactCommand,
  sanitizeInstructions,
} from "../extensions/self-compact.js";

function makeHarness({ now } = {}) {
  const tools = new Map();
  const userMessages = [];
  const handlers = new Map();
  const pi = {
    registerTool(definition) { tools.set(definition.name, definition); },
    sendUserMessage(message, options) { userMessages.push({ message, options }); },
    on(event, handler) {
      const arr = handlers.get(event) || [];
      arr.push(handler);
      handlers.set(event, arr);
    },
  };
  const emit = (event, payload) => {
    for (const h of handlers.get(event) || []) h(payload);
  };
  return { pi, tools, userMessages, handlers, emit };
}

function load(pi, opts) {
  return selfCompactExtension(pi, opts);
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

test("execute queues /compact as a follow-up user message", async () => {
  const h = makeHarness();
  load(h.pi);
  const result = await h.tools.get("self_compact").execute("tool-1", {}, null, null, {});
  assert.equal(h.userMessages.length, 1);
  assert.equal(h.userMessages[0].message, "/compact");
  assert.equal(h.userMessages[0].options.deliverAs, "followUp");
  assert.equal(h.userMessages[0].options.streamingBehavior, "followUp");
  assert.equal(result.details.queued, true);
  assert.equal(result.details.command, "/compact");
});

test("execute with instructions queues /compact <instructions>", async () => {
  const h = makeHarness();
  load(h.pi);
  const result = await h.tools
    .get("self_compact")
    .execute("tool-1", { instructions: "focus on the current bead implementation" }, null, null, {});
  assert.equal(h.userMessages[0].message, "/compact focus on the current bead implementation");
  assert.equal(result.details.queued, true);
});

test("dry-run reports the command without queuing", async () => {
  const h = makeHarness();
  load(h.pi);
  const result = await h.tools.get("self_compact").execute("tool-1", { dryRun: true }, null, null, {});
  assert.equal(h.userMessages.length, 0);
  assert.equal(result.details.queued, false);
  assert.equal(result.details.dryRun, true);
  assert.match(result.content[0].text, /Would queue `\/compact`/);
});

test("rate-limit skips a second self-compaction within the minimum interval", async () => {
  let clock = 1_000_000;
  const h = makeHarness();
  load(h.pi, { now: () => clock });
  const tool = h.tools.get("self_compact");

  const first = await tool.execute("t1", {}, null, null, {});
  assert.equal(first.details.queued, true);
  assert.equal(h.userMessages.length, 1);

  clock += 5_000; // 5s later — within the 30s default window
  const second = await tool.execute("t2", {}, null, null, {});
  assert.equal(second.details.queued, false);
  assert.equal(second.details.reason, "rate_limited");
  assert.equal(h.userMessages.length, 1, "no second /compact should be queued");

  clock += 30_000; // now well past the window
  const third = await tool.execute("t3", {}, null, null, {});
  assert.equal(third.details.queued, true);
  assert.equal(h.userMessages.length, 2);
});

test("dry-run is not rate-limited and does not consume the window", async () => {
  let clock = 0;
  const h = makeHarness();
  load(h.pi, { now: () => clock });
  const tool = h.tools.get("self_compact");
  await tool.execute("t1", { dryRun: true }, null, null, {});
  await tool.execute("t2", { dryRun: true }, null, null, {});
  // A real queue right after dry-runs must still succeed.
  const real = await tool.execute("t3", {}, null, null, {});
  assert.equal(real.details.queued, true);
  assert.equal(h.userMessages.length, 1);
});

test("session_compact event advances the rate-limit reference point", async () => {
  let clock = 0;
  const h = makeHarness();
  load(h.pi, { now: () => clock });
  const tool = h.tools.get("self_compact");

  clock = 10_000;
  h.emit("session_compact", {}); // a real compaction happened at t=10s
  clock = 20_000; // 10s after the compaction — still within the 30s window
  const blocked = await tool.execute("t1", {}, null, null, {});
  assert.equal(blocked.details.queued, false, "should be rate-limited relative to the actual compaction");
  assert.equal(h.userMessages.length, 0);
});

test("missing sendUserMessage is reported, not thrown", async () => {
  const h = makeHarness();
  delete h.pi.sendUserMessage;
  load(h.pi);
  const result = await h.tools.get("self_compact").execute("t1", {}, null, null, {});
  assert.equal(result.details.queued, false);
  assert.equal(result.details.reason, "unsupported");
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
