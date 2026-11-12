// Visual thoughts: the prompt model over an OpenAI-compatible chat endpoint (LiteLLM), for hosts
// without Pi's model registry (pi-client runs extensions without the agent's process).
import { withTimeout } from "./image-provider.js";

/** The reply text of one chat completion for a prompt request ({ systemPrompt, messages, maxTokens }). */
export async function litellmChat({ model, request, signal, baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  const base = String(baseUrl || "http://localhost:4000").replace(/\/+$/, "").replace(/\/v1$/, "");
  const text = (message) => (Array.isArray(message.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : String(message.content ?? ""));
  const response = await fetchImpl(`${base}/v1/chat/completions`, {
    method: "POST",
    signal: withTimeout(signal, 60_000),
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model,
      max_tokens: request.maxTokens || 160,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: text(message) })),
      ],
    }),
  });
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json())?.error?.message || ""; } catch {}
    throw new Error(`prompt model ${model}: HTTP ${response.status}${detail ? ` ${String(detail).slice(0, 200)}` : ""}`);
  }
  const body = await response.json();
  return String(body?.choices?.[0]?.message?.content ?? "");
}

/** The models of a `clientPromptModel` setting: a comma- or space-separated list, in order. */
export function chatModels(setting) {
  const list = Array.isArray(setting) ? setting : String(setting ?? "").split(/[\s,]+/);
  return [...new Set(list.map((model) => String(model).trim()).filter(Boolean))];
}

/** How long a chat model that failed (or answered nothing) is passed over. */
export const CHAT_MODEL_COOLDOWN_MS = 10 * 60_000;

/**
 * Prompts over the chat endpoint from a list of models: each request tries them in order, and a
 * model that fails or answers nothing is passed over for CHAT_MODEL_COOLDOWN_MS (any one model may
 * be gone: a removed deployment, a seat without it). When every model is cooling down, each is
 * tried anyway, in order. Resolves the first non-empty reply; rejects with the last error.
 */
export function createChatPrompter({ models, baseUrl, apiKey, fetchImpl, now = () => Date.now() } = {}) {
  const resting = new Map(); // model → until
  let lastModel = "";
  /** `options` may name other models (in order), base URL or key for this request. */
  async function prompt(request, signal, options = {}) {
    const list = chatModels(options.models ?? (typeof models === "function" ? models() : models));
    if (!list.length) throw new Error("no prompt model (clientPromptModel)");
    const at = now();
    const awake = list.filter((model) => !(resting.get(model) > at));
    let lastError = null;
    for (const model of awake.length ? awake : list) {
      try {
        const reply = await litellmChat({
          model, request, signal,
          baseUrl: options.baseUrl ?? (typeof baseUrl === "function" ? baseUrl() : baseUrl),
          apiKey: options.apiKey ?? (typeof apiKey === "function" ? apiKey() : apiKey),
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (String(reply).trim()) {
          resting.delete(model);
          lastModel = model;
          return reply;
        }
        lastError = new Error(`prompt model ${model} answered nothing`);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
      resting.set(model, now() + CHAT_MODEL_COOLDOWN_MS);
    }
    throw lastError || new Error("no prompt model answered");
  }
  return {
    prompt,
    /** The model that answered last. */
    get lastModel() { return lastModel; },
    /** Models passed over now, and until when. */
    resting: () => Object.fromEntries([...resting].filter(([, until]) => until > now())),
  };
}
