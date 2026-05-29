import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import effortExtension, {
  EFFORT_LEVELS,
  formatEffortStatus,
  normalizeEffortLevel,
  configuredDefaultEffort,
  patchAdaptiveThinkingPayload,
  supportsAdaptiveThinkingModel,
} from "../extensions/effort.js";

function makeHarness({ initialLevel = "medium", clamp, model = { provider: "github-copilot", id: "arbitrary-adaptive-model", reasoning: true, thinkingLevelMap: { xhigh: "max" } }, models = [], settings = {} } = {}) {
  let thinkingLevel = initialLevel;
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const registryModels = [model, ...models];
  const dir = mkdtempSync(join(tmpdir(), "agent-utils-effort-harness-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
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
    on(name, handler) { handlers.set(name, handler); },
    getThinkingLevel() { return thinkingLevel; },
    setThinkingLevel(level) { thinkingLevel = clamp ? clamp(level) : level; },
    supportsThinking() { return true; },
    async setModel(next) { ctx.model = next; return true; },
  };
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    effortExtension(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
  return { pi, commands, handlers, notifications, ctx, get thinkingLevel() { return thinkingLevel; } };
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

test("configuredDefaultEffort reads adaptive from true-default settings", () => {
  assert.equal(configuredDefaultEffort({ agentUtils: { trueDefaults: { thinkingLevel: "adaptive" } } }), "adaptive");
  assert.equal(configuredDefaultEffort({ trueDefaultEffort: "ADAPTIVE" }), "adaptive");
  assert.equal(configuredDefaultEffort({ defaultThinkingLevel: "adaptive" }), "adaptive");
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

test("effort extension exposes adaptive state for status/footer integrations", async () => {
  const harness = makeHarness({ initialLevel: "medium" });
  assert.equal(harness.pi.agentUtilsEffort.getLevel(harness.ctx), "medium");
  await harness.commands.get("effort").handler("adaptive", harness.ctx);
  assert.equal(harness.pi.agentUtilsEffort.getLevel(harness.ctx), "adaptive");
  assert.equal(harness.pi.agentUtilsEffort.isAdaptive(), true);
  await harness.commands.get("effort").handler("high", harness.ctx);
  assert.equal(harness.pi.agentUtilsEffort.getLevel(harness.ctx), "high");
  assert.equal(harness.pi.agentUtilsEffort.isAdaptive(), false);
});

test("adaptive true default enables adaptive payload rewrite on session start", async () => {
  const harness = makeHarness({
    initialLevel: "medium",
    settings: { agentUtils: { trueDefaults: { thinkingLevel: "adaptive" } } },
  });
  await harness.handlers.get("session_start")?.({}, harness.ctx);
  const payload = harness.handlers.get("before_provider_request")({ payload: { thinking: { type: "enabled", budget_tokens: 2048 } } }, harness.ctx);
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(payload.output_config.effort, "medium");
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

test("fast flag does not alter adaptive thinking payloads", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { id: "plain-reasoning-model", reasoning: true }, level: "high", fast: true },
  );
  assert.equal(payload.output_config, undefined);
});

test("github-copilot Opus 4.8 avoids unsupported low effort even without refreshed model metadata", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { provider: "github-copilot", id: "claude-opus-4.8", reasoning: true }, level: "low", adaptive: true },
  );
  assert.equal(payload.output_config.effort, "medium");
});

test("supported output_config efforts alone do not require adaptive thinking", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { provider: "github-copilot", id: "claude-opus-4.8", reasoning: true }, level: "medium" },
  );
  assert.deepEqual(payload, { thinking: { type: "enabled", budget_tokens: 1024 } });
});

test("fast-suffixed models do not require adaptive thinking", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024 } },
    { model: { provider: "github-copilot", id: "claude-opus-4.8-fast", reasoning: true }, level: "medium" },
  );
  assert.deepEqual(payload, { thinking: { type: "enabled", budget_tokens: 1024 } });
});

test("model compat can require adaptive thinking for arbitrary ids", () => {
  const payload = patchAdaptiveThinkingPayload(
    { thinking: { type: "enabled", budget_tokens: 1024, display: "full" } },
    { model: { id: "custom-adaptive-id", reasoning: true, compat: { thinkingFormat: "adaptive" } }, level: "high" },
  );
  assert.deepEqual(payload.thinking, { type: "adaptive", display: "full" });
  assert.equal(payload.output_config.effort, "high");
});

test("/fast toggles only between model ids with and without -fast suffix", async () => {
  const base = { provider: "github-copilot", id: "claude-opus-4.8", reasoning: true };
  const fast = { provider: "github-copilot", id: "claude-opus-4.8-fast", reasoning: true };
  const harness = makeHarness({ initialLevel: "high", model: base, models: [fast] });
  await harness.commands.get("fast").handler("", harness.ctx);
  assert.equal(harness.ctx.model, fast);
  assert.equal(harness.thinkingLevel, "high");
  assert.match(harness.notifications.at(-1).message, /Fast mode on: selected github-copilot\/claude-opus-4\.8-fast/);

  const payload = harness.handlers.get("before_provider_request")({ payload: { thinking: { type: "enabled", budget_tokens: 2048 } } }, harness.ctx);
  assert.notEqual(payload.output_config?.effort, "low");

  await harness.commands.get("fast").handler("off", harness.ctx);
  assert.equal(harness.ctx.model, base);
  assert.match(harness.notifications.at(-1).message, /Fast mode off: selected github-copilot\/claude-opus-4\.8/);
});

test("/fast reports missing -fast counterpart instead of changing effort", async () => {
  const harness = makeHarness({ model: { provider: "github-copilot", id: "gpt-5.5", reasoning: false } });
  await harness.commands.get("fast").handler("on", harness.ctx);
  assert.equal(harness.notifications.at(-1).level, "warning");
  assert.match(harness.notifications.at(-1).message, /no gpt-5\.5-fast counterpart/);
});
