import test from "node:test";
import assert from "node:assert/strict";

import contextUsageExtension from "../extensions/context-usage.js";
import {
  getContextUsage,
  normalizeContextUsage,
  formatContextUsage,
  readContextUsage,
} from "../extensions/lib/context-usage.js";

// bd-78ac4f: agents cannot see their own context usage, so compaction
// decisions are guesses. This exposes the figure Pi already tracks.
function makeHarness() {
  const tools = new Map();
  const pi = {
    registerTool(definition) {
      tools.set(definition.name, definition);
    },
  };
  return { pi, tools };
}

function run(tools, ctx) {
  return tools.get("context_usage").execute("call-1", {}, null, null, ctx);
}

test("context_usage reports tokens, window, percent and remaining", async () => {
  const h = makeHarness();
  contextUsageExtension(h.pi);
  const ctx = { getContextUsage: () => ({ tokens: 120_000, contextWindow: 200_000, percent: 60 }) };
  const result = await run(h.tools, ctx);
  assert.equal(result.details.available, true);
  assert.equal(result.details.tokens, 120_000);
  assert.equal(result.details.contextWindow, 200_000);
  assert.equal(result.details.percent, 60);
  assert.equal(result.details.remaining, 80_000);
  assert.match(result.content[0].text, /60\.0% used/);
});

test("context_usage degrades gracefully when the runtime lacks the API", async () => {
  const h = makeHarness();
  contextUsageExtension(h.pi);
  const result = await run(h.tools, {});
  assert.equal(result.details.available, false);
  assert.match(result.content[0].text, /unavailable/);
});

test("readContextUsage tolerates a throwing accessor", () => {
  // A throwing accessor must not take down the calling tool.
  const usage = readContextUsage({
    getContextUsage() {
      throw new Error("boom");
    },
  });
  assert.equal(usage, null);
});

test("normalizeContextUsage derives percent when the runtime omits it", () => {
  const usage = normalizeContextUsage({ tokens: 50_000, contextWindow: 200_000 });
  assert.equal(usage.available, true);
  assert.equal(usage.percent, 25);
  assert.equal(usage.remaining, 150_000);
});

test("normalizeContextUsage handles missing/garbage figures without throwing", () => {
  const none = normalizeContextUsage(null);
  assert.equal(none.available, false);
  assert.equal(none.percent, null);

  const garbage = normalizeContextUsage({ tokens: "abc", contextWindow: 0, percent: undefined });
  assert.equal(garbage.available, false);
  // A zero-width window must not produce Infinity/NaN percentages.
  assert.equal(garbage.percent, null);
});

test("formatContextUsage renders a compact human-readable summary", () => {
  const usage = getContextUsage({ getContextUsage: () => ({ tokens: 1_000, contextWindow: 10_000, percent: 10 }) });
  const text = formatContextUsage(usage);
  assert.match(text, /10\.0% used/);
  assert.match(text, /1,000 \/ 10,000 tokens/);
  assert.equal(formatContextUsage(null), "context usage unavailable in this runtime");
});

test("disabled via PI_CONTEXT_USAGE_TOOL=0 registers no tool", () => {
  const prev = process.env.PI_CONTEXT_USAGE_TOOL;
  process.env.PI_CONTEXT_USAGE_TOOL = "0";
  try {
    const h = makeHarness();
    contextUsageExtension(h.pi);
    assert.equal(h.tools.has("context_usage"), false);
  } finally {
    if (prev === undefined) delete process.env.PI_CONTEXT_USAGE_TOOL;
    else process.env.PI_CONTEXT_USAGE_TOOL = prev;
  }
});
