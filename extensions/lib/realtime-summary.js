// Realtime summary / simple-compaction helpers extracted from
// realtime-agent.js (bd-e1914a). These are pure functions over their inputs
// plus fixed summary caps; they build the compact context summary and the
// deterministic local "simple compaction" used so realtime mode can compact
// without leaving realtime or calling the realtime model. Behavior is
// unchanged from the original inline definitions.

import { estimateRealtimeTokensForText, truncateToolOutput } from "./realtime-helpers.js";

export const REALTIME_CONTEXT_WINDOW_TOKENS = 128_000;
const SUMMARY_FALLBACK_MESSAGE_CAP = 40;
const SUMMARY_FALLBACK_TEXT_CAP = 1_200;
const REALTIME_SUMMARY_TEXT_CAP = 24_000;

export function messageTextContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

export function messageToSummaryLine(msg) {
  if (!msg) return "";
  if (msg.role === "toolResult") {
    const out = truncateToolOutput(messageTextContent(msg.content), 500);
    return `toolResult ${msg.toolCallId || "<unknown>"}${msg.isError ? " error" : ""}: ${out}`;
  }
  if (msg.role === "bashExecution") {
    const command = truncateToolOutput(msg.command || "", 240);
    const output = truncateToolOutput(msg.output || "", 500);
    return `bash: ${command}${output ? ` => ${output}` : ""}`;
  }
  const text = messageTextContent(msg.content).trim();
  const toolCalls = Array.isArray(msg.content)
    ? msg.content
        .filter((c) => c?.type === "toolCall")
        .map((c) => `${c.name || "tool"}(${truncateToolOutput(JSON.stringify(c.arguments || {}), 240)})`)
    : [];
  if (text && toolCalls.length) return `${msg.role}: ${truncateToolOutput(text, SUMMARY_FALLBACK_TEXT_CAP)}; toolCalls: ${toolCalls.join("; ")}`;
  if (text) return `${msg.role}: ${truncateToolOutput(text, SUMMARY_FALLBACK_TEXT_CAP)}`;
  if (toolCalls.length) return `${msg.role} toolCalls: ${toolCalls.join("; ")}`;
  return `${msg.role}: <non-text or empty message>`;
}

export function estimateRealtimeContextTokens(context = {}) {
  let total = estimateRealtimeTokensForText(context.systemPrompt || "");
  for (const msg of context.messages || []) {
    total += estimateRealtimeTokensForText(messageTextContent(msg.content));
    if (msg.role === "toolResult") total += estimateRealtimeTokensForText(msg.toolCallId || "");
  }
  for (const tool of context.tools || []) {
    total += estimateRealtimeTokensForText(JSON.stringify(tool));
  }
  return total;
}

export function extractExistingCompactionSummaries(messages = []) {
  const summaries = [];
  for (const msg of messages) {
    const text = messageTextContent(msg.content);
    if (!text) continue;
    const matches = [...text.matchAll(/<summary>\n?([\s\S]*?)\n?<\/summary>/g)];
    for (const match of matches) {
      const summary = String(match[1] || "").trim();
      if (summary) summaries.push(summary);
    }
  }
  return summaries;
}

export function capRealtimeSummaryText(text) {
  const s = String(text || "");
  if (s.length <= REALTIME_SUMMARY_TEXT_CAP) return s;
  return `${s.slice(0, REALTIME_SUMMARY_TEXT_CAP)}\n\n[realtime summary truncated ${s.length - REALTIME_SUMMARY_TEXT_CAP} chars]`;
}

export function buildRealtimeSummaryText(messages = []) {
  const existing = extractExistingCompactionSummaries(messages);
  if (existing.length) {
    return capRealtimeSummaryText([
      "Realtime compact context mode is enabled. Use this existing Pi compaction/branch summary as prior conversation context instead of full history. This is background context only; do not read it aloud or answer it directly.",
      ...existing.slice(-2).map((summary, idx, arr) => `\n## Summary ${idx + 1}/${arr.length}\n${summary}`),
    ].join("\n"));
  }

  const lines = messages.slice(-SUMMARY_FALLBACK_MESSAGE_CAP).map(messageToSummaryLine).filter(Boolean);
  return capRealtimeSummaryText([
    "Realtime compact context mode is enabled. No saved Pi compaction summary was present in the model context, so this is a compact role-by-role fallback summary of recent history instead of full replay. This is background context only; do not read it aloud or answer it directly.",
    `Included recent messages: ${lines.length}/${messages.length}`,
    "",
    ...lines,
  ].join("\n"));
}

