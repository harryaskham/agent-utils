import test from "node:test";
import assert from "node:assert/strict";

import { truncateToolOutput, TOOL_OUTPUT_CAP } from "../extensions/lib/realtime-helpers.js";

import {
  REALTIME_CONTEXT_WINDOW_TOKENS,
  messageTextContent,
  messageToSummaryLine,
  estimateRealtimeContextTokens,
  extractExistingCompactionSummaries,
  capRealtimeSummaryText,
  buildRealtimeSummaryText,
  realtimeSimpleCompactionFileDetails,
  buildRealtimeSimpleCompaction,
  splitCurrentTurn,
  estimateRealtimeSummaryContextTokens,
} from "../extensions/lib/realtime-summary.js";

// --- truncateToolOutput (moved into realtime-helpers.js) ---

test("truncateToolOutput passes short text and caps long text with a suffix", () => {
  assert.equal(truncateToolOutput("hi"), "hi");
  assert.equal(truncateToolOutput(null), "");
  assert.equal(truncateToolOutput(undefined), "");
  const out = truncateToolOutput("abcdef", 3);
  assert.equal(out, "abc\n\n[truncated 3 chars]");
  assert.equal(truncateToolOutput("abc", 3), "abc", "exact length is not truncated");
  assert.equal(TOOL_OUTPUT_CAP, 16_000);
});

// --- messageTextContent ---

test("messageTextContent handles strings, text-part arrays, and non-text", () => {
  assert.equal(messageTextContent("plain"), "plain");
  assert.equal(messageTextContent(null), "");
  assert.equal(messageTextContent(42), "");
  assert.equal(
    messageTextContent([
      { type: "text", text: "a" },
      { type: "image", url: "x" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
});

// --- messageToSummaryLine ---

test("messageToSummaryLine renders each message shape", () => {
  assert.equal(messageToSummaryLine(null), "");
  assert.match(
    messageToSummaryLine({ role: "toolResult", toolCallId: "tc1", content: "result text" }),
    /^toolResult tc1: result text$/,
  );
  assert.match(
    messageToSummaryLine({ role: "toolResult", isError: true, content: "boom" }),
    /toolResult <unknown> error: boom/,
  );
  assert.match(
    messageToSummaryLine({ role: "bashExecution", command: "ls", output: "file" }),
    /^bash: ls => file$/,
  );
  assert.match(
    messageToSummaryLine({ role: "user", content: "hello" }),
    /^user: hello$/,
  );
  assert.match(
    messageToSummaryLine({
      role: "assistant",
      content: [{ type: "toolCall", name: "search", arguments: { q: 1 } }],
    }),
    /assistant toolCalls: search\(/,
  );
  assert.equal(
    messageToSummaryLine({ role: "assistant", content: [{ type: "image" }] }),
    "assistant: <non-text or empty message>",
  );
});

// --- extractExistingCompactionSummaries ---

test("extractExistingCompactionSummaries pulls trimmed summary blocks", () => {
  const messages = [
    { role: "user", content: "no summary here" },
    { role: "assistant", content: "<summary>\nfirst\n</summary> tail <summary>second</summary>" },
    { role: "assistant", content: "<summary>   </summary>" },
  ];
  assert.deepEqual(extractExistingCompactionSummaries(messages), ["first", "second"]);
  assert.deepEqual(extractExistingCompactionSummaries([]), []);
});

// --- capRealtimeSummaryText ---

test("capRealtimeSummaryText truncates beyond the cap with a marker", () => {
  assert.equal(capRealtimeSummaryText("short"), "short");
  assert.equal(capRealtimeSummaryText(null), "");
  const big = "x".repeat(24_050);
  const capped = capRealtimeSummaryText(big);
  assert.ok(capped.length < big.length);
  assert.match(capped, /\[realtime summary truncated 50 chars\]$/);
});

// --- buildRealtimeSummaryText: existing vs fallback ---

test("buildRealtimeSummaryText uses existing summaries when present", () => {
  const out = buildRealtimeSummaryText([
    { role: "assistant", content: "<summary>prior context</summary>" },
  ]);
  assert.match(out, /existing Pi compaction/);
  assert.match(out, /prior context/);
});

test("buildRealtimeSummaryText falls back to a role-by-role digest", () => {
  const out = buildRealtimeSummaryText([
    { role: "user", content: "question" },
    { role: "assistant", content: "answer" },
  ]);
  assert.match(out, /compact role-by-role fallback/);
  assert.match(out, /Included recent messages: 2\/2/);
  assert.match(out, /user: question/);
});

// --- realtimeSimpleCompactionFileDetails ---

test("realtimeSimpleCompactionFileDetails normalizes and sorts file lists", () => {
  const details = realtimeSimpleCompactionFileDetails({
    read: ["b.txt", "a.txt", ""],
    modified: ["z.js", "a.js"],
  });
  assert.deepEqual(details.readFiles, ["a.txt", "b.txt"]);
  assert.deepEqual(details.modifiedFiles, ["a.js", "z.js"]);
  const empty = realtimeSimpleCompactionFileDetails();
  assert.deepEqual(empty, { readFiles: [], modifiedFiles: [] });
});

// --- buildRealtimeSimpleCompaction ---

test("buildRealtimeSimpleCompaction assembles a structured checkpoint", () => {
  const result = buildRealtimeSimpleCompaction({
    messagesToSummarize: [{ role: "user", content: "hi" }],
    turnPrefixMessages: [{ role: "assistant", content: "yo" }],
    firstKeptEntryId: "entry-42",
    tokensBefore: 1234,
    fileOps: { read: ["r.txt"], modified: ["m.js"] },
    previousSummary: "older summary",
  }, "be terse");
  const { compaction } = result;
  assert.equal(compaction.firstKeptEntryId, "entry-42");
  assert.equal(compaction.tokensBefore, 1234);
  assert.match(compaction.summary, /## Goal/);
  assert.match(compaction.summary, /be terse/);
  assert.match(compaction.summary, /older summary/);
  assert.match(compaction.summary, /<read-files>\nr\.txt\n<\/read-files>/);
  assert.match(compaction.summary, /<modified-files>\nm\.js\n<\/modified-files>/);
  assert.deepEqual(compaction.details, { readFiles: ["r.txt"], modifiedFiles: ["m.js"] });
});

// --- splitCurrentTurn ---

test("splitCurrentTurn splits at the last user message", () => {
  const messages = [
    { role: "user", content: "1" },
    { role: "assistant", content: "a" },
    { role: "user", content: "2" },
    { role: "assistant", content: "b" },
  ];
  const { history, currentTurn } = splitCurrentTurn(messages);
  assert.equal(history.length, 2);
  assert.equal(currentTurn.length, 2);
  assert.equal(currentTurn[0].content, "2");
  assert.deepEqual(splitCurrentTurn([{ role: "assistant", content: "x" }]), {
    history: [{ role: "assistant", content: "x" }],
    currentTurn: [],
  });
});

// --- token estimators ---

test("estimateRealtimeContextTokens and summary variant return positive sizes", () => {
  assert.equal(REALTIME_CONTEXT_WINDOW_TOKENS, 128_000);
  const context = {
    systemPrompt: "system",
    messages: [
      { role: "user", content: "hello there" },
      { role: "toolResult", toolCallId: "tc", content: "out" },
    ],
    tools: [{ name: "t" }],
  };
  assert.ok(estimateRealtimeContextTokens(context) > 0);
  assert.ok(estimateRealtimeSummaryContextTokens(context) > 0);
  assert.equal(estimateRealtimeContextTokens(), 4, "empty context is just the text floor");
});
