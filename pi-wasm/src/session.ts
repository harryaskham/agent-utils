// pi-wasm S7 (bd-e8949f) — thin agent-session facade.
//
// Constructs the in-browser Pi agent loop (Path A) and owns one conversation.
// Streaming routes through a single seam that picks the backend per turn:
//   * S3 real provider (makeOpenAICompatStreamFn) when the agent resolved an
//     apiKey for the turn — real LiteLLM streaming.
//   * mock echo (createMockStreamFn) when no key is set — so the shell works
//     out of the box and is Playwright-drivable without a live key.
//
// Seams filled by other slices:
//   * getApiKey  : S6 (bd-4c572a, msm-0) settings screen. Here it's the runtime
//                  key resolver passed in by main.ts (URL / global / localStorage).
//   * model      : S3's makeOpenAICompatModel (LiteLLM / OpenAI-compatible).
//   * tools      : S4 (landed) browser tools over the S2 VFS — wired in a later
//                  step; the thin shell runs tool-free (tools: []).
//
// S11 (bd-0dc0bc, keyed multi-session persistence) will wrap instances of this
// facade — one per keyed session — persisting transcript/state to OPFS/IndexedDB.

import {
  Agent,
  type AgentEvent,
  type AgentState,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { createMockStreamFn } from "./mock-stream.js";
import {
  DEFAULT_MODEL_ID,
  makeOpenAICompatModel,
  makeOpenAICompatStreamFn,
} from "./provider.js";

export interface PiWasmSessionOptions {
  modelId?: string;
  baseUrl?: string;
  /** Logical provider id (must match the settings key that holds the API key). */
  providerId?: string;
  systemPrompt?: string;
  /** Runtime API-key resolver (S6 seam). Return undefined ⇒ mock fallback. */
  getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
  /** File tools (S4) over the VFS (S2). Defaults to none (text-only). */
  tools?: AgentTool[];
}

const DEFAULT_SYSTEM_PROMPT =
  "You are Pi, running fully in the browser (pi-wasm). Be concise and helpful.";

/**
 * Thin wrapper around {@link Agent} that owns one conversation and exposes the
 * minimal surface the chat UI needs.
 */
export class PiWasmSession {
  readonly agent: Agent;
  readonly modelId: string;

  constructor(options: PiWasmSessionOptions) {
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    const realStreamFn = makeOpenAICompatStreamFn();
    const mockStreamFn = createMockStreamFn();

    // The agent resolves getApiKey(provider) once per turn and forwards the
    // value to the streamFn as options.apiKey (see provider.ts). Route to the
    // real provider when a key exists, else the local mock echo.
    const streamFn: StreamFn = (model, context, streamOptions) => {
      const apiKey = (streamOptions as { apiKey?: string } | undefined)?.apiKey;
      return apiKey
        ? realStreamFn(model, context, streamOptions)
        : mockStreamFn(model, context, streamOptions);
    };

    this.agent = new Agent({
      initialState: {
        model: makeOpenAICompatModel({
          modelId: options.modelId,
          baseUrl: options.baseUrl,
          providerId: options.providerId,
        }),
        systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        tools: options.tools ?? [], // S4 tools over the S2 VFS when provided.
      },
      streamFn,
      getApiKey: options.getApiKey,
    });
  }

  get messages(): AgentState["messages"] {
    return this.agent.state.messages;
  }

  get streamingMessage(): AgentState["streamingMessage"] {
    return this.agent.state.streamingMessage;
  }

  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  get errorMessage(): string | undefined {
    return this.agent.state.errorMessage;
  }

  /** Subscribe to agent lifecycle events (drives UI re-render). */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    return this.agent.subscribe((event) => listener(event));
  }

  /** Send a user message and run a turn. Ignored while already streaming. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;
    await this.agent.prompt(trimmed);
  }

  /** Abort the in-flight run, if any. */
  abort(): void {
    this.agent.abort();
  }

  /** Clear the transcript and runtime state. */
  reset(): void {
    this.agent.reset();
  }
}