export function realtimeSimpleCompactionFileDetails(fileOps = {}) {
  const readFiles = Array.from(fileOps.read || fileOps.readFiles || []).map(String).filter(Boolean).sort();
  const modifiedFiles = Array.from(fileOps.edited || fileOps.modified || fileOps.modifiedFiles || []).map(String).filter(Boolean).sort();
  return { readFiles, modifiedFiles };
}

export function buildRealtimeSimpleCompaction(preparation = {}, customInstructions) {
  const messages = [
    ...(preparation.messagesToSummarize || []),
    ...(preparation.turnPrefixMessages || []),
  ];
  const lines = messages.slice(-SUMMARY_FALLBACK_MESSAGE_CAP).map(messageToSummaryLine).filter(Boolean);
  const roleCounts = messages.reduce((acc, msg) => {
    const role = msg?.role || "unknown";
    acc[role] = (acc[role] || 0) + 1;
    return acc;
  }, {});
  const details = realtimeSimpleCompactionFileDetails(preparation.fileOps);
  const previous = String(preparation.previousSummary || "").trim();
  const summary = [
    "## Goal",
    "Realtime mode stayed active during compaction. This is a deterministic local/simple checkpoint generated without calling the selected realtime model.",
    customInstructions ? `\nAdditional compaction instructions: ${customInstructions}` : "",
    previous ? `\nPrevious summary preserved:\n${truncateToolOutput(previous, 6000)}` : "",
    "",
    "## Constraints & Preferences",
    "- Preserve realtime voice/model state during compaction; do not restore the text model just to compact.",
    "- Keep the recent Pi session entries from `firstKeptEntryId` onward; this summary only replaces older context.",
    "",
    "## Progress",
    "### Done",
    `- [x] Local realtime simple compaction summarized ${messages.length} older message(s).`,
    `- [x] Role counts: ${Object.entries(roleCounts).map(([role, count]) => `${role}:${count}`).join(", ") || "none"}.`,
    "",
    "### In Progress",
    "- [ ] Continue from the retained recent messages after this compaction entry.",
    "",
    "### Blocked",
    "- None recorded by the local simple compacter.",
    "",
    "## Key Decisions",
    "- **Realtime-safe compaction**: Use an extension-provided local summary so Pi does not send compaction traffic to `gpt-realtime-2` and does not leave realtime mode.",
    "",
    "## Next Steps",
    "1. Continue the realtime session from the retained recent context.",
    "2. If important context is missing, inspect retained messages and previous summaries in the session history.",
    "",
    "## Critical Context",
    `- Included latest older-message excerpts: ${lines.length}/${messages.length}.`,
    ...lines.map((line) => `- ${line}`),
    details.readFiles.length ? `\n<read-files>\n${details.readFiles.join("\n")}\n</read-files>` : "",
    details.modifiedFiles.length ? `\n<modified-files>\n${details.modifiedFiles.join("\n")}\n</modified-files>` : "",
  ].filter((line) => line !== "").join("\n");
  return {
    compaction: {
      summary: capRealtimeSummaryText(summary),
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details,
    },
  };
}

export function splitCurrentTurn(messages = []) {
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user");
  if (lastUserIndex === -1) return { history: messages, currentTurn: [] };
  return { history: messages.slice(0, lastUserIndex), currentTurn: messages.slice(lastUserIndex) };
}

export function estimateRealtimeSummaryContextTokens(context = {}) {
  const { history, currentTurn } = splitCurrentTurn(context.messages || []);
  const summaryText = buildRealtimeSummaryText(history);
  return estimateRealtimeContextTokens({
    systemPrompt: `${context.systemPrompt || ""}\n\n${summaryText}`,
    tools: context.tools || [],
    messages: currentTurn,
  });
}
