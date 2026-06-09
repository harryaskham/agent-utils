import test from "node:test";
import assert from "node:assert/strict";

import {
  parseFallbackModels,
  modelCandidates,
  isModelUnavailableError,
} from "../extensions/web-search-models.js";

const DEFAULT_FALLBACKS = ["gpt-5.3-codex", "gpt-5.5", "gpt-5.4"];

test("parseFallbackModels falls back to defaults for empty/blank input", () => {
  assert.deepEqual(parseFallbackModels(undefined), DEFAULT_FALLBACKS);
  assert.deepEqual(parseFallbackModels(""), DEFAULT_FALLBACKS);
  assert.deepEqual(parseFallbackModels("   "), DEFAULT_FALLBACKS);
  assert.deepEqual(parseFallbackModels(",, ,"), DEFAULT_FALLBACKS);
});

test("parseFallbackModels parses and trims a comma-separated override", () => {
  assert.deepEqual(parseFallbackModels("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(parseFallbackModels("only-one"), ["only-one"]);
});

test("modelCandidates puts the requested/default model first, then fallbacks, deduped", () => {
  const config = { model: "gpt-5.3-codex", fallbackModels: ["gpt-5.5", "gpt-5.4"] };
  // No explicit request: default first.
  assert.deepEqual(modelCandidates(config), ["gpt-5.3-codex", "gpt-5.5", "gpt-5.4"]);
  // Explicit request goes first.
  assert.deepEqual(modelCandidates(config, "gpt-5.4"), ["gpt-5.4", "gpt-5.3-codex", "gpt-5.5"]);
  // Duplicate request (already in fallbacks) is not repeated.
  assert.deepEqual(modelCandidates(config, "gpt-5.5"), ["gpt-5.5", "gpt-5.3-codex", "gpt-5.4"]);
});

test("modelCandidates ignores blank/whitespace entries", () => {
  const config = { model: "  ", fallbackModels: ["", "  ", "gpt-5.5"] };
  assert.deepEqual(modelCandidates(config, "gpt-5.3-codex"), ["gpt-5.3-codex", "gpt-5.5"]);
});

test("isModelUnavailableError matches only model-availability 400s", () => {
  // Real Copilot error shapes that should trigger a model fallback.
  assert.equal(
    isModelUnavailableError(400, 'The requested model is not available for integrator "vscode-chat".'),
    true,
  );
  assert.equal(isModelUnavailableError(400, '{"error":{"code":"model_not_supported"}}'), true);
  assert.equal(isModelUnavailableError(400, '{"error":{"code":"unsupported_api_for_model"}}'), true);
  assert.equal(isModelUnavailableError(400, "model gpt-4.1 is not supported via Responses API."), true);

  // Non-model 400s and non-400s should NOT trigger a fallback.
  assert.equal(isModelUnavailableError(400, "invalid input: query too long"), false);
  assert.equal(isModelUnavailableError(401, "unauthorized"), false);
  assert.equal(isModelUnavailableError(429, "rate limited"), false);
  assert.equal(isModelUnavailableError(500, "internal error"), false);
});
