// Cascade peer LLM turn: run one OpenAI-compatible chat-completions request and
// return the reply text (bd-7c6790). This is the concrete `runTurn` dep that
// realtime-cascade.js's runCascadeRound calls for each PEER participant (the main
// agent's turn is driven by the Pi session itself). Pure URL/body/parse helpers
// plus a thin fetch-injected request, so it is unit-tested without the network.
//
// Defaults come from the same env the realtime extension already uses
// (OPENAI_BASE_URL / PI_RT_BASE_URL, OPENAI_API_KEY / PI_RT_API_KEY), so cascade
// peers ride the same proxy as the rest of the stack unless a participant pins a
// per-agent model / base url.

import { env } from "./realtime-helpers.js";

export const DEFAULT_CASCADE_BASE_URL = "https://api.openai.com";

/// Build the chat-completions URL from a base. Appends /v1/chat/completions, or
/// just /chat/completions when the base already ends in a /vN version. Pure.
export function buildChatCompletionUrl(baseUrl) {
  let base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!base) base = DEFAULT_CASCADE_BASE_URL;
  if (/\/v\d+$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/// Build the JSON request body for a chat-completions turn. Pure.
export function buildChatCompletionBody({ messages, model, temperature, maxTokens, extra } = {}) {
  const body = { model, messages: messages || [] };
  const t = Number(temperature);
  if (Number.isFinite(t)) body.temperature = t;
  const m = Number(maxTokens);
  if (Number.isFinite(m) && m > 0) body.max_tokens = m;
  return { ...body, ...(extra && typeof extra === "object" ? extra : {}) };
}

/// Extract the assistant reply text from a chat-completions response. Tolerates
/// both string content and the array-of-parts content shape. Pure.
export function extractReplyText(json) {
  const msg = json?.choices?.[0]?.message;
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p) => (typeof p === "string" ? p : (p?.text || p?.content || "")))
      .join("")
      .trim();
  }
  return "";
}

/// Run one chat-completions turn and resolve with the reply text. Rejects on a
/// non-2xx response (carrying a bounded error body) or a transport error.
/// `fetchImpl` is injectable for tests; defaults to global fetch.
export async function runChatCompletionTurn({
  messages,
  model,
  baseUrl,
  apiKey,
  temperature,
  maxTokens,
  extra,
  fetchImpl,
  timeoutMs = 60000,
  envRead = env,
} = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("runChatCompletionTurn: no fetch implementation available");
  const url = buildChatCompletionUrl(baseUrl || envRead("PI_RT_BASE_URL", "OPENAI_BASE_URL"));
  const key = apiKey || envRead("PI_RT_API_KEY", "OPENAI_API_KEY");
  const body = buildChatCompletionBody({ messages, model, temperature, maxTokens, extra });

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => { try { controller.abort(); } catch {} }, timeoutMs)
    : null;
  timer?.unref?.();
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      let errText = "";
      try { errText = await res.text(); } catch {}
      throw new Error(`chat completions ${res.status}${errText ? `: ${String(errText).slice(0, 300)}` : ""}`);
    }
    const json = await res.json();
    return extractReplyText(json);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
