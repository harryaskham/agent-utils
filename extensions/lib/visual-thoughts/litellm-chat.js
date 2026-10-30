// Visual thoughts: the prompt model over an OpenAI-compatible chat endpoint (LiteLLM), for hosts
// without Pi's model registry (pi-client runs extensions without the agent's process).

/** The reply text of one chat completion for a prompt request ({ systemPrompt, messages, maxTokens }). */
export async function litellmChat({ model, request, signal, baseUrl, apiKey, fetchImpl = globalThis.fetch }) {
  const base = String(baseUrl || "http://localhost:4000").replace(/\/+$/, "").replace(/\/v1$/, "");
  const text = (message) => (Array.isArray(message.content) ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : String(message.content ?? ""));
  const response = await fetchImpl(`${base}/v1/chat/completions`, {
    method: "POST",
    signal,
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
