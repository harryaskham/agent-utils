import { Type } from "@sinclair/typebox";

import {
  DEFAULT_MODEL,
  parseFallbackModels,
  modelCandidates,
  isModelUnavailableError,
} from "./web-search-models.js";
import { combineTimeoutSignal, resolveRequestTimeoutMs } from "./web-search-http.js";
import { resolveWebSearchAuthConfig, resolveWebSearchToken } from "./web-search-auth.js";

const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_EDITOR_VERSION = "vscode/1.103.1";

function getConfig() {
  return {
    ...resolveWebSearchAuthConfig(process.env),
    model: process.env.WEB_SEARCH_MODEL || DEFAULT_MODEL,
    maxOutputTokens: Number.parseInt(
      process.env.WEB_SEARCH_MAX_OUTPUT_TOKENS || String(DEFAULT_MAX_OUTPUT_TOKENS),
      10,
    ),
    editorVersion: process.env.WEB_SEARCH_EDITOR_VERSION || DEFAULT_EDITOR_VERSION,
    fallbackModels: parseFallbackModels(process.env.WEB_SEARCH_FALLBACK_MODELS),
    // bd-6cf0d6: bound the /responses fetch so a stalled upstream can't hang the tool.
    requestTimeoutMs: resolveRequestTimeoutMs(process.env.WEB_SEARCH_REQUEST_TIMEOUT_MS),
  };
}

// Pure model-selection helpers (parseFallbackModels / modelCandidates /
// isModelUnavailableError) live in ./web-search-models.js so they can be
// unit-tested without importing this entrypoint's @sinclair/typebox dependency.


function extractTextAndCitations(responseBody) {
  const texts = [];
  const citations = [];
  const output = Array.isArray(responseBody?.output) ? responseBody.output : [];

  for (const item of output) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;

    for (const contentItem of item.content) {
      if (!contentItem || contentItem.type !== "output_text") continue;

      if (typeof contentItem.text === "string" && contentItem.text.trim()) {
        texts.push(contentItem.text.trim());
      }

      const annotations = Array.isArray(contentItem.annotations) ? contentItem.annotations : [];
      for (const annotation of annotations) {
        if (!annotation || annotation.type !== "url_citation") continue;
        citations.push({
          url: annotation.url || null,
          title: annotation.title || null,
          startIndex: annotation.start_index ?? null,
          endIndex: annotation.end_index ?? null,
        });
      }
    }
  }

  if (texts.length === 0 && typeof responseBody?.output_text === "string" && responseBody.output_text.trim()) {
    texts.push(responseBody.output_text.trim());
  }

  return {
    text: texts.join("\n\n"),
    citations,
  };
}

function formatToolContent(text, citations) {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (citations.length === 0) {
    return trimmed || "Web search completed, but no final answer text was returned.";
  }

  const lines = citations
    .map((citation) => citation.url)
    .filter(Boolean)
    .map((url) => `- ${url}`);

  if (!trimmed) {
    return ["Web search completed.", "", "Sources:", ...lines].join("\n");
  }

  return [trimmed, "", "Sources:", ...lines].join("\n");
}

export default function webSearchExtension(pi) {
  pi.registerTool({
    name: "search_web",
    label: "Search Web",
    description:
      "Search the live web through GitHub Copilot's Responses API and return a grounded answer with citations.",
    promptSnippet: "Search the live web for current information and grounded answers with citations.",
    promptGuidelines: [
      "Use this tool when the user asks for current events, recent changes, latest releases, or other time-sensitive information.",
      "Prefer this tool over answering from memory when freshness matters.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Search query or question to answer with live web results",
        minLength: 1,
      }),
      model: Type.Optional(
        Type.String({ description: "Optional override for the upstream GitHub Copilot model" }),
      ),
      maxOutputTokens: Type.Optional(
        Type.Number({
          description: "Optional override for maximum output tokens",
          minimum: 1,
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const config = getConfig();
      const token = await resolveWebSearchToken(config);
      const candidates = modelCandidates(config, params.model);
      let response;
      let model;
      let lastErrorText = "";
      let lastStatus = 0;
      for (let i = 0; i < candidates.length; i += 1) {
        model = candidates[i];
        const payload = {
          model,
          input: params.query,
          tool_choice: "required",
          tools: [{ type: "web_search", search_context_size: "high" }],
          max_output_tokens: params.maxOutputTokens || config.maxOutputTokens,
        };
        // bd-6cf0d6: bound this external await with a timeout while still honoring
        // the incoming cancellation signal, so a stalled upstream surfaces an error
        // instead of wedging the tool forever.
        const attempt = combineTimeoutSignal(signal, config.requestTimeoutMs);
        try {
          response = await fetch(`${config.apiBase}/responses`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "editor-version": config.editorVersion,
            },
            body: JSON.stringify(payload),
            signal: attempt.signal,
          });
        } catch (err) {
          if (attempt.isTimeout()) {
            throw new Error(`GitHub Copilot web search timed out after ${config.requestTimeoutMs}ms (model ${model})`);
          }
          throw err;
        } finally {
          attempt.cleanup();
        }
        if (response.ok) break;
        lastStatus = response.status;
        lastErrorText = await response.text();
        // Only fall through to the next model when this one is unavailable and
        // another candidate remains; otherwise surface the error.
        if (!(isModelUnavailableError(lastStatus, lastErrorText) && i < candidates.length - 1)) {
          throw new Error(`GitHub Copilot web search failed (${lastStatus}): ${lastErrorText}`);
        }
      }
      if (!response || !response.ok) {
        throw new Error(`GitHub Copilot web search failed (${lastStatus}): ${lastErrorText}`);
      }

      const responseBody = await response.json();
      const { text, citations } = extractTextAndCitations(responseBody);
      const output = Array.isArray(responseBody.output) ? responseBody.output : [];
      const webSearchCalls = output.filter((item) => item?.type === "web_search_call").length;

      return {
        content: [
          {
            type: "text",
            text: formatToolContent(text, citations),
          },
        ],
        details: {
          query: params.query,
          text,
          citations,
          responseId: responseBody.id || null,
          status: responseBody.status || null,
          model: responseBody.model || model,
          authMode: config.authMode,
          incompleteDetails: responseBody.incomplete_details || null,
          webSearchCalls,
          usage: responseBody.usage || null,
        },
      };
    },
  });
}
