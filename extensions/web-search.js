import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type } from "@sinclair/typebox";

const DEFAULT_TOKEN_FILE = "~/.config/gh-auth-tokens/copilot.token";
const DEFAULT_MODEL = "gpt-5.2-codex";
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const DEFAULT_API_BASE = "https://api.githubcopilot.com/v1";
const DEFAULT_EDITOR_VERSION = "vscode/1.103.1";

function expandHome(inputPath) {
  if (!inputPath.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

function getConfig() {
  return {
    tokenFile: expandHome(process.env.WEB_SEARCH_COPILOT_TOKEN_FILE || DEFAULT_TOKEN_FILE),
    model: process.env.WEB_SEARCH_MODEL || DEFAULT_MODEL,
    maxOutputTokens: Number.parseInt(
      process.env.WEB_SEARCH_MAX_OUTPUT_TOKENS || String(DEFAULT_MAX_OUTPUT_TOKENS),
      10,
    ),
    apiBase: (process.env.WEB_SEARCH_COPILOT_API_BASE || DEFAULT_API_BASE).replace(/\/$/, ""),
    editorVersion: process.env.WEB_SEARCH_EDITOR_VERSION || DEFAULT_EDITOR_VERSION,
  };
}

async function readToken(tokenFile) {
  const token = (await readFile(tokenFile, "utf8")).trim();
  if (!token) {
    throw new Error(`GitHub Copilot token file is empty: ${tokenFile}`);
  }
  return token;
}

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
      const token = await readToken(config.tokenFile);
      const payload = {
        model: params.model || config.model,
        input: params.query,
        tool_choice: "required",
        tools: [{ type: "web_search" }],
        max_output_tokens: params.maxOutputTokens || config.maxOutputTokens,
      };

      const response = await fetch(`${config.apiBase}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "editor-version": config.editorVersion,
        },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`GitHub Copilot web search failed (${response.status}): ${errorText}`);
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
          model: responseBody.model || payload.model,
          incompleteDetails: responseBody.incomplete_details || null,
          webSearchCalls,
          usage: responseBody.usage || null,
        },
      };
    },
  });
}
