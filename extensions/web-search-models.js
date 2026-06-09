// Pure model-selection helpers for the web-search extension, extracted so they
// can be unit-tested without importing the extension entrypoint (which pulls in
// the Pi-runtime-only `@sinclair/typebox` dependency). No I/O, no module state.

export const DEFAULT_MODEL = "gpt-5.3-codex";

// Ordered fallbacks tried when the configured/requested model is unavailable
// (e.g. retired by the Copilot integrator). All verified to support the
// Responses API web_search tool. Keeps web search working through a model
// retirement instead of hard-failing.
export const DEFAULT_FALLBACK_MODELS = ["gpt-5.3-codex", "gpt-5.5", "gpt-5.4"];

export function parseFallbackModels(raw) {
  if (typeof raw !== "string" || !raw.trim()) return DEFAULT_FALLBACK_MODELS;
  const list = raw.split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_FALLBACK_MODELS;
}

// Build the ordered, de-duplicated list of models to attempt: the requested
// model first (if any), then the configured default, then the fallbacks. The
// configured default is always a candidate so it is tried even when a specific
// model was requested and is unavailable.
export function modelCandidates(config, requestedModel) {
  const ordered = [requestedModel, config.model, ...config.fallbackModels];
  const seen = new Set();
  const candidates = [];
  for (const model of ordered) {
    const name = typeof model === "string" ? model.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    candidates.push(name);
  }
  return candidates;
}

// True when an error response indicates the requested model is unavailable /
// unsupported (so trying a different model may succeed), rather than an auth,
// rate-limit, or input error (where switching models would not help).
export function isModelUnavailableError(status, body) {
  if (status !== 400) return false;
  return /not available for integrator|model_not_supported|unsupported_api_for_model|is not supported|model is not supported/i.test(
    String(body || ""),
  );
}
