import assert from "node:assert/strict";
import test from "node:test";

import effortExtension, {
  EFFORT_LEVELS,
  formatEffortStatus,
  normalizeEffortLevel,
} from "../extensions/effort.js";

function makeHarness({ initialLevel = "medium", clamp, model = { provider: "test-provider", id: "reasoning-model", reasoning: true }, models = [] } = {}) {
  let thinkingLevel = initialLevel;
  const commands = new Map();
  const notifications = [];
  const registryModels = [model, ...models];
  const ctx = {
    model,
    modelRegistry: {
      find(provider, id) {
        return registryModels.find((candidate) => candidate.provider === provider && candidate.id === id) || null;
      },
    },
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  const pi = {
    get model() { return ctx.model; },
    registerCommand(name, definition) { commands.set(name, definition); },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level) { thinkingLevel = clamp ? clamp(level) : level; },
    supportsThinking() { return true; },
    async setModel(next) { ctx.model = next; return true; },
  };
  effortExtension(pi);
  return { pi, commands, notifications, ctx, get thinkingLevel() { return thinkingLevel; } };
}

test("effort helpers validate and render supported thinking levels", () => {
  assert.deepEqual(EFFORT_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"]);
  assert.equal(normalizeEffortLevel("HIGH"), "high");
  assert.equal(normalizeEffortLevel(" adaptive "), "adaptive");
  assert.equal(normalizeEffortLevel(" minimal "), "minimal");
  assert.equal(normalizeEffortLevel("max"), undefined);
  assert.match(formatEffortStatus({ current: "low", supportsThinking: false }), /Current effort: low/);
  assert.match(formatEffortStatus({ current: "low", supportsThinking: false }), /effective effort is off/);
  assert.match(formatEffortStatus({ current: "low" }), /off, minimal, low, medium, high, xhigh, adaptive/);
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

test("/effort delegates every supported level to Pi core, including adaptive", async () => {
  const harness = makeHarness({ initialLevel: "low" });
  await harness.commands.get("effort").handler("adaptive", harness.ctx);

  assert.equal(harness.thinkingLevel, "adaptive");
  assert.equal(harness.pi.agentUtilsEffort.getLevel(harness.ctx), "adaptive");
  assert.equal(harness.pi.agentUtilsEffort.isAdaptive(harness.ctx), true);
  assert.equal(harness.notifications.at(-1).level, "info");
  assert.match(harness.notifications.at(-1).message, /Effort: adaptive/);

  await harness.commands.get("effort").handler("high", harness.ctx);
  assert.equal(harness.thinkingLevel, "high");
  assert.equal(harness.pi.agentUtilsEffort.isAdaptive(harness.ctx), false);
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

test("/fast toggles only between model ids with and without -fast suffix", async () => {
  const base = { provider: "test-provider", id: "reasoning-model", reasoning: true };
  const fast = { provider: "test-provider", id: "reasoning-model-fast", reasoning: true };
  const harness = makeHarness({ initialLevel: "high", model: base, models: [fast] });
  await harness.commands.get("fast").handler("", harness.ctx);
  assert.equal(harness.ctx.model, fast);
  assert.equal(harness.thinkingLevel, "high");
  assert.match(harness.notifications.at(-1).message, /Fast mode on: selected test-provider\/reasoning-model-fast/);

  await harness.commands.get("fast").handler("off", harness.ctx);
  assert.equal(harness.ctx.model, base);
  assert.match(harness.notifications.at(-1).message, /Fast mode off: selected test-provider\/reasoning-model/);
});

test("/fast reports missing -fast counterpart instead of changing effort", async () => {
  const harness = makeHarness({ model: { provider: "test-provider", id: "plain-model", reasoning: false } });
  await harness.commands.get("fast").handler("on", harness.ctx);
  assert.equal(harness.notifications.at(-1).level, "warning");
  assert.match(harness.notifications.at(-1).message, /no plain-model-fast counterpart/);
});
