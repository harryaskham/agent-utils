// pi-wasm S7 (bd-e8949f) — MOCK streamFn fallback.
//
// The real streaming path is S3 (bd-cbf86f, landed): `makeOpenAICompatStreamFn`
// in ./provider.ts streams from the LiteLLM proxy once a runtime API key is
// available (S6 settings seam). This mock is the NO-KEY fallback so the chat
// shell is demonstrable out of the box (and S8 can drive the UI without a live
// key): it echoes the latest user message back as a streamed assistant reply,
// using the SAME AssistantMessageEventStream protocol the real provider emits.
//
// The session (./session.ts) routes to the real provider stream when the agent
// resolves an apiKey for the turn, and to this mock otherwise — a drop-in seam.
//
// Browser-clean: imports only import-time-clean pi-ai/pi-agent-core entries.

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Extract plain text from any message content shape (string or content parts). */
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && "type" in part) {
          const p = part as { type: string; text?: string; name?: string };
          if (p.type === "text") return p.text ?? "";
          if (p.type === "toolCall") return `[tool: ${p.name ?? "?"}]`;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function latestUserText(context: Context): string {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const m = context.messages[i];
    if (m.role === "user") return contentToText(m.content).trim();
  }
  return "";
}

function chunkText(text: string, size = 6): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks.length ? chunks : [""];
}

/**
 * Build a mock {@link StreamFn} that echoes the latest user message back as a
 * streamed assistant reply. `delayMs` controls the inter-chunk cadence.
 */
export function createMockStreamFn(delayMs = 14): StreamFn {
  return (model: Model<Api>, context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const userText = latestUserText(context);
    const reply =
      `⟨mock reply — no API key set, so this is a local echo⟩ ` +
      (userText ? `You said: “${userText}”.` : `Hello from the in-browser Pi agent loop.`) +
      ` Add a runtime key (top bar) to get real LiteLLM-backed responses via S3.`;

    const meta = model as unknown as { api: Api; provider: string; id: string };
    const makeMessage = (text: string): AssistantMessage =>
      ({
        role: "assistant",
        content: [{ type: "text", text }],
        api: meta.api,
        provider: meta.provider,
        model: meta.id,
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      }) as AssistantMessage;

    void (async () => {
      try {
        stream.push({ type: "start", partial: makeMessage("") });
        stream.push({ type: "text_start", contentIndex: 0, partial: makeMessage("") });
        let acc = "";
        for (const chunk of chunkText(reply)) {
          acc += chunk;
          stream.push({ type: "text_delta", contentIndex: 0, delta: chunk, partial: makeMessage(acc) });
          await sleep(delayMs);
        }
        const finalMessage = makeMessage(acc);
        stream.push({ type: "text_end", contentIndex: 0, content: acc, partial: finalMessage });
        stream.push({ type: "done", reason: "stop", message: finalMessage });
        stream.end(finalMessage);
      } catch (err) {
        const errorMessage = makeMessage(`mock stream error: ${String(err)}`);
        errorMessage.stopReason = "error";
        errorMessage.errorMessage = String(err);
        stream.push({ type: "error", reason: "error", message: errorMessage } as never);
        stream.end(errorMessage);
      }
    })();

    return stream;
  };
}
