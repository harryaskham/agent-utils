import test from "node:test";
import assert from "node:assert/strict";

import {
  realtimeNextStepHint,
  shortReason,
  micCaptureSummary,
  realtimeContextDiagnostics,
  realtimeContextDiagnosticLine,
  statusLines,
  realtimePanelLines,
  commandAvailable,
  envPresent,
  diagnosticLines,
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
  "PI_RT_API_KEY",
  "OPENAI_API_KEY",
  "PI_RT_AZURE_API_KEY",
  "AZURE_CANADACENTRAL_API_KEY",
  "AZURE_OPENAI_API_KEY",
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

test("envPresent returns the first present env name or undefined", () => {
  withStatusEnv({ OPENAI_API_KEY: "sk-xxx" }, () => {
    assert.equal(envPresent("PI_RT_API_KEY", "OPENAI_API_KEY"), "OPENAI_API_KEY");
  });
  withStatusEnv({}, () => {
    assert.equal(envPresent("PI_RT_API_KEY", "OPENAI_API_KEY"), undefined);
  });
});

test("commandAvailable detects present vs missing executables", () => {
  assert.equal(commandAvailable("sh"), true);
  assert.equal(commandAvailable("definitely-not-a-real-command-xyz-123"), false);
});

test("diagnosticLines renders the /rt-doctor block with auth hints", () => {
  const session = { pendingSpokenTranscripts: [], lastMicBytes: 0, forwardedMessageCount: 0, connected: true };
  // No API key in env -> auth hint present, apiKey shown as <missing>.
  withStatusEnv({}, () => {
    const lines = diagnosticLines(session, baseConfig());
    assert.equal(lines[0], "Realtime doctor");
    for (const prefix of ["provider:", "audioBackend:", "pulse:", "commands:", "vad:", "state:", "micError:", "hint:"]) {
      assert.ok(lines.some((l) => l.startsWith(prefix)), `missing line: ${prefix}`);
    }
    assert.ok(lines.some((l) => l.startsWith("provider:") && l.includes("apiKey:<missing>")));
    const hint = lines.find((l) => l.startsWith("hint:"));
    assert.ok(hint.includes("set OPENAI_API_KEY or PI_RT_API_KEY"));
  });
  // With an API key -> no auth hint, apiKey name shown.
  withStatusEnv({ OPENAI_API_KEY: "sk-xxx" }, () => {
    const lines = diagnosticLines(session, baseConfig());
    assert.ok(lines.some((l) => l.startsWith("provider:") && l.includes("apiKey:OPENAI_API_KEY")));
    const hint = lines.find((l) => l.startsWith("hint:"));
    assert.ok(!hint.includes("set OPENAI_API_KEY or PI_RT_API_KEY"));
  });
});

test("realtimeNextStepHint appends a doctor hint when a recent error is recorded", () => {
  // No error -> base hint unchanged (exact match guards the no-error path).
  assert.equal(
    realtimeNextStepHint({ connected: true }, {}),
    "/rt mic vad starts listening; /rt-stop closes socket; /rt-off restores text model",
  );
  // Mic error -> doctor suffix appended.
  assert.match(
    realtimeNextStepHint({ connected: true, lastMicError: "parec: No such device" }, {}),
    / \u00b7 \/rt-doctor diagnoses the recent error$/,
  );
  // Response error on an otherwise-idle session also triggers the suffix.
  assert.match(
    realtimeNextStepHint({ lastResponseError: "boom" }, {}),
    / \u00b7 \/rt-doctor diagnoses the recent error$/,
  );
});

test("shortReason collapses whitespace and bounds length", () => {
  assert.equal(shortReason("  hello   world  "), "hello world");
  assert.equal(shortReason(""), "");
  assert.equal(shortReason(null), "");
  assert.equal(shortReason(undefined), "");
  const long = "x".repeat(80);
  const out = shortReason(long, 48);
  assert.equal(out.length, 48);
  assert.ok(out.endsWith("\u2026"));
});

test("statusLines surfaces in-flight reconnect attempts in the compact view", () => {
  withStatusEnv({}, () => {
    const line = statusLines(
      { connecting: true, forwardedMessageCount: 0 },
      baseConfig({ reconnectAttempts: 2, reconnectMaxAttempts: 5 }),
    )[0];
    assert.match(line, /^\u25d0 /);
    assert.ok(line.includes(" \u00b7 reconnecting:2/5"), `expected reconnect segment in: ${line}`);
    // A connected session has no reconnect segment.
    const connected = statusLines({ connected: true, forwardedMessageCount: 0 }, baseConfig({ reconnectAttempts: 0 }))[0];
    assert.ok(!connected.includes("reconnecting:"));
  });
});

test("statusLines surfaces a recorded disconnect reason when fully dropped", () => {
  withStatusEnv({}, () => {
    const line = statusLines(
      { connected: false, connecting: false, forwardedMessageCount: 0 },
      baseConfig({ lastDisconnectReason: "socket closed (1006)" }),
    )[0];
    assert.match(line, /^\u25cb /);
    assert.ok(line.includes(" \u00b7 dropped:socket closed (1006)"), `expected dropped segment in: ${line}`);
  });
});

test("diagnosticLines hints when auto-reconnect is exhausted", () => {
  const session = { pendingSpokenTranscripts: [], lastMicBytes: 0, forwardedMessageCount: 0, connected: false };
  withStatusEnv({ OPENAI_API_KEY: "sk-xxx" }, () => {
    const lines = diagnosticLines(session, baseConfig({ autoReconnect: true, reconnectAttempts: 5, reconnectMaxAttempts: 5 }));
    const hint = lines.find((l) => l.startsWith("hint:"));
    assert.ok(hint.includes("auto-reconnect exhausted after 5/5"), `expected exhausted hint in: ${hint}`);
  });
});

test("micCaptureSummary renders a gained level meter when session.inputLevel is present", () => {
  // No inputLevel -> byte-only summary unchanged (defensive).
  assert.equal(
    micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 1024 }),
    "vad active \u00b7 1024 bytes",
  );
  // session.inputLevel is raw smoothed RMS (~0.01-0.1); it is gained via
  // rmsToLevel(12) before render so a speech-level RMS fills the bar instead of
  // barely twitching. RMS 0.05 -> rmsToLevel = 0.6 -> 60%.
  assert.match(
    micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 1024, inputLevel: 0.05 }),
    / \u00b7 level:\[.+\] +60%$/,
  );
  // RMS >= ~0.083 saturates the bar (gain 12 -> clamp 1.0 -> 100%).
  assert.match(
    micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 1024, inputLevel: 0.1 }),
    / \u00b7 level:\[.+\] +100%$/,
  );
  // Zero level still renders (active mic, currently silent/muted) -> 0%.
  assert.match(
    micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 2048, inputLevel: 0 }),
    / \u00b7 level:\[.+\] +0%$/,
  );
  // Non-finite level is ignored (defensive) -> byte-only summary.
  assert.equal(
    micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 1024, inputLevel: NaN }),
    "vad active \u00b7 1024 bytes",
  );
});

