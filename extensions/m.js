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
//
// Agent-callable model switching is a separate authority surface. The
// `selfModelSelection.models` settings list constrains self_set_model and is
// reported by self_list_models. It does not constrain operator-facing `/m`,
// built-in `/model`, startup/session restore, or self_get_model.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const M_USAGE = "Usage: /m <provider/model> — switch to any model (tab-completes the full list).";

// Default cap on completion items so very large registries stay responsive.
export const M_COMPLETION_LIMIT = 50;

/** Expand `~` in the small set of settings paths this extension owns. */
function expandHome(path) {
  const text = String(path ?? "");
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return join(homedir(), text.slice(2));
  return text;
}

function readJson(path) {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Distinguish an absent file (undefined) from one that exists but cannot be
    // trusted (null). The latter becomes a deny-all layer below.
    return null;
  }
}

/**
 * Extract `selfModelSelection.models` from one settings object.
 *
 * Returns undefined when the slice is absent (legacy unrestricted behavior),
 * and an array otherwise. A present but malformed value becomes an empty
 * array, deliberately denying self-switches instead of broadening authority.
 * The agentUtils namespace is accepted as a compatibility alias, while the
 * operator-requested top-level key takes precedence.
 */
export function extractSelfModelReferences(settings) {
  if (!settings || typeof settings !== "object") return undefined;
  const direct = settings.selfModelSelection;
  const namespaced = settings.agentUtils?.selfModelSelection;
  const slice = direct && typeof direct === "object" ? direct : namespaced;
  if (!slice || typeof slice !== "object" || !("models" in slice)) return undefined;
  if (!Array.isArray(slice.models)) return [];
  return [...new Set(slice.models.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

/** Does one configured reference permit a concrete model? */
export function referenceAllowsModel(reference, model) {
  const configured = String(reference ?? "").trim().toLowerCase();
  if (!configured) return false;
  if (configured.includes("/")) return modelLabel(model).toLowerCase() === configured;
  return String(model?.id ?? "").trim().toLowerCase() === configured;
}

/**
 * Build the self-selection policy over concrete registry models.
 *
 * Every configured layer is a ceiling: project settings may narrow a global
 * whitelist but cannot broaden it. Bare ids (e.g. `gpt-5.6-sol`) permit that
 * id on any provider; use canonical `provider/id` to pin a provider.
 */
export function buildSelfModelPolicy(models, layers = []) {
  const allModels = Array.isArray(models) ? models : [];
  const configuredLayers = [];
  for (const layer of Array.isArray(layers) ? layers : []) {
    const references = extractSelfModelReferences(layer?.settings);
    if (references !== undefined) {
      configuredLayers.push({ source: String(layer?.source ?? "settings"), references });
    }
  }

  const configured = configuredLayers.length > 0;
  const selectable = configured
    ? allModels.filter((model) =>
        configuredLayers.every((layer) =>
          layer.references.some((reference) => referenceAllowsModel(reference, model)),
        ),
      )
    : allModels;
  const seen = new Set();
  const deduped = selectable.filter((model) => {
    const label = modelLabel(model);
    if (!label || seen.has(label)) return false;
    seen.add(label);
    return true;
  });

  const unresolved = configuredLayers.flatMap((layer) =>
    layer.references
      .filter((reference) => !allModels.some((model) => referenceAllowsModel(reference, model)))
      .map((reference) => ({ source: layer.source, reference })),
  );

  return {
    configured,
    models: deduped,
    layers: configuredLayers,
    unresolved,
  };
}

/** Load global + trusted-project-style settings files for the current cwd. */
export function loadSelfModelPolicy(ctx, { env = process.env, cwd = ctx?.cwd || process.cwd(), settings } = {}) {
  const models = listAvailableModels(ctx?.modelRegistry);
  if (settings !== undefined) {
    return buildSelfModelPolicy(models, [{ source: "injected", settings }]);
  }
  const globalDir = expandHome(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  const layer = (path) => {
    const settingsFromDisk = readJson(path);
    return {
      source: path,
      // Existing-but-unreadable settings fail closed for self-selection. Pi
      // reports malformed settings separately; this extension must not turn a
      // parse failure into broader agent authority.
      settings:
        settingsFromDisk === null
          ? { selfModelSelection: { models: [] } }
          : settingsFromDisk,
    };
  };
  const layers = [layer(join(globalDir, "settings.json")), layer(join(cwd, ".pi", "settings.json"))];
  return buildSelfModelPolicy(models, layers);
}

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

export async function switchModelReference(
  pi,
  ctx,
  reference,
  { notifyResult = true, selectionPolicy } = {},
) {
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

  if (
    selectionPolicy?.configured &&
    !selectionPolicy.models.some((allowed) => modelLabel(allowed) === modelLabel(model))
  ) {
    const allowed = selectionPolicy.models.map(modelLabel);
    const configured = selectionPolicy.layers.flatMap((layer) => layer.references);
    const suffix = allowed.length
      ? ` Self-selectable models: ${allowed.join(", ")}.`
      : ` No available model matches the configured selfModelSelection.models list (${configured.join(", ") || "empty"}).`;
    const message = `Self-selection policy does not allow ${modelLabel(model)}.${suffix} The active model is unchanged.`;
    if (notifyResult) notify(ctx, message, "warning");
    return {
      ok: false,
      code: "model_not_allowed",
      message,
      model,
      allowed,
      configured,
    };
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

export default function mCommandExtension(pi, options = {}) {
  // getArgumentCompletions receives only the prefix (no ctx), so capture the
  // registry from session_start for completion listing. The handler always has
  // ctx.modelRegistry directly, so switching works even before this is set.
  let completionRegistry = null;

  const policyFor = (ctx) =>
    typeof options.loadSelectionPolicy === "function"
      ? options.loadSelectionPolicy(ctx)
      : loadSelfModelPolicy(ctx, {
          settings: options.settings,
          env: options.env,
          cwd: options.cwd ?? ctx?.cwd,
        });

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
      const selectionPolicy = policyFor(ctx);
      const result = await switchModelReference(pi, ctx, params?.model, {
        notifyResult: true,
        selectionPolicy,
      });
      return {
        content: [{ type: "text", text: result.message }],
        details: { ...result, selectionPolicy },
      };
    },
  });

  pi.registerTool?.({
    name: "self_get_model",
    label: "Self Get Model",
    description:
      "Report this agent session's active model and whether it is self-selectable. The active model may be outside the self-selection whitelist.",
    promptSnippet: "Inspect this agent session's current model without changing it.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const selectionPolicy = policyFor(ctx);
      const currentModel = ctx?.model;
      const current = modelLabel(currentModel) || "unknown";
      const selectable = Boolean(
        currentModel &&
          (!selectionPolicy.configured ||
            selectionPolicy.models.some((model) => modelLabel(model) === modelLabel(currentModel))),
      );
      const message = selectionPolicy.configured
        ? `Model: ${current} (self-selectable: ${selectable ? "yes" : "no"})`
        : `Model: ${current} (self-selection unrestricted)`;
      return {
        content: [{ type: "text", text: message }],
        details: {
          currentModel: current,
          selectable,
          configured: selectionPolicy.configured,
          layers: selectionPolicy.layers,
        },
      };
    },
  });

  pi.registerTool?.({
    name: "self_list_models",
    label: "Self List Models",
    description:
      "List models this agent is permitted to select itself under settings.json selfModelSelection.models. This does not restrict the model selected by the operator or session startup.",
    promptSnippet: "List models this agent may self-select under the configured whitelist.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const selectionPolicy = policyFor(ctx);
      const labels = selectionPolicy.models.map(modelLabel);
      const heading = selectionPolicy.configured
        ? `Self-selectable models (${labels.length})`
        : `Self-selectable models (${labels.length}, unrestricted)`;
      const unresolved = selectionPolicy.unresolved.length
        ? `\nUnresolved configured references: ${selectionPolicy.unresolved
            .map((item) => `${item.reference} [${item.source}]`)
            .join(", ")}`
        : "";
      const text = `${heading}:\n${labels.length ? labels.map((label) => `- ${label}`).join("\n") : "- (none)"}${unresolved}`;
      return {
        content: [{ type: "text", text }],
        details: {
          models: labels,
          configured: selectionPolicy.configured,
          layers: selectionPolicy.layers,
          unresolved: selectionPolicy.unresolved,
        },
      };
    },
  });
}
