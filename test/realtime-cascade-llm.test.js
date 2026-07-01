import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CASCADE_BASE_URL,
  buildChatCompletionUrl,
  buildChatCompletionBody,
  extractReplyText,
  runChatCompletionTurn,
  piMessagesFromChat,
  extractPiReplyText,
  runPiInferenceTurn,
} from "../extensions/lib/realtime-cascade-llm.js";

// ---------------------------------------------------------------------------
// buildChatCompletionUrl
// ---------------------------------------------------------------------------

test("buildChatCompletionUrl appends /v1/chat/completions to a bare base", () => {
  assert.equal(buildChatCompletionUrl("http://localhost:4000"), "http://localhost:4000/v1/chat/completions");
  assert.equal(buildChatCompletionUrl("https://api.openai.com/"), "https://api.openai.com/v1/chat/completions");
});

test("buildChatCompletionUrl appends only /chat/completions when the base already ends in /vN", () => {
  assert.equal(buildChatCompletionUrl("http://localhost:4000/v1"), "http://localhost:4000/v1/chat/completions");
  assert.equal(buildChatCompletionUrl("http://x/v2/"), "http://x/v2/chat/completions");
});

test("buildChatCompletionUrl defaults an empty base to the OpenAI host", () => {
  assert.equal(buildChatCompletionUrl(""), `${DEFAULT_CASCADE_BASE_URL}/v1/chat/completions`);
  assert.equal(buildChatCompletionUrl(null), `${DEFAULT_CASCADE_BASE_URL}/v1/chat/completions`);
});

// ---------------------------------------------------------------------------
// buildChatCompletionBody
// ---------------------------------------------------------------------------

test("buildChatCompletionBody carries model + messages and optional tuning", () => {
  const messages = [{ role: "user", content: "hi" }];
  assert.deepEqual(buildChatCompletionBody({ model: "m", messages }), { model: "m", messages });
  assert.deepEqual(
    buildChatCompletionBody({ model: "m", messages, temperature: 0.7, maxTokens: 128 }),
    { model: "m", messages, temperature: 0.7, max_tokens: 128 },
  );
  // invalid/zero tuning omitted
  const b = buildChatCompletionBody({ model: "m", messages, temperature: "x", maxTokens: 0 });
  assert.ok(!("temperature" in b));
  assert.ok(!("max_tokens" in b));
  // extra merged
  assert.equal(buildChatCompletionBody({ model: "m", messages, extra: { stream: false } }).stream, false);
});

// ---------------------------------------------------------------------------
// extractReplyText
// ---------------------------------------------------------------------------

test("extractReplyText handles string content, array-of-parts, and missing", () => {
  assert.equal(extractReplyText({ choices: [{ message: { content: "  hello  " } }] }), "hello");
  assert.equal(
    extractReplyText({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }, "c"] } }] }),
    "abc",
  );
  assert.equal(extractReplyText({}), "");
  assert.equal(extractReplyText({ choices: [{}] }), "");
  assert.equal(extractReplyText(null), "");
});

// ---------------------------------------------------------------------------
// runChatCompletionTurn (injected fetch)
// ---------------------------------------------------------------------------

function okResponse(json) {
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) };
}

test("runChatCompletionTurn posts to the right URL with auth + body and returns the reply", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return okResponse({ choices: [{ message: { content: "the reply" } }] });
  };
  const text = await runChatCompletionTurn({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-x",
    baseUrl: "http://proxy:4000",
    apiKey: "sk-test",
    fetchImpl,
  });
  assert.equal(text, "the reply");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://proxy:4000/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "gpt-x");
  assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
});

test("runChatCompletionTurn falls back to env base/key via injected envRead", async () => {
  const seen = {};
  const fetchImpl = async (url, init) => { seen.url = url; seen.auth = init.headers.Authorization; return okResponse({ choices: [{ message: { content: "ok" } }] }); };
  const envRead = (...keys) => {
    for (const k of keys) {
      if (k === "OPENAI_BASE_URL") return "http://env-proxy:9000";
      if (k === "OPENAI_API_KEY") return "sk-env";
    }
    return undefined;
  };
  await runChatCompletionTurn({ messages: [], model: "m", fetchImpl, envRead });
  assert.equal(seen.url, "http://env-proxy:9000/v1/chat/completions");
  assert.equal(seen.auth, "Bearer sk-env");
});

test("runChatCompletionTurn rejects on a non-2xx response carrying a bounded error body", async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "unauthorized token" });
  await assert.rejects(
    runChatCompletionTurn({ messages: [], model: "m", baseUrl: "http://x", apiKey: "k", fetchImpl }),
    /chat completions 401: unauthorized token/,
  );
});

