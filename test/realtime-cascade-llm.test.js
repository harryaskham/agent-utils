import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CASCADE_BASE_URL,
  buildChatCompletionUrl,
  buildChatCompletionBody,
  extractReplyText,
  runChatCompletionTurn,
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
