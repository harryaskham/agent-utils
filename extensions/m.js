// Pi extension: `/m <provider/model>` — switch to any model, ignoring scope.
//
// Pi's built-in `/model` command and Ctrl+P cycling are governed by the
// scoped-models feature: when models are scoped (e.g. via `enabledModels`),
// `/model <arg>` only resolves against the scoped set, so switching to an
// arbitrary model means opening the selector and toggling the "all" scope.
//
// This extension adds an independent `/m <reference>` command that always
// resolves against the FULL model registry (never the scoped set) and
// switches immediately, with tab-completion over every available
// provider/model string. It deliberately does not touch `/model` or
// `/scoped-models`; scoped-models keeps governing Ctrl+P cycling only.

export const M_USAGE = "Usage: /m <provider/model> — switch to any model (tab-completes the full list).";

// Default cap on completion items so very large registries stay responsive.
export const M_COMPLETION_LIMIT = 50;

function notify(ctx, message, level = "info") {
  ctx?.ui?.notify?.(message, level);
}

/** Canonical "provider/id" label for a model-like object. */
export function modelLabel(model) {
  const provider = String(model?.provider ?? "").trim();
  const id = String(model?.id ?? "").trim();
  if (provider && id) return `${provider}/${id}`;
  return id || provider || "";
}

/**
 * Read the full set of models from a registry-like object, ignoring any
 * scoped/enabled-models filtering. Tries refresh()+getAvailable() first
 * (matches Pi core), then falls back to getAll(). Always returns an array.
 */
export function listAvailableModels(registry) {
  if (!registry || typeof registry !== "object") return [];
  try {
    if (typeof registry.refresh === "function") registry.refresh();
  } catch {
    // refresh is best-effort; fall through to reads below
  }
  for (const method of ["getAvailable", "getAll"]) {
    if (typeof registry[method] === "function") {
      try {
        const models = registry[method]();
        if (Array.isArray(models) && models.length > 0) return models;
      } catch {
        // try the next accessor
      }
    }
  }
  // Last resort: a plain array of models on the registry-like object.
  if (Array.isArray(registry.models)) return registry.models;
  return [];
}

/**
 * Resolve a model reference string against a model list. Mirrors Pi core's
 * exact-match semantics: canonical "provider/id", then provider+id split,
 * then a bare id when it is unambiguous. Returns the model or undefined.
 */
