import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import trueDefaultsExtension, { extractTrueDefaults, restoreTrueDefaultSettings } from "../extensions/true-defaults.js";

function makeTempSettings(settings) {
  const dir = mkdtempSync(join(tmpdir(), "agent-utils-true-defaults-"));
  writeFileSync(join(dir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  return dir;
}

function makeHarness({ settings, models = [] } = {}) {
  const dir = makeTempSettings(settings);
  const commands = new Map();
  const handlers = new Map();
  const notifications = [];
  const setModelCalls = [];
  const thinkingCalls = [];
  const registry = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    async setModel(model) { setModelCalls.push(model); return true; },
    setThinkingLevel(level) { thinkingCalls.push(level); },
  };
  const ctx = {
    modelRegistry: { find(provider, id) { return registry.get(`${provider}/${id}`); } },
    ui: { notify(message, level = "info") { notifications.push({ message, level }); } },
  };
  return {
    dir,
    pi,
    ctx,
    commands,
    handlers,
    notifications,
    setModelCalls,
    thinkingCalls,
    readSettings() { return JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")); },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test("extractTrueDefaults supports namespaced and legacy key shapes", () => {
  assert.deepEqual(extractTrueDefaults({
    agentUtils: { trueDefaults: { provider: "litellm-openai", model: "gpt-5.5", thinkingLevel: "HIGH" } },
  }), { provider: "litellm-openai", model: "gpt-5.5", thinkingLevel: "high" });

  assert.deepEqual(extractTrueDefaults({ trueDefaultModel: "litellm-anthropic/claude-sonnet-4-5", trueDefaultEffort: "medium" }), {
    provider: "litellm-anthropic",
    model: "claude-sonnet-4-5",
    thinkingLevel: "medium",
  });

  assert.deepEqual(extractTrueDefaults({ agentUtils: { trueDefaults: { thinkingLevel: "adaptive" } } }), {
    provider: undefined,
    model: undefined,
    thinkingLevel: "adaptive",
  });
});

test("restoreTrueDefaultSettings copies true defaults onto built-in defaults without changing trueDefault keys", () => {
  const dir = makeTempSettings({
    defaultProvider: "old-provider",
    defaultModel: "old-model",
    defaultThinkingLevel: "low",
    agentUtils: { trueDefaults: { provider: "litellm-openai", model: "gpt-5.5", thinkingLevel: "high" } },
  });
  try {
    const result = restoreTrueDefaultSettings({ env: { PI_CODING_AGENT_DIR: dir } });
    const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));

    assert.equal(result.changed, true);
    assert.equal(settings.defaultProvider, "litellm-openai");
    assert.equal(settings.defaultModel, "gpt-5.5");
    assert.equal(settings.defaultThinkingLevel, "high");
    assert.deepEqual(settings.agentUtils.trueDefaults, { provider: "litellm-openai", model: "gpt-5.5", thinkingLevel: "high" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extension reapplies settings and runtime defaults on session_start", async () => {
  const h = makeHarness({
    settings: {
      defaultProvider: "old-provider",
      defaultModel: "old-model",
      defaultThinkingLevel: "low",
      trueDefaultProvider: "litellm-openai",
      trueDefaultModel: "gpt-5.5",
      trueDefaultThinkingLevel: "high",
    },
    models: [{ provider: "litellm-openai", id: "gpt-5.5" }],
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    trueDefaultsExtension(h.pi);
    await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);

    assert.equal(h.readSettings().defaultProvider, "litellm-openai");
    assert.equal(h.readSettings().defaultModel, "gpt-5.5");
    assert.equal(h.readSettings().defaultThinkingLevel, "high");
    assert.deepEqual(h.setModelCalls, [{ provider: "litellm-openai", id: "gpt-5.5" }]);
    assert.deepEqual(h.thinkingCalls, ["high"]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    h.cleanup();
  }
});

test("adaptive true default is persisted but not passed to core setThinkingLevel", async () => {
  const h = makeHarness({
    settings: {
      defaultThinkingLevel: "medium",
      agentUtils: { trueDefaults: { thinkingLevel: "adaptive" } },
    },
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    trueDefaultsExtension(h.pi);
    await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);

    assert.equal(h.readSettings().defaultThinkingLevel, "adaptive");
    assert.deepEqual(h.thinkingCalls, []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    h.cleanup();
  }
});

test("session_shutdown restores persisted defaults after runtime settings drift", async () => {
  const h = makeHarness({
    settings: {
      defaultProvider: "litellm-openai",
      defaultModel: "gpt-5.5",
      defaultThinkingLevel: "medium",
      agentUtils: { trueDefaults: { provider: "litellm-openai", model: "gpt-5.5", thinkingLevel: "medium" } },
    },
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    trueDefaultsExtension(h.pi);
    const drifted = h.readSettings();
    drifted.defaultProvider = "other";
    drifted.defaultModel = "other-model";
    drifted.defaultThinkingLevel = "off";
    writeFileSync(join(h.dir, "settings.json"), `${JSON.stringify(drifted, null, 2)}\n`);

    await h.handlers.get("session_shutdown")({ reason: "quit" }, h.ctx);

    assert.equal(h.readSettings().defaultProvider, "litellm-openai");
    assert.equal(h.readSettings().defaultModel, "gpt-5.5");
    assert.equal(h.readSettings().defaultThinkingLevel, "medium");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    h.cleanup();
  }
});

test("runtime model changes remain possible because true-defaults does not intercept setModel", async () => {
  const h = makeHarness({
    settings: { trueDefaultProvider: "litellm-openai", trueDefaultModel: "gpt-5.5" },
    models: [{ provider: "litellm-openai", id: "gpt-5.5" }],
  });
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = h.dir;
  try {
    trueDefaultsExtension(h.pi);
    await h.pi.setModel({ provider: "litellm-anthropic", id: "claude-sonnet-4-5" });

    assert.deepEqual(h.setModelCalls, [{ provider: "litellm-anthropic", id: "claude-sonnet-4-5" }]);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    h.cleanup();
  }
});

test("project settings with true defaults override global settings source", () => {
  const globalDir = makeTempSettings({
    defaultProvider: "global-old",
    trueDefaultProvider: "global-provider",
  });
  const cwd = mkdtempSync(join(tmpdir(), "agent-utils-true-defaults-project-"));
  const projectDir = join(cwd, ".pi");
  mkdirSync(projectDir);
  writeFileSync(join(projectDir, "settings.json"), JSON.stringify({
    defaultProvider: "project-old",
    trueDefaultProvider: "project-provider",
  }, null, 2));
  try {
    const result = restoreTrueDefaultSettings({ env: { PI_CODING_AGENT_DIR: globalDir }, cwd });
    const projectSettings = JSON.parse(readFileSync(join(projectDir, "settings.json"), "utf8"));
    const globalSettings = JSON.parse(readFileSync(join(globalDir, "settings.json"), "utf8"));

    assert.equal(result.scope, "project");
    assert.equal(projectSettings.defaultProvider, "project-provider");
    assert.equal(globalSettings.defaultProvider, "global-old");
  } finally {
    rmSync(globalDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
