import test from "node:test";
import assert from "node:assert/strict";

import {
  realtimeNextStepHint,
  micCaptureSummary,
  realtimeContextDiagnostics,
  realtimeContextDiagnosticLine,
  statusLines,
  realtimePanelLines,
} from "../extensions/lib/realtime-status.js";
import { numberEnv } from "../extensions/lib/realtime-helpers.js";

const num = (n) => Number(n).toLocaleString();

// Clear the audio/vad env that statusLines/panelLines read so the structural
// assertions are deterministic regardless of the host environment.
const STATUS_ENV_KEYS = [
  "PI_RT_AUDIO_BACKEND",
  "PULSE_SERVER",
  "PULSE_SOURCE",
  "PULSE_SINK",
  "PI_RT_VAD_THRESHOLD",
  "PI_RT_VAD_SILENCE_MS",
];
function withStatusEnv(overrides, fn) {
  const orig = Object.fromEntries(STATUS_ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    for (const k of STATUS_ENV_KEYS) {
      if (overrides[k] === undefined) delete process.env[k];
      else process.env[k] = overrides[k];
    }
    return fn();
  } finally {
    for (const k of STATUS_ENV_KEYS) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}

function baseConfig(overrides = {}) {
  return {
    model: "gpt-realtime-2",
    audioEnabled: true,
    transcriptionModel: "gpt-realtime-whisper",
    voice: "marin",
    reasoningEffort: "off",
    chimeEnabled: false,
    summaryContext: false,
    ...overrides,
  };
}

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

test("statusLines returns the 3-line compact array with conditional segments", () => {
  withStatusEnv({}, () => {
    const compact = statusLines({ connected: true, mic: false, forwardedMessageCount: 0 }, baseConfig());
    assert.equal(compact.length, 3);
    assert.match(compact[0], /^● rt gpt-realtime-2 · mode:connected · audio:on · mic:off · backend:/);
    // reason:off and speed:1 are omitted.
    assert.ok(!compact[1].includes("reason:"));
    assert.ok(!compact[1].includes("speed:"));
    // connecting (not yet connected) and idle markers.
    assert.match(statusLines({ connecting: true }, baseConfig())[0], /^◐ /);
    assert.match(statusLines({}, baseConfig())[0], /^○ /);
    // conditional segments appear when configured.
    const withSegs = statusLines(
      { connected: true, mic: true, micMode: "vad", latestClipId: "c1", forwardedMessageCount: 2 },
      baseConfig({ reasoningEffort: "low", sendReasoning: true, directAzure: true, speed: 1.25 }),
    );
    assert.match(withSegs[0], /mic:vad/);
    assert.ok(withSegs[1].includes("reason:low"));
    assert.ok(withSegs[1].includes("speed:1.25"));
    assert.ok(withSegs[1].includes("clip:c1"));
  });
});

test("statusLines full mode appends the diagnostic/record/playback block", () => {
  withStatusEnv({}, () => {
    const full = statusLines(
      { connected: true, mic: false, forwardedMessageCount: 0 },
      baseConfig(),
      { full: true },
    );
    assert.equal(full.length, 13);
    assert.ok(full.some((l) => l.startsWith("baseUrl: ")));
    assert.ok(full.some((l) => l.startsWith("record: ")));
    assert.ok(full.some((l) => l.startsWith("playback: ")));
    assert.ok(full.some((l) => l.startsWith("context: window:")));
  });
});

test("realtimePanelLines adds vad/pulse/controls with numberEnv defaults", () => {
  withStatusEnv({}, () => {
    const lines = realtimePanelLines({ connected: true, mic: false, forwardedMessageCount: 0 }, baseConfig());
    assert.equal(lines.length, 7);
    assert.match(lines[3], /^vad: thresh:0\.7 · silence:1100ms · /);
    assert.match(lines[4], /^pulse: server:<unset> · source:<default> · sink:<default>$/);
    assert.equal(lines[6], "controls: /rt-stop · /rt-cancel · /rt mic vad · /rt audio toggle · /rt thresh=0.85 · /rt status full · /rt off");
  });
});

test("numberEnv reads env with a non-finite/empty fallback", () => {
  const KEY = "PI_RT_TEST_NUMBER_ENV";
  const orig = process.env[KEY];
  try {
    delete process.env[KEY];
    assert.equal(numberEnv(KEY, 5), 5);
    process.env[KEY] = "2.5";
    assert.equal(numberEnv(KEY, 5), 2.5);
    process.env[KEY] = "not-a-number";
    assert.equal(numberEnv(KEY, 5), 5);
    process.env[KEY] = "";
    assert.equal(numberEnv(KEY, 5), 5);
  } finally {
    if (orig === undefined) delete process.env[KEY];
    else process.env[KEY] = orig;
  }
});
