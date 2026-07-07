import test from "node:test";
import assert from "node:assert/strict";

import {
  extractPiText,
  resolvePiComplete,
  runPiTextTurn,
  VISION_DESCRIBE_SYSTEM_PROMPT,
} from "../extensions/lib/pi-inference.js";

test("extractPiText joins text parts and ignores non-text/missing content", () => {
  assert.equal(
    extractPiText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }),
    "a\nb",
  );
  assert.equal(extractPiText({ content: [{ type: "text", text: "  hi  " }] }), "hi");
  assert.equal(extractPiText({}), "");
  assert.equal(extractPiText(null), "");
  assert.equal(extractPiText({ content: "nope" }), "");
});

test("resolvePiComplete returns the injected implementation without importing pi-ai", async () => {
  const fn = () => {};
  assert.equal(await resolvePiComplete(fn), fn);
});

function okCtx(complete) {
  return {
    model: undefined,
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k", headers: { h: "1" } }) },
    _complete: complete,
  };
}

test("runPiTextTurn resolves auth, calls complete with the expected shape, and returns text/model/usage/stopReason", async () => {
  const calls = [];
  const completeImpl = async (model, req, opts) => {
    calls.push({ model, req, opts });
    return { content: [{ type: "text", text: "described" }], usage: { in: 1 }, stopReason: "stop" };
  };
  const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "K", headers: { A: "1" } }) } };
  const model = { provider: "github-copilot", id: "gpt-x" };
  const messages = [{ role: "user", timestamp: 1, content: [{ type: "text", text: "q" }] }];
  const result = await runPiTextTurn(ctx, {
    model,
    systemPrompt: VISION_DESCRIBE_SYSTEM_PROMPT,
    messages,
    maxTokens: 1200,
    signal: undefined,
    completeImpl,
  });
  assert.deepEqual(result, {
    text: "described",
    model: "github-copilot/gpt-x",
    usage: { in: 1 },
    stopReason: "stop",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].model, model);
  assert.deepEqual(calls[0].req, { systemPrompt: VISION_DESCRIBE_SYSTEM_PROMPT, messages });
  assert.deepEqual(calls[0].opts, { apiKey: "K", headers: { A: "1" }, signal: undefined, maxTokens: 1200 });
});

test("runPiTextTurn requires a model", async () => {
  await assert.rejects(
    () => runPiTextTurn({}, { messages: [], completeImpl: async () => ({}) }),
    /no model available/,
  );
});

test("runPiTextTurn surfaces auth.error when auth is not ok", async () => {
  const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false, error: "auth boom" }) } };
  await assert.rejects(
    () => runPiTextTurn(ctx, { model: { provider: "p", id: "m" }, messages: [], completeImpl: async () => ({}) }),
    /auth boom/,
  );
});

test("runPiTextTurn throws a provider-scoped message when ok but no apiKey", async () => {
  const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "" }) } };
  await assert.rejects(
    () => runPiTextTurn(ctx, { model: { provider: "anthropic", id: "m" }, messages: [], completeImpl: async () => ({}) }),
    /No API key for anthropic/,
  );
});

test("runPiTextTurn rejects with the custom abortedMessage on stopReason=aborted", async () => {
  const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } };
  const completeImpl = async () => ({ content: [], stopReason: "aborted" });
  await assert.rejects(
    () => runPiTextTurn(ctx, { model: { provider: "p", id: "m" }, messages: [], completeImpl, abortedMessage: "custom abort" }),
    /custom abort/,
  );
});

test("runPiTextTurn default abortedMessage is generic", async () => {
  const ctx = { modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }) } };
  const completeImpl = async () => ({ content: [], stopReason: "aborted" });
  await assert.rejects(
    () => runPiTextTurn(ctx, { model: { provider: "p", id: "m" }, messages: [], completeImpl }),
    /Pi inference turn aborted/,
  );
});
