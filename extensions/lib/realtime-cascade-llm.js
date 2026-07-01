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

// ---------------------------------------------------------------------------
// Pi built-in inference path (bd-15beec)
//
// For an UNPINNED cascade peer (n=1 = "just talk to the model loaded in Pi"),
// route the turn through Pi's own inference engine (`complete`) on the loaded
// ctx model instead of a raw chat-completions POST to a possibly-unservable
// default model (which produced `chat completions 400: no healthy deployments
// for ...`). Auth is Pi's own: ctx.modelRegistry.getApiKeyAndHeaders(model), so
// e.g. github-copilot models reuse Pi's Copilot token. Pure helpers below are
// unit-tested; `complete` is injected for tests.
// ---------------------------------------------------------------------------

/// Convert OpenAI chat-completions messages ({role, content:string|parts}) into
/// Pi inference messages ({role, timestamp, content:[{type:"text", text}]}).
/// Non-assistant/system roles collapse to "user"; array content is flattened to
/// text. Pure.
export function piMessagesFromChat(messages, now = Date.now) {
  const at = typeof now === "function" ? now : () => now;
  return (Array.isArray(messages) ? messages : []).map((m) => {
    const role = m?.role === "assistant" || m?.role === "system" ? m.role : "user";
    let text;
    if (typeof m?.content === "string") {
      text = m.content;
    } else if (Array.isArray(m?.content)) {
      text = m.content
        .map((p) => (typeof p === "string" ? p : (p?.text || p?.content || "")))
        .join("");
    } else {
      text = "";
    }
    return { role, timestamp: at(), content: [{ type: "text", text: String(text) }] };
  });
}

/// Extract the assistant reply text from a Pi `complete` response
/// ({content:[{type:"text", text}]}). Pure.
export function extractPiReplyText(response) {
  const parts = response?.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((c) => c?.type === "text")
    .map((c) => c?.text || "")
    .join("\n")
    .trim();
}

/// Run one cascade peer turn through Pi's built-in inference and resolve with the
/// reply text. Rejects if no loaded model / no auth key, or if the turn aborts.
/// `completeImpl` is injectable for tests; defaults to pi-ai `complete`.
export async function runPiInferenceTurn({
  messages,
  model,
  auth,
  completeImpl,
  systemPrompt,
  maxTokens = 200,
  signal,
} = {}) {
  let run = completeImpl;
  if (typeof run !== "function") {
    // pi-ai `complete` is a peer dep provided by the Pi host at runtime and is
    // not resolvable from bare unit tests, so load it lazily. Tests always
    // inject `completeImpl`, so this dynamic import is never hit under test.
    ({ complete: run } = await import("@earendil-works/pi-ai"));
  }
  if (typeof run !== "function") throw new Error("runPiInferenceTurn: no complete implementation available");
  if (!model) throw new Error("runPiInferenceTurn: no loaded model available");
  if (!auth || !auth.apiKey) throw new Error(auth?.error || `runPiInferenceTurn: no API key for ${model?.provider || "model"}`);
  const opts = { apiKey: auth.apiKey, headers: auth.headers };
  if (signal) opts.signal = signal;
  const mt = Number(maxTokens);
  if (Number.isFinite(mt) && mt > 0) opts.maxTokens = mt;
  const req = { messages: piMessagesFromChat(messages) };
  if (systemPrompt) req.systemPrompt = String(systemPrompt);
  const response = await run(model, req, opts);
  if (response?.stopReason === "aborted") throw new Error("cascade Pi inference turn aborted");
  return extractPiReplyText(response);
}
