import assert from "node:assert/strict";
import test from "node:test";

import effortExtension, {
  EFFORT_LEVELS,
  formatEffortStatus,
  normalizeEffortLevel,
  patchAdaptiveThinkingPayload,
  supportsAdaptiveThinkingModel,
} from "../extensions/effort.js";

function makeHarness({ initialLevel = "medium", clamp, model = { provider: "github-copilot", id: "arbitrary-adaptive-model", reasoning: true, thinkingLevelMap: { xhigh: "max" } } } = {}) {
  let thinkingLevel = initialLevel;
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const pi = {
    registerCommand(name, definition) { commands.set(name, definition); },
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level) { thinkingLevel = clamp ? clamp(level) : level; },
    supportsThinking() { return true; },
  };
  const ctx = {
    model,
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
    },
  };
  effortExtension(pi);
  return { commands, handlers, notifications, ctx, get thinkingLevel() { return thinkingLevel; } };
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
  assert.equal(supportsAdaptiveThinkingModel({ id: "arbitrary-id", reasoning: true }), true);
  assert.equal(supportsAdaptiveThinkingModel({ id: "claude-opus-4.6", reasoning: false }), false);
  assert.equal(supportsAdaptiveThinkingModel({ id: "gpt-5.5" }), false);
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

test("/effort adaptive enables adaptive payload rewrite without clamping through Pi core", async () => {
  const harness = makeHarness({ initialLevel: "medium" });
  await harness.commands.get("effort").handler("adaptive", harness.ctx);
  assert.equal(harness.thinkingLevel, "medium", "adaptive mode should not call setThinkingLevel with an unsupported core level");
  const payload = harness.handlers.get("before_provider_request")({ payload: { thinking: { type: "enabled", budget_tokens: 2048 } } }, harness.ctx);
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(payload.output_config.effort, "medium");
});

test("adaptive payload rewrite uses model settings instead of id filters", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024, display: "full" } },
    { model: { id: "custom-anything", reasoning: true, thinkingLevelMap: { xhigh: "max" } }, level: "xhigh", adaptive: true },
  );
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "full" });
  assert.equal(payload.output_config.effort, "max");
});

test("adaptive payload rewrite clamps to model-declared output_config.effort values", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { id: "claude-opus-4.8", reasoning: true, supportedOutputConfigEfforts: ["medium"] }, level: "low", adaptive: true },
  );
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(payload.output_config.effort, "medium");
});

test("fast adaptive payloads respect model-declared effort support", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { id: "claude-opus-4.8", reasoning: true, output_config: { efforts: ["medium"] } }, level: "high", fast: true },
  );
  assert.equal(payload.output_config.effort, "medium");
});

test("github-copilot Opus 4.8 avoids unsupported low effort even without refreshed model metadata", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { provider: "github-copilot", id: "claude-opus-4.8", reasoning: true }, level: "low", adaptive: true },
  );
  assert.equal(payload.output_config.effort, "medium");
});

test("/fast toggles adaptive low-effort payloads for supported models", async () => {
  const harness = makeHarness({ initialLevel: "high" });
  await harness.commands.get("fast").handler("", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Fast mode on/);
  const payload = harness.handlers.get("before_provider_request")({ payload: { thinking: { type: "enabled", budget_tokens: 2048 } } }, harness.ctx);
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(payload.output_config.effort, "low");
  await harness.commands.get("fast").handler("off", harness.ctx);
  assert.match(harness.notifications.at(-1).message, /Fast mode off/);
});

test("/fast rejects unsupported models", async () => {
  const harness = makeHarness({ model: { provider: "github-copilot", id: "gpt-5.5", reasoning: false } });
  await harness.commands.get("fast").handler("on", harness.ctx);
  assert.equal(harness.notifications.at(-1).level, "warning");
  assert.match(harness.notifications.at(-1).message, /only available for reasoning-capable models/);
});