test("micCaptureSummary renders the live level meter in PTT mode (bd-9ff804)", () => {
  // The bead: show a visual input-level indicator in PTT mode. The meter is
  // mode-agnostic (rendered whenever the mic is active with a finite level), so
  // PTT capture gets the same gained level bar as VAD. RMS 0.05 -> 60%.
  assert.match(
    micCaptureSummary({ mic: true, micMode: "ptt", lastMicBytes: 1024, inputLevel: 0.05 }),
    /^ptt active \u00b7 1024 bytes \u00b7 level:\[.+\] +60%$/,
  );
  // Silent-but-active PTT still renders the bar at 0% (not a byte-only summary).
  assert.match(
    micCaptureSummary({ mic: true, micMode: "ptt", lastMicBytes: 2048, inputLevel: 0 }),
    / \u00b7 level:\[.+\] +0%$/,
  );
  // The rendered bar is identical between PTT and VAD for the same level, so the
  // meter is genuinely mode-agnostic rather than special-cased per mode.
  const level = 0.05;
  const pttBar = micCaptureSummary({ mic: true, micMode: "ptt", lastMicBytes: 1024, inputLevel: level }).replace(/^ptt/, "");
  const vadBar = micCaptureSummary({ mic: true, micMode: "vad", lastMicBytes: 1024, inputLevel: level }).replace(/^vad/, "");
  assert.equal(pttBar, vadBar);
});

test("diagnosticLines explains a GA-only realtime model rejection (bd-0b40ce)", () => {
  withStatusEnv({ OPENAI_API_KEY: "sk-xxx" }, () => {
    // GA error surfaced via lastResponseError -> specific GA hint, generic suppressed.
    const viaResponse = diagnosticLines(
      { pendingSpokenTranscripts: [], lastMicBytes: 0, forwardedMessageCount: 0, lastResponseError: 'Model "gpt-realtime-2-2026-05-06" is only available on the GA API' },
      baseConfig(),
    );
    const h1 = viaResponse.find((l) => l.startsWith("hint:"));
    assert.ok(h1.includes("GA-only") && h1.includes("BETA interface"), `expected GA hint: ${h1}`);
    assert.ok(!h1.includes("verify the model id, base URL"), "generic error hint suppressed when GA hint fires");
    // GA error surfaced via the disconnect reason also triggers the hint.
    const viaDisconnect = diagnosticLines(
      { pendingSpokenTranscripts: [], lastMicBytes: 0, forwardedMessageCount: 0 },
      baseConfig({ lastDisconnectReason: "connect failed: only available on the GA API" }),
    );
    assert.ok(viaDisconnect.find((l) => l.startsWith("hint:")).includes("GA-only"), "GA hint from disconnect reason");
  });
});