export function resolveModelReference(reference, models) {
  const trimmed = String(reference ?? "").trim();
  if (!trimmed || !Array.isArray(models) || models.length === 0) return undefined;
  const normalized = trimmed.toLowerCase();

  const canonical = models.filter((model) => modelLabel(model).toLowerCase() === normalized);
  if (canonical.length === 1) return canonical[0];
  if (canonical.length > 1) return undefined;

  const slash = trimmed.indexOf("/");
  if (slash !== -1) {
    const provider = trimmed.slice(0, slash).trim().toLowerCase();
    const id = trimmed.slice(slash + 1).trim().toLowerCase();
    if (provider && id) {
      const matches = models.filter(
        (model) =>
          String(model?.provider ?? "").toLowerCase() === provider &&
          String(model?.id ?? "").toLowerCase() === id,
      );
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return undefined;
    }
  }

  const idMatches = models.filter((model) => String(model?.id ?? "").toLowerCase() === normalized);
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

/**
 * Build tab-completion items for the `/m` argument from the full model list.
 * Every whitespace-separated token in the prefix must appear (case-insensitive
 * substring) in the model's "provider/id" string, so "opus anthropic" matches
 * "anthropic/claude-opus-4-7". Canonical-prefix matches sort first.
 */
export function buildModelCompletions(models, prefix, limit = M_COMPLETION_LIMIT) {
  if (!Array.isArray(models) || models.length === 0) return [];
  const tokens = String(prefix ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  const items = [];
  const seen = new Set();
  for (const model of models) {
    const label = modelLabel(model);
    if (!label) continue;
    const haystack = label.toLowerCase();
    if (tokens.length > 0 && !tokens.every((token) => haystack.includes(token))) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    items.push({
      value: label,
      label: String(model?.id ?? label),
      description: String(model?.provider ?? ""),
    });
  }

  const head = tokens.join(" ");
  items.sort((a, b) => {
    const av = a.value.toLowerCase();
    const bv = b.value.toLowerCase();
    if (head) {
      const aStarts = av.startsWith(head) ? 0 : 1;
      const bStarts = bv.startsWith(head) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
    }
    return av.localeCompare(bv);
  });

  return Number.isFinite(limit) && limit > 0 ? items.slice(0, limit) : items;
}

export async function switchModelReference(pi, ctx, reference, { notifyResult = true } = {}) {
  const trimmed = String(reference ?? "").trim();
  const models = listAvailableModels(ctx?.modelRegistry);

  if (!trimmed) {
    const count = models.length;
    const message = `${M_USAGE}${count ? ` ${count} model${count === 1 ? "" : "s"} available — press Tab to browse.` : ""}`;
    if (notifyResult) notify(ctx, message, "info");
    return { ok: false, code: "missing_model", message };
  }

  if (typeof pi.setModel !== "function") {
    const message = "This Pi runtime does not expose model switching controls; update Pi or use /model.";
    if (notifyResult) notify(ctx, message, "error");
    return { ok: false, code: "unsupported_runtime", message };
  }

  const model = resolveModelReference(trimmed, models);
  if (!model) {
    const suggestions = buildModelCompletions(models, trimmed, 5)
      .map((item) => item.value)
      .join(", ");
    const hint = suggestions ? ` Did you mean: ${suggestions}?` : " Press Tab to browse available models.";
    const message = `No model matches "${trimmed}".${hint} ${M_USAGE}`;
    if (notifyResult) notify(ctx, message, "warning");
    return { ok: false, code: "model_not_found", message, suggestions };
  }

  const ok = await pi.setModel(model);
  if (!ok) {
    const message = `Failed to switch model: could not select ${modelLabel(model)}.`;
    if (notifyResult) notify(ctx, message, "error");
    return { ok: false, code: "set_model_failed", message, model };
  }

  const message = `Model: ${modelLabel(model)}`;
  if (notifyResult) notify(ctx, message, "info");
  return { ok: true, code: "model_set", message, model };
}

export default function mCommandExtension(pi) {
  // getArgumentCompletions receives only the prefix (no ctx), so capture the
  // registry from session_start for completion listing. The handler always has
  // ctx.modelRegistry directly, so switching works even before this is set.
  let completionRegistry = null;

  pi.on?.("session_start", (_event, ctx) => {
    if (ctx?.modelRegistry) completionRegistry = ctx.modelRegistry;
  });

  pi.registerCommand?.("m", {
    description: "Switch to any model regardless of scope. Usage: /m <provider/model> (tab-completes the full list).",
    getArgumentCompletions: (prefix) => {
      const models = listAvailableModels(completionRegistry);
      const items = buildModelCompletions(models, prefix);
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      await switchModelReference(pi, ctx, args, { notifyResult: true });
    },
  });

  pi.registerTool?.({
    name: "self_set_model",
    label: "Self Set Model",
    description: "Set this agent session's active model. Agents should use this only when explicitly instructed by the operator; it is not for autonomous self-tuning.",
    promptSnippet: "Set this agent's model only after explicit operator instruction.",
    parameters: {
      type: "object",
      required: ["model"],
      properties: {
        model: {
          type: "string",
          description: "Model reference to select, usually provider/model. Use this only when the operator explicitly instructed this agent to switch models.",
        },
      },
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await switchModelReference(pi, ctx, params?.model, { notifyResult: true });
      return {
        content: [{ type: "text", text: result.message }],
        details: result,
      };
    },
  });
}
