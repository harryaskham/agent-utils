import assert from "node:assert/strict";
import test from "node:test";

import mCommandExtension, {
  M_USAGE,
  buildModelCompletions,
  listAvailableModels,
  modelLabel,
  resolveModelReference,
  extractSelfModelReferences,
  referenceAllowsModel,
  buildSelfModelPolicy,
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

function makeHarness({
  models = MODELS,
  setModelResult = true,
  withRegistry = true,
  currentModel = MODELS[0],
  settings = {},
} = {}) {
  const notifications = [];
  const commands = new Map();
  const tools = new Map();
  const events = new Map();
  const ctx = {
    modelRegistry: makeRegistry(models),
    model: currentModel,
    cwd: "/work/project",
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  let activeModel = currentModel;
  const pi = {
    on(event, handler) { events.set(event, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    registerTool(definition) { tools.set(definition.name, definition); },
    async setModel(model) {
      if (setModelResult) {
        activeModel = model;
        ctx.model = model;
      }
      return setModelResult;
    },
  };
  mCommandExtension(pi, { settings });
  // Simulate session_start so completion registry is captured.
  if (withRegistry) events.get("session_start")?.({}, ctx);
  return {
    pi, ctx, commands, tools, notifications, events,
    get currentModel() { return activeModel; },
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

test("extractSelfModelReferences accepts top-level and namespaced settings and fails closed", () => {
  assert.deepEqual(
    extractSelfModelReferences({ selfModelSelection: { models: ["gpt-5.6-sol", " gpt-5.6-sol ", ""] } }),
    ["gpt-5.6-sol"],
  );
  assert.deepEqual(
    extractSelfModelReferences({ agentUtils: { selfModelSelection: { models: ["openai/gpt-5.5"] } } }),
    ["openai/gpt-5.5"],
  );
  assert.equal(extractSelfModelReferences({}), undefined);
  assert.deepEqual(extractSelfModelReferences({ selfModelSelection: { models: "not-an-array" } }), []);
});

test("bare whitelist ids permit matching ids while canonical references pin providers", () => {
  assert.equal(referenceAllowsModel("gpt-5.5", MODELS[2]), true);
  assert.equal(referenceAllowsModel("gpt-5.5", MODELS[3]), true);
  assert.equal(referenceAllowsModel("github-copilot/gpt-5.5", MODELS[2]), true);
  assert.equal(referenceAllowsModel("github-copilot/gpt-5.5", MODELS[3]), false);
});

test("project self-model settings can narrow but cannot broaden a global whitelist", () => {
  const policy = buildSelfModelPolicy(MODELS, [
    { source: "global", settings: { selfModelSelection: { models: ["gpt-5.5"] } } },
    { source: "project", settings: { selfModelSelection: { models: ["github-copilot/gpt-5.5", "gemini-3.5-flash"] } } },
  ]);
  assert.equal(policy.configured, true);
  assert.deepEqual(policy.models.map(modelLabel), ["github-copilot/gpt-5.5"]);
});

test("empty or unresolved configured whitelist denies every self-switch", () => {
  const empty = buildSelfModelPolicy(MODELS, [
    { source: "global", settings: { selfModelSelection: { models: [] } } },
  ]);
  assert.deepEqual(empty.models, []);

  const unresolved = buildSelfModelPolicy(MODELS, [
    { source: "global", settings: { selfModelSelection: { models: ["does-not-exist"] } } },
  ]);
  assert.deepEqual(unresolved.models, []);
  assert.deepEqual(unresolved.unresolved, [{ source: "global", reference: "does-not-exist" }]);
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

test("self_set_model enforces selfModelSelection.models and leaves model unchanged when denied", async () => {
  const h = makeHarness({
    settings: { selfModelSelection: { models: ["gemini-3.5-flash"] } },
  });
  const tool = h.tools.get("self_set_model");

  const denied = await tool.execute(
    "tool-denied",
    { model: "github-copilot/gpt-5.5" },
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(denied.details.ok, false);
  assert.equal(denied.details.code, "model_not_allowed");
  assert.equal(h.currentModel, MODELS[0], "denied switch must not change the active model");
  assert.match(denied.content[0].text, /does not allow github-copilot\/gpt-5.5/);

  const allowed = await tool.execute(
    "tool-allowed",
    { model: "github-copilot/gemini-3.5-flash" },
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(allowed.details.ok, true);
  assert.equal(h.currentModel, MODELS[4]);
});

test("operator-facing /m remains unrestricted by selfModelSelection policy", async () => {
  const h = makeHarness({
    settings: { selfModelSelection: { models: ["gemini-3.5-flash"] } },
  });
  await h.commands.get("m").handler("openai/gpt-5.5", h.ctx);
  assert.equal(h.currentModel, MODELS[3]);
});

test("self_get_model reports an active model outside the whitelist without changing it", async () => {
  const h = makeHarness({
    currentModel: MODELS[0],
    settings: { selfModelSelection: { models: ["gemini-3.5-flash"] } },
  });
  const result = await h.tools.get("self_get_model").execute(
    "tool-get",
    {},
    undefined,
    undefined,
    h.ctx,
  );
  assert.equal(result.details.currentModel, "anthropic/claude-opus-4-7");
  assert.equal(result.details.selectable, false);
  assert.match(result.content[0].text, /self-selectable: no/);
  assert.equal(h.currentModel, MODELS[0]);
});

test("self_list_models returns only concrete models permitted by the whitelist", async () => {
  const h = makeHarness({
    settings: { selfModelSelection: { models: ["gpt-5.5"] } },
  });
  const result = await h.tools.get("self_list_models").execute(
    "tool-list",
    {},
    undefined,
    undefined,
    h.ctx,
  );
  assert.deepEqual(result.details.models, [
    "github-copilot/gpt-5.5",
    "openai/gpt-5.5",
  ]);
  assert.match(result.content[0].text, /Self-selectable models \(2\)/);
});

test("self model inspection tools are registered with strict empty parameter objects", () => {
  const h = makeHarness();
  for (const name of ["self_get_model", "self_list_models"]) {
    const tool = h.tools.get(name);
    assert.ok(tool, `${name} is registered`);
    assert.deepEqual(tool.parameters.required, undefined);
    assert.equal(tool.parameters.additionalProperties, false);
  }
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
