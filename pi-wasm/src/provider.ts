// pi-wasm S3 (bd-cbf86f) — browser provider / network layer.
//
// Wires pi-ai's OpenAI-compatible ("openai-completions") provider into the
// pi-agent-core `Agent` loop so real streaming model calls run entirely
// client-side, against a CORS-enabled OpenAI-compatible endpoint (the LiteLLM
// proxy by default).
//
// Path A (per FEASIBILITY.md §2/§6 and scratch note `pi-wasm-recon`): build
// directly on `Agent` from @earendil-works/pi-agent-core and inject a
// `streamFn` sourced from @earendil-works/pi-ai — NEVER the node-coupled
// @earendil-works/pi-coding-agent barrel.
//
// Key facts this module relies on (all verified against pi-*@0.80.3):
//   * The public `Agent` uses `options.streamFn` (default: pi-ai global
//     streamSimple) and resolves `options.getApiKey(provider)` once per turn,
//     forwarding the resolved key to the streamFn as `options.apiKey`.
//   * pi-ai's `openAICompletionsApi()` lazily loads the isomorphic `openai`
//     SDK on first stream and constructs
//     `new OpenAI({ apiKey, baseURL: model.baseUrl, dangerouslyAllowBrowser: true })`,
//     using global `fetch` + SSE (no undici, no node HTTP).
//   * The LiteLLM proxy already returns CORS headers on both preflight and the
//     streaming POST, so no proxy change is needed (see FEASIBILITY.md §6).
//
// Runtime keys (S6): the key is supplied via `getApiKey`, never hard-coded.

import { Agent } from "@earendil-works/pi-agent-core";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

/** Default OpenAI-compatible endpoint: the existing LiteLLM proxy (CORS-enabled). */
export const DEFAULT_BASE_URL = "http://100.83.90.42:4000/v1";
export const DEFAULT_MODEL_ID = "gpt-4.1";
export const DEFAULT_PROVIDER_ID = "litellm";

export interface OpenAICompatModelOptions {
  /** Model id as the endpoint knows it (e.g. "gpt-4.1", "gpt-5-mini", "claude-sonnet-5"). */
  modelId?: string;
  /** OpenAI-compatible base URL. The `openai` SDK appends `/chat/completions`. */
  baseUrl?: string;
  /** Logical provider id (grouping key; not sent on the wire). */
  providerId?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * Build a minimal, valid `Model<"openai-completions">` pointed at an
 * OpenAI-compatible endpoint. Cost is zeroed (proxy billing is out of band);
 * downstream slices can enrich this from a real models.json (S6).
 */
export function makeOpenAICompatModel(
  opts: OpenAICompatModelOptions = {},
): Model<"openai-completions"> {
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: opts.providerId ?? DEFAULT_PROVIDER_ID,
    baseUrl: opts.baseUrl ?? DEFAULT_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: opts.contextWindow ?? 128_000,
    maxTokens: opts.maxTokens ?? 4096,
  };
}

/**
 * The injected `streamFn`: pi-ai's openai-completions provider streams.
 *
 * The agent loop calls this with `(model, context, { ...config, apiKey, signal })`
 * where `apiKey` is the value resolved from `getApiKey(model.provider)`. The
 * provider forwards it into the `openai` SDK client, so the runtime key never
 * has to be baked into the model or the source.
 */
export function makeOpenAICompatStreamFn(): StreamFn {
  const provider = openAICompletionsApi();
  return (model, context, options) => provider.streamSimple(model, context, options);
}

export interface BrowserAgentOptions extends OpenAICompatModelOptions {
  /** Runtime key resolver (from the settings screen / localStorage / URL). */
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  systemPrompt?: string;
}

/**
 * Construct a browser-ready `Agent` that streams from an OpenAI-compatible
 * endpoint. This is the S3 deliverable and the provider seam S7 (chat UI) will
 * build the full loop on.
 */
export function createBrowserAgent(opts: BrowserAgentOptions): Agent {
  const model = makeOpenAICompatModel(opts);
  return new Agent({
    initialState: {
      model,
      systemPrompt:
        opts.systemPrompt ??
        "You are a concise assistant running fully in the browser via pi-wasm.",
    },
    streamFn: makeOpenAICompatStreamFn(),
    getApiKey: opts.getApiKey,
  });
}

/**
 * Extract concatenated text from an assistant `AgentMessage` (content is an
 * array of typed blocks; we keep the `text` blocks).
 */
export function messageText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && (b as { type?: unknown }).type === "text",
      )
      .map((b) => b.text)
      .join("");
  }
  return "";
}

/**
 * The current assistant text for live rendering: prefer the in-flight
 * `streamingMessage`, else the last assistant message in the transcript.
 */
export function currentAssistantText(agent: Agent): string {
  const streaming = (agent.state as { streamingMessage?: unknown }).streamingMessage;
  if (streaming) return messageText(streaming);
  const messages = agent.state.messages as Array<{ role?: string }>;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return messageText(messages[i]);
  }
  return "";
}
