import test from "node:test";
import assert from "node:assert/strict";

import {
  parseFallbackModels,
  modelCandidates,
  isModelUnavailableError,
} from "../extensions/web-search-models.js";
import {
  combineTimeoutSignal,
  resolveRequestTimeoutMs,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../extensions/web-search-http.js";

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

test("resolveRequestTimeoutMs parses positive ints and falls back otherwise (bd-6cf0d6)", () => {
  assert.equal(resolveRequestTimeoutMs("5000"), 5000);
  assert.equal(resolveRequestTimeoutMs(undefined), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs(""), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs("0"), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs("-3"), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs("abc"), DEFAULT_REQUEST_TIMEOUT_MS);
  assert.equal(resolveRequestTimeoutMs("nope", 42), 42);
});

test("combineTimeoutSignal: the timeout aborts the fetch signal and flags isTimeout (bd-6cf0d6)", () => {
  let fire = null;
  const setTimer = (fn) => { fire = fn; return 7; };
  let cleared = null;
  const clearTimer = (h) => { cleared = h; };
  const t = combineTimeoutSignal(null, 1000, { setTimer, clearTimer });
  assert.equal(t.signal.aborted, false);
  assert.equal(t.isTimeout(), false);
  fire(); // simulate the timeout firing
  assert.equal(t.signal.aborted, true, "timeout aborts the fetch signal");
  assert.equal(t.isTimeout(), true, "isTimeout discriminates a timeout from a cancel");
  t.cleanup();
  assert.equal(cleared, 7, "cleanup clears the timer");
});

test("combineTimeoutSignal: an incoming cancel forwards but is NOT flagged as a timeout (bd-6cf0d6)", () => {
  const incoming = new AbortController();
  const t = combineTimeoutSignal(incoming.signal, 1000, { setTimer: () => 1, clearTimer: () => {} });
  assert.equal(t.signal.aborted, false);
  incoming.abort();
  assert.equal(t.signal.aborted, true, "incoming cancel forwards to the fetch signal");
  assert.equal(t.isTimeout(), false, "a user cancel is not a timeout");
});

test("combineTimeoutSignal: an already-aborted incoming signal aborts immediately (bd-6cf0d6)", () => {
  const incoming = new AbortController();
  incoming.abort();
  const t = combineTimeoutSignal(incoming.signal, 1000, { setTimer: () => 1, clearTimer: () => {} });
  assert.equal(t.signal.aborted, true);
  assert.equal(t.isTimeout(), false);
});

test("combineTimeoutSignal: no timer is scheduled when the timeout is non-positive (bd-6cf0d6)", () => {
  let scheduled = 0;
  const t = combineTimeoutSignal(null, 0, { setTimer: () => { scheduled++; return 1; }, clearTimer: () => {} });
  assert.equal(scheduled, 0, "no timer for a 0/disabled timeout");
  assert.equal(t.signal.aborted, false);
  t.cleanup();
});
