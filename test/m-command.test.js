import assert from "node:assert/strict";
import test from "node:test";

import mCommandExtension, {
  M_USAGE,
  buildModelCompletions,
  listAvailableModels,
  modelLabel,
  resolveModelReference,
} from "../extensions/m.js";

const MODELS = [
  { provider: "anthropic", id: "claude-opus-4-7" },
  { provider: "github-copilot", id: "claude-opus-4.8" },
  { provider: "github-copilot", id: "gpt-5.5" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "github-copilot", id: "gemini-3.5-flash" },
];

function makeRegistry(models = MODELS, { scoped = [] } = {}) {
  let refreshed = 0;
  return {
    refreshCount: () => refreshed,
    refresh() { refreshed += 1; },
    // getAvailable returns the FULL list; a scoped subset must never leak here.
    getAvailable() { return models; },
    getAll() { return models; },
    find(provider, id) {
      return models.find((m) => m.provider === provider && m.id === id) || null;
    },
    _scoped: scoped,
  };
}

function makeHarness({ models = MODELS, setModelResult = true, withRegistry = true } = {}) {
  const notifications = [];
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  const ctx = {
    modelRegistry: makeRegistry(models),
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  let currentModel;
  const pi = {
    on(event, handler) { events.set(event, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    async setModel(model) { if (setModelResult) currentModel = model; return setModelResult; },
  };
  mCommandExtension(pi);
  // Simulate session_start so completion registry is captured.
  if (withRegistry) events.get("session_start")?.({}, ctx);
  return {
    pi, ctx, commands, tools, notifications, events,
    get currentModel() { return currentModel; },
    get last() { return notifications.at(-1); },
  };
}

test("modelLabel renders provider/id and tolerates partial input", () => {
  assert.equal(modelLabel({ provider: "openai", id: "gpt-5.5" }), "openai/gpt-5.5");
  assert.equal(modelLabel({ id: "lonely" }), "lonely");
  assert.equal(modelLabel({}), "");
});

test("listAvailableModels reads the full registry and refreshes first", () => {
  const registry = makeRegistry();
  const models = listAvailableModels(registry);
  assert.equal(models.length, MODELS.length);
  assert.equal(registry.refreshCount(), 1);
  assert.deepEqual(listAvailableModels(null), []);
  assert.deepEqual(listAvailableModels({}), []);
});

test("resolveModelReference matches canonical provider/id exactly", () => {
  assert.equal(resolveModelReference("anthropic/claude-opus-4-7", MODELS), MODELS[0]);
  assert.equal(resolveModelReference("ANTHROPIC/Claude-Opus-4-7", MODELS), MODELS[0]);
});

test("resolveModelReference disambiguates duplicate ids by provider", () => {
  // gpt-5.5 exists for both github-copilot and openai; bare id is ambiguous.
  assert.equal(resolveModelReference("gpt-5.5", MODELS), undefined);
  assert.equal(resolveModelReference("openai/gpt-5.5", MODELS), MODELS[3]);
  assert.equal(resolveModelReference("github-copilot/gpt-5.5", MODELS), MODELS[2]);
});

test("resolveModelReference resolves an unambiguous bare id", () => {
  assert.equal(resolveModelReference("gemini-3.5-flash", MODELS), MODELS[4]);
  assert.equal(resolveModelReference("", MODELS), undefined);
  assert.equal(resolveModelReference("nope/nope", MODELS), undefined);
});

test("buildModelCompletions returns full list for empty prefix as provider/id values", () => {
  const items = buildModelCompletions(MODELS, "");
  assert.equal(items.length, MODELS.length);
  for (const item of items) {
    assert.match(item.value, /\//);
    assert.ok(item.label);
    assert.ok("description" in item);
  }
});

test("buildModelCompletions fuzzy-matches across whitespace tokens", () => {
  const items = buildModelCompletions(MODELS, "opus anthropic");
  assert.deepEqual(items.map((i) => i.value), ["anthropic/claude-opus-4-7"]);
});

test("buildModelCompletions sorts canonical-prefix matches first and caps results", () => {
  const items = buildModelCompletions(MODELS, "github-copilot/");
  assert.ok(items.length >= 3);
  for (const item of items.slice(0, 3)) {
    assert.match(item.value, /^github-copilot\//);
  }
  assert.equal(buildModelCompletions(MODELS, "", 2).length, 2);
});

test("/m with no args reports usage and available count", async () => {
  const h = makeHarness();
  await h.commands.get("m").handler("", h.ctx);
  assert.equal(h.last.level, "info");
  assert.match(h.last.message, /Usage: \/m/);
  assert.match(h.last.message, /5 models available/);
});

test("/m switches to an arbitrary model regardless of scope", async () => {
  const h = makeHarness();
  await h.commands.get("m").handler("anthropic/claude-opus-4-7", h.ctx);
  assert.equal(h.currentModel, MODELS[0]);
  assert.equal(h.last.level, "info");
  assert.equal(h.last.message, "Model: anthropic/claude-opus-4-7");
});

test("/m warns with suggestions when no model matches", async () => {
  const h = makeHarness();
  await h.commands.get("m").handler("opus", h.ctx);
  assert.equal(h.last.level, "warning");
  assert.match(h.last.message, /No model matches "opus"/);
  assert.match(h.last.message, /anthropic\/claude-opus-4-7/);
});

test("/m reports a failed switch", async () => {
  const h = makeHarness({ setModelResult: false });
  await h.commands.get("m").handler("openai/gpt-5.5", h.ctx);
  assert.equal(h.last.level, "error");
  assert.match(h.last.message, /Failed to switch model/);
});

test("self_set_model tool switches models and warns it is operator-instructed only", async () => {
  const h = makeHarness();
  const tool = h.tools.get("self_set_model");
  assert.ok(tool, "tool is registered");
  assert.match(tool.description, /only when explicitly instructed by the operator/);
  assert.match(tool.parameters.properties.model.description, /operator explicitly instructed/);

  const result = await tool.execute("tool-1", { model: "github-copilot/gpt-5.5" }, undefined, undefined, h.ctx);
  assert.equal(h.currentModel, MODELS[2]);
  assert.equal(result.details.ok, true);
  assert.equal(result.details.code, "model_set");
  assert.equal(result.content[0].text, "Model: github-copilot/gpt-5.5");
});

test("self_set_model tool returns model resolution errors", async () => {
  const h = makeHarness();
  const result = await h.tools.get("self_set_model").execute("tool-1", { model: "gpt-5.5" }, undefined, undefined, h.ctx);
  assert.equal(result.details.ok, false);
  assert.equal(result.details.code, "model_not_found");
  assert.match(result.content[0].text, /No model matches/);
});

test("/m argument completions use the captured full registry", () => {
  const h = makeHarness();
  const completions = h.commands.get("m").getArgumentCompletions("gemini");
  assert.deepEqual(completions.map((i) => i.value), ["github-copilot/gemini-3.5-flash"]);
  // No matches → null so Pi falls back gracefully.
  assert.equal(h.commands.get("m").getArgumentCompletions("zzzz-none"), null);
});

test("/m completions return null when no registry captured yet", () => {
  const h = makeHarness({ withRegistry: false });
  assert.equal(h.commands.get("m").getArgumentCompletions(""), null);
});

test("M_USAGE documents the command shape", () => {
  assert.match(M_USAGE, /\/m <provider\/model>/);
});