test("runChatCompletionTurn omits the Authorization header when no key is available", async () => {
  let authPresent = true;
  const fetchImpl = async (_url, init) => { authPresent = "Authorization" in init.headers; return okResponse({ choices: [{ message: { content: "x" } }] }); };
  await runChatCompletionTurn({ messages: [], model: "m", baseUrl: "http://x", apiKey: "", fetchImpl, envRead: () => undefined });
  assert.equal(authPresent, false);
});

// ---------------------------------------------------------------------------
// piMessagesFromChat (bd-15beec)
// ---------------------------------------------------------------------------

test("piMessagesFromChat maps chat messages to Pi text-part messages with a timestamp", () => {
  const out = piMessagesFromChat(
    [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
      { role: "system", content: "be nice" },
    ],
    () => 1234,
  );
  assert.deepEqual(out, [
    { role: "user", timestamp: 1234, content: [{ type: "text", text: "hi" }] },
    { role: "assistant", timestamp: 1234, content: [{ type: "text", text: "yo" }] },
    { role: "system", timestamp: 1234, content: [{ type: "text", text: "be nice" }] },
  ]);
});

test("piMessagesFromChat collapses unknown roles to user and flattens array content", () => {
  const out = piMessagesFromChat(
    [
      { role: "tool", content: "result" },
      { role: "user", content: [{ text: "a" }, "b", { content: "c" }] },
    ],
    () => 0,
  );
  assert.equal(out[0].role, "user");
  assert.equal(out[0].content[0].text, "result");
  assert.equal(out[1].content[0].text, "abc");
});

test("piMessagesFromChat tolerates non-array input and missing content", () => {
  assert.deepEqual(piMessagesFromChat(null), []);
  const out = piMessagesFromChat([{ role: "user" }], () => 0);
  assert.equal(out[0].content[0].text, "");
});

// ---------------------------------------------------------------------------
// extractPiReplyText (bd-15beec)
// ---------------------------------------------------------------------------

test("extractPiReplyText joins text parts, ignores non-text, trims, and tolerates missing", () => {
  assert.equal(
    extractPiReplyText({ content: [{ type: "text", text: "  hello" }, { type: "image", data: "x" }, { type: "text", text: "world  " }] }),
    "hello\nworld",
  );
  assert.equal(extractPiReplyText({ content: [] }), "");
  assert.equal(extractPiReplyText({}), "");
  assert.equal(extractPiReplyText(null), "");
});

// ---------------------------------------------------------------------------
// runPiInferenceTurn (injected complete)
// ---------------------------------------------------------------------------

test("runPiInferenceTurn calls complete with the loaded model, converted messages, auth, and returns the reply", async () => {
  const calls = [];
  const completeImpl = async (model, req, opts) => {
    calls.push({ model, req, opts });
    return { content: [{ type: "text", text: "pi reply" }], stopReason: "stop" };
  };
  const text = await runPiInferenceTurn({
    messages: [{ role: "user", content: "hi" }],
    model: { provider: "github-copilot", id: "claude" },
    auth: { ok: true, apiKey: "k", headers: { "X-H": "1" } },
    completeImpl,
    systemPrompt: "be a peer",
    maxTokens: 123,
  });
  assert.equal(text, "pi reply");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].model, { provider: "github-copilot", id: "claude" });
  assert.equal(calls[0].req.systemPrompt, "be a peer");
  assert.equal(calls[0].req.messages[0].content[0].text, "hi");
  assert.equal(calls[0].opts.apiKey, "k");
  assert.deepEqual(calls[0].opts.headers, { "X-H": "1" });
  assert.equal(calls[0].opts.maxTokens, 123);
});

test("runPiInferenceTurn rejects with no model, no auth key, or an aborted turn", async () => {
  const ok = async () => ({ content: [{ type: "text", text: "x" }] });
  await assert.rejects(
    runPiInferenceTurn({ messages: [], auth: { apiKey: "k" }, completeImpl: ok }),
    /no loaded model/,
  );
  await assert.rejects(
    runPiInferenceTurn({ messages: [], model: { provider: "p" }, auth: { ok: false, error: "nope" }, completeImpl: ok }),
    /nope/,
  );
  await assert.rejects(
    runPiInferenceTurn({ messages: [], model: { provider: "p" }, auth: { apiKey: "k" }, completeImpl: async () => ({ stopReason: "aborted", content: [] }) }),
    /aborted/,
  );
});

test("runPiInferenceTurn omits maxTokens when non-positive", async () => {
  let seen;
  const completeImpl = async (_m, _r, opts) => { seen = opts; return { content: [{ type: "text", text: "x" }] }; };
  await runPiInferenceTurn({ messages: [], model: { provider: "p" }, auth: { apiKey: "k" }, completeImpl, maxTokens: 0 });
  assert.ok(!("maxTokens" in seen));
});
