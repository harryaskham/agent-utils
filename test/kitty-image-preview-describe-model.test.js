import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  configuredDescribeModelFromSettings,
  describeModelConfig,
  resolveDescribeModel,
  modelSupportsImage,
} from "../extensions/kitty-image-preview/describe-model.js";
import {
  DEFAULT_DESCRIBE_MODEL,
  FALLBACK_DESCRIBE_MODELS,
} from "../extensions/kitty-image-preview/constants.js";

const vision = (provider, id) => ({ provider, id, input: ["text", "image"] });
const textOnly = (provider, id) => ({ provider, id, input: ["text"] });

function makeCtx(models = []) {
  return {
    model: undefined,
    modelRegistry: {
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    },
  };
}

test("default describe model is github-copilot/claude-opus-4.8 and heads the fallback chain", () => {
  assert.equal(DEFAULT_DESCRIBE_MODEL, "github-copilot/claude-opus-4.8");
  assert.equal(FALLBACK_DESCRIBE_MODELS[0], DEFAULT_DESCRIBE_MODEL);
  // litellm fallback remains last for nodes without any copilot opus registered.
  assert.equal(FALLBACK_DESCRIBE_MODELS.at(-1), "litellm-anthropic/claude-opus-4-7");
});

test("configuredDescribeModelFromSettings reads kittyImagePreview keys only", () => {
  assert.equal(configuredDescribeModelFromSettings({ kittyImagePreview: { describeModel: "a/b" } }), "a/b");
  assert.equal(configuredDescribeModelFromSettings({ agentUtils: { kittyImagePreview: { describeModel: "c/d" } } }), "c/d");
  assert.equal(configuredDescribeModelFromSettings({}), "");
  // kitty path must NOT borrow tendril.* keys (independent pinning).
  assert.equal(configuredDescribeModelFromSettings({ tendril: { describeModel: "x/y" } }), "");
});

test("modelSupportsImage treats missing input array as permissive", () => {
  assert.equal(modelSupportsImage({ provider: "p", id: "m" }), true);
  assert.equal(modelSupportsImage(vision("p", "m")), true);
  assert.equal(modelSupportsImage(textOnly("p", "m")), false);
});

test("describeModelConfig precedence: env > settings > default", () => {
  assert.deepEqual(
    describeModelConfig({ env: {}, settings: {} }),
    { spec: DEFAULT_DESCRIBE_MODEL, source: "default" },
  );
  assert.deepEqual(
    describeModelConfig({ env: {}, settings: { kittyImagePreview: { describeModel: "github-copilot/claude-opus-4.7" } } }),
    { spec: "github-copilot/claude-opus-4.7", source: "settings.json" },
  );
  assert.deepEqual(
    describeModelConfig({
      env: { KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL: "litellm-anthropic/claude-opus-4-7" },
      settings: { kittyImagePreview: { describeModel: "github-copilot/claude-opus-4.7" } },
    }),
    { spec: "litellm-anthropic/claude-opus-4-7", source: "KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL" },
  );
});

test("resolveDescribeModel: per-call param wins over env and settings", () => {
  const ctx = makeCtx([vision("github-copilot", "claude-opus-4.8"), vision("litellm-anthropic", "claude-opus-4-7")]);
  const r = resolveDescribeModel(ctx, {
    params: { describeModel: "litellm-anthropic/claude-opus-4-7" },
    env: { KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL: "github-copilot/claude-opus-4.8" },
    settings: { kittyImagePreview: { describeModel: "github-copilot/claude-opus-4.8" } },
  });
  assert.equal(r.model.provider, "litellm-anthropic");
  assert.equal(r.model.id, "claude-opus-4-7");
  assert.equal(r.source, "param");
});

test("resolveDescribeModel: default resolves to github-copilot/claude-opus-4.8", () => {
  const ctx = makeCtx([vision("github-copilot", "claude-opus-4.8")]);
  const r = resolveDescribeModel(ctx, { params: {}, env: {}, settings: {} });
  assert.equal(r.model.provider, "github-copilot");
  assert.equal(r.model.id, "claude-opus-4.8");
  assert.equal(r.source, "default");
});

test("resolveDescribeModel: settings.json override resolves", () => {
  const ctx = makeCtx([vision("github-copilot", "claude-opus-4.7")]);
  const r = resolveDescribeModel(ctx, {
    params: {},
    env: {},
    settings: { agentUtils: { kittyImagePreview: { describeModel: "github-copilot/claude-opus-4.7" } } },
  });
  assert.equal(r.model.id, "claude-opus-4.7");
  assert.equal(r.source, "settings.json");
});

test("resolveDescribeModel: default falls back when 4.8 is not registered", () => {
  // Only an older copilot opus id present; default chain should find it.
  const ctx = makeCtx([vision("github-copilot", "claude-opus-4-7")]);
  const r = resolveDescribeModel(ctx, { params: {}, env: {}, settings: {} });
  assert.equal(r.model.id, "claude-opus-4-7");
  assert.equal(r.source, "default");
});

test("resolveDescribeModel: explicitly configured but unregistered model throws", () => {
  const ctx = makeCtx([vision("github-copilot", "claude-opus-4.8")]);
  assert.throws(
    () => resolveDescribeModel(ctx, { params: {}, env: { KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL: "nope/missing" }, settings: {} }),
    /not registered/,
  );
});

test("resolveDescribeModel: text-only param model is rejected", () => {
  const ctx = makeCtx([textOnly("github-copilot", "gpt-5.5")]);
  assert.throws(
    () => resolveDescribeModel(ctx, { params: { describeModel: "github-copilot/gpt-5.5" }, env: {}, settings: {} }),
    /image input/,
  );
});

test("resolveDescribeModel: no registered default throws a tried-list error", () => {
  const ctx = makeCtx([]);
  assert.throws(
    () => resolveDescribeModel(ctx, { params: {}, env: {}, settings: {} }),
    /No default kitty image preview vision model is registered/,
  );
});

test("describeModelConfig reads PI_CODING_AGENT_DIR/settings.json from disk when settings omitted", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kip-describe-"));
  try {
    await writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ kittyImagePreview: { describeModel: "github-copilot/claude-opus-4.7" } }),
      "utf8",
    );
    assert.deepEqual(
      describeModelConfig({ env: { PI_CODING_AGENT_DIR: dir } }),
      { spec: "github-copilot/claude-opus-4.7", source: "settings.json" },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
