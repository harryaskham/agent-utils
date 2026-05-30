import test from "node:test";
import assert from "node:assert/strict";

import {
  realtimeNextStepHint,
  micCaptureSummary,
  realtimeContextDiagnostics,
  realtimeContextDiagnosticLine,
} from "../extensions/lib/realtime-status.js";

const num = (n) => Number(n).toLocaleString();

test("realtimeNextStepHint walks the session state machine", () => {
  assert.match(
    realtimeNextStepHint({ mic: true, micMode: "ptt" }, {}),
    /^\/rt-stop sends PTT audio; /,
  );
  assert.match(
    realtimeNextStepHint({ mic: true, micMode: "vad" }, {}),
    /^\/rt-stop commits current mic buffer; /,
  );
  assert.equal(
    realtimeNextStepHint({ connected: true }, {}),
    "/rt mic vad starts listening; /rt-stop closes socket; /rt-off restores text model",
  );
  assert.equal(
    realtimeNextStepHint({ connecting: true }, {}),
    "/rt mic vad starts listening; /rt-stop closes socket; /rt-off restores text model",
  );
  assert.equal(
    realtimeNextStepHint({}, { sttOnly: true }),
    "/rt stt vad starts speech-to-text; /rt-off clears realtime state",
  );
  assert.match(realtimeNextStepHint({}, {}), /^\/rt start vad begins realtime;/);
});

test("micCaptureSummary reports inactive, waiting, and active states", () => {
  assert.equal(micCaptureSummary({ mic: false }), "inactive");
  assert.equal(micCaptureSummary({ mic: true }), "on active · 0 bytes · waiting for audio");
  assert.equal(
    micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 1024 }),
    "vad active · 1024 bytes",
  );
});

test("realtimeContextDiagnostics defaults to the 128k window with no messages", () => {
  const d = realtimeContextDiagnostics({}, {});
  assert.equal(d.contextWindow, 128_000);
  assert.equal(d.reserveTokens, 16_384);
  assert.equal(d.thresholdTokens, 128_000 - 16_384);
  assert.equal(d.thresholdPct, "87.2%");
  assert.equal(d.keepRecentTokens, null);
  assert.equal(d.fullTokens, null);
  assert.equal(d.fullPct, "n/a");
  assert.equal(d.summaryTokens, null);
  assert.equal(d.summaryPct, "n/a");
});

test("realtimeContextDiagnostics honors a realtime model window and settings", () => {
  const session = {
    lastCtx: {
      model: { id: "gpt-realtime-2", contextWindow: 200_000 },
      settingsManager: { getCompactionSettings: () => ({ reserveTokens: 1_000, keepRecentTokens: 500 }) },
    },
  };
  const d = realtimeContextDiagnostics(session, {});
  assert.equal(d.contextWindow, 200_000);
  assert.equal(d.reserveTokens, 1_000);
  assert.equal(d.keepRecentTokens, 500);
  assert.equal(d.thresholdTokens, 199_000);
  assert.equal(d.thresholdPct, "99.5%");
});

test("realtimeContextDiagnostics ignores a non-realtime model window", () => {
  const d = realtimeContextDiagnostics({ lastCtx: { model: { id: "gpt-4o", contextWindow: 9_999 } } }, {});
  assert.equal(d.contextWindow, 128_000);
});

test("realtimeContextDiagnostics estimates tokens when messages are present", () => {
  const session = {
    lastCtx: {
      agent: { systemPrompt: "hello world", state: { messages: [{ role: "user", content: "hi there friend" }] } },
      tools: [],
    },
  };
  const d = realtimeContextDiagnostics(session, {});
  assert.equal(typeof d.fullTokens, "number");
  assert.equal(typeof d.summaryTokens, "number");
  assert.ok(d.fullTokens > 0);
  // pct strings follow the toFixed(1) "%" format.
  assert.match(d.fullPct, /^\d+\.\d%$/);
  assert.match(d.summaryPct, /^\d+\.\d%$/);
});

test("realtimeContextDiagnosticLine renders n/a and populated variants", () => {
  // No messages -> estimate:n/a, no keep segment.
  assert.equal(
    realtimeContextDiagnosticLine({}, {}),
    `context: window:${num(128_000)} · compactAt:${num(111_616)} (87.2%) · reserve:${num(16_384)} · estimate:n/a`,
  );
  // Populated -> full/summary tokens and a keep segment from settings.
  const session = {
    lastCtx: {
      agent: { systemPrompt: "hello world", state: { messages: [{ role: "user", content: "hi there friend" }] } },
      settingsManager: { getCompactionSettings: () => ({ reserveTokens: 16_384, keepRecentTokens: 4_000 }) },
      tools: [],
    },
  };
  const d = realtimeContextDiagnostics(session, {});
  const line = realtimeContextDiagnosticLine(session, {});
  assert.ok(line.includes(` · keep:${num(4_000)} · `), "keep segment present");
  assert.ok(
    line.endsWith(`full:${num(d.fullTokens)} (${d.fullPct}) · summary:${num(d.summaryTokens)} (${d.summaryPct})`),
    "observed full/summary tail",
  );
});
