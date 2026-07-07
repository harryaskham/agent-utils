// Shared "run one Pi inference turn from an extension" helper (bd-f50e0f).
//
// The pattern — resolve auth for a model via ctx.modelRegistry.getApiKeyAndHeaders,
// guard it, call pi-ai `complete(model, { systemPrompt, messages }, { apiKey,
// headers, signal, maxTokens })`, then extract the reply text from
// response.content — was re-derived independently in kitty-image-preview.js
// (describeImageFile), tendril-share.js (describeImageData), and
// realtime-cascade-llm.js. Consolidating it here removes the subtle
// re-implementation risks (the stopReason==="aborted" check, the array-content
// flattening, the auth guard shape).
//
// pi-ai `complete` is a host-provided peer dependency that is not resolvable
// under bare `node --test` (bd-4c80c0), so it is imported lazily / injectable —
// this module keeps a dependency-free top level and stays import-testable.

/// Extract the assistant reply text from a Pi `complete` response
/// ({ content: [{ type: "text", text }] }). Non-text parts are ignored; missing
/// or non-array content yields "". Pure.
export function extractPiText(response) {
  const parts = response?.content;
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((c) => c?.type === "text")
    .map((c) => c?.text || "")
    .join("\n")
    .trim();
}

/// System prompt shared by the vision-describe callers (kitty + tendril image
/// description). Exported so those sites converge on one string.
export const VISION_DESCRIBE_SYSTEM_PROMPT =
  "You are a precise visual description assistant. Return only objective visual observations.";

/// Resolve the pi-ai `complete` implementation: use the injected one if given,
/// else lazily import it from the host runtime. Tests inject, so the dynamic
/// import is never hit under `node --test`.
export async function resolvePiComplete(completeImpl) {
  if (typeof completeImpl === "function") return completeImpl;
  const mod = await import("@earendil-works/pi-ai");
  return mod.complete;
}

/// Run one Pi inference turn and return { text, model, usage, stopReason }.
///
/// - `model` is required (callers resolve it however they like; e.g. a vision
///   model). Auth is fetched via `ctx.modelRegistry.getApiKeyAndHeaders(model)`
///   and guarded with the same shape the describe callers used.
/// - `messages` are passed through verbatim (so multimodal image content works).
/// - `completeImpl` is injectable for tests; otherwise pi-ai `complete` is
///   lazily imported.
/// - Rejects with `abortedMessage` if the turn aborts.
export async function runPiTextTurn(ctx, {
  model,
  systemPrompt,
  messages,
  maxTokens,
  signal,
  completeImpl,
  abortedMessage = "Pi inference turn aborted.",
} = {}) {
  if (!model) throw new Error("runPiTextTurn: no model available");
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }
  const complete = await resolvePiComplete(completeImpl);
  const response = await complete(
    model,
    { systemPrompt, messages },
    { apiKey: auth.apiKey, headers: auth.headers, signal, maxTokens },
  );
  if (response?.stopReason === "aborted") throw new Error(abortedMessage);
  return {
    text: extractPiText(response),
    model: `${model.provider}/${model.id}`,
    usage: response?.usage,
    stopReason: response?.stopReason,
  };
}
