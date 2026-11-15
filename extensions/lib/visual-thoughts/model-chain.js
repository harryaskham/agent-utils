// Visual thoughts: prompt models in turn. Any one model may be gone (withdrawn, a seat without
// it, an outage) or answer nothing (a reasoning model that spent its tokens thinking): the next
// is asked, and the one that let us down is passed over for a while.

/** How long a model that failed (or answered nothing) is passed over. */
export const MODEL_REST_MS = 10 * 60_000;

/**
 * `run(models, ask, { usable })` asks `ask(model)` for each model in order, passing over those
 * resting, and resolves the first reply `usable` accepts (default: any non-blank text); a model
 * that throws or answers unusably rests MODEL_REST_MS. When every model is resting, each is
 * asked anyway, in order. Rejects with the last error. One chain per process: rest is shared.
 */
export function createModelChain({ now = () => Date.now() } = {}) {
  const resting = new Map(); // model → until
  let lastModel = "";
  async function run(models, ask, { signal, usable = (text) => Boolean(String(text ?? "").trim()) } = {}) {
    const list = [...new Set((models || []).map((model) => String(model).trim()).filter(Boolean))];
    if (!list.length) throw new Error("no prompt model");
    const at = now();
    const awake = list.filter((model) => !(resting.get(model) > at));
    let lastError = null;
    for (const model of awake.length ? awake : list) {
      try {
        const reply = await ask(model);
        if (usable(reply)) {
          resting.delete(model);
          lastModel = model;
          return reply;
        }
        lastError = new Error(`prompt model ${model} answered nothing`);
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
      }
      if (signal?.aborted) throw lastError || new Error("aborted");
      resting.set(model, now() + MODEL_REST_MS);
    }
    throw lastError || new Error("no prompt model answered");
  }
  return {
    run,
    /** The model that answered last. */
    get lastModel() { return lastModel; },
    /** Models passed over now, and until when. */
    resting: () => Object.fromEntries([...resting].filter(([, until]) => until > now())),
  };
}

/** "passed over: a 7 min, b 2 min", or "" when none rest. */
export function describeResting(resting, now = Date.now()) {
  const entries = Object.entries(resting || {});
  if (!entries.length) return "";
  return `passed over (failed or answered nothing): ${entries.map(([model, until]) => `${model} ${Math.max(1, Math.ceil((until - now) / 60_000))} min`).join(", ")}`;
}

/**
 * The prompt models to ask, in order: `promptModel`'s Pi models (provider/id) where the host has
 * Pi's model registry, and its `litellm/<model>` entries anywhere; with none of those (a pi-client
 * pane, no registry), `clientPromptModel`'s chat models on the OpenAI-compatible endpoint.
 */
export function promptModelsFor(config, hasRegistry) {
  const own = modelList(config?.promptModel).filter((ref) => ref.startsWith("litellm/") || (hasRegistry && ref.indexOf("/") > 0));
  return own.length ? own : modelList(config?.clientPromptModel).map((model) => `litellm/${model}`);
}

/** "a (of a, b, c, in turn)", or just "a" when it is the only one. */
export function describePromptModels(models, lastModel = "") {
  const shown = (model) => String(model).replace(/^litellm\//, "") + (String(model).startsWith("litellm/") ? " (LiteLLM)" : "");
  if (models.length <= 1) return shown(models[0] || "none");
  return `${shown(lastModel && models.includes(lastModel) ? lastModel : models[0])} (of ${models.map(shown).join(", ")}, in turn)`;
}

function modelList(setting) {
  const list = Array.isArray(setting) ? setting : String(setting ?? "").split(/[\s,]+/);
  return [...new Set(list.map((model) => String(model).trim()).filter(Boolean))];
}
