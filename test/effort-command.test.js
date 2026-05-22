import assert from "node:assert/strict";
import test from "node:test";

import effortExtension, {
  EFFORT_LEVELS,
  formatEffortStatus,
  normalizeEffortLevel,
} from "../extensions/effort.js";

function makeHarness({ initialLevel = "medium", clamp } = {}) {
  let thinkingLevel = initialLevel;
  const commands = new Map();
  const notifications = [];
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level) { thinkingLevel = clamp ? clamp(level) : level; },
    supportsThinking() { return true; },
  };
  const ctx = {
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  effortExtension(pi);
  return { commands, notifications, ctx, get thinkingLevel() { return thinkingLevel; } };
}

test("effort helpers validate and render supported thinking levels", () => {
  assert.deepEqual(EFFORT_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.equal(normalizeEffortLevel("HIGH"), "high");
  assert.equal(normalizeEffortLevel(" minimal "), "minimal");
  assert.equal(normalizeEffortLevel("max"), undefined);
  assert.match(formatEffortStatus({ current: "low", supportsThinking: false }), /Current effort: low/);
  assert.match(formatEffortStatus({ current: "low", supportsThinking: false }), /effective effort is off/);
  assert.match(formatEffortStatus({ current: "low" }), /off, minimal, low, medium, high, xhigh/);
});

test("/effort with no args reports current level and accepted values", async () => {
  const { commands, notifications, ctx } = makeHarness({ initialLevel: "low" });
  await commands.get("effort").handler("", ctx);

  assert.equal(notifications.at(-1).level, "info");
  assert.match(notifications.at(-1).message, /Current effort: low/);
  assert.match(notifications.at(-1).message, /Usage: \/effort/);
});

test("/effort status is an explicit status alias", async () => {
  const { commands, notifications, ctx } = makeHarness({ initialLevel: "high" });
  await commands.get("effort").handler("status", ctx);

  assert.equal(notifications.at(-1).level, "info");
  assert.match(notifications.at(-1).message, /Current effort: high/);
});

test("/effort sets Pi thinking level through the runtime API", async () => {
  const harness = makeHarness({ initialLevel: "low" });
  await harness.commands.get("effort").handler("high", harness.ctx);

  assert.equal(harness.thinkingLevel, "high");
  assert.equal(harness.notifications.at(-1).level, "info");
  assert.match(harness.notifications.at(-1).message, /Effort: high/);
});

test("/effort reports model clamping when requested level is not effective", async () => {
  const harness = makeHarness({ initialLevel: "off", clamp: () => "off" });
  await harness.commands.get("effort").handler("high", harness.ctx);

  assert.equal(harness.thinkingLevel, "off");
  assert.equal(harness.notifications.at(-1).level, "info");
  assert.match(harness.notifications.at(-1).message, /requested high; clamped/);
});

test("/effort rejects unsupported levels without changing state", async () => {
  const harness = makeHarness({ initialLevel: "medium" });
  await harness.commands.get("effort").handler("turbo", harness.ctx);

  assert.equal(harness.thinkingLevel, "medium");
  assert.equal(harness.notifications.at(-1).level, "warning");
  assert.match(harness.notifications.at(-1).message, /Unsupported effort level: turbo/);
});
