import test from "node:test";
import assert from "node:assert/strict";

import {
  env,
  envBool,
  b64,
  normalizeBaseUrl,
  realtimeUrl,
  azureRealtimeUrl,
  parseBooleanValue,
  parseRealtimeSpeed,
  parseVadThreshold,
  estimateRealtimeTokensForText,
  truncateToolOutput,
  numberEnv,
  TOOL_OUTPUT_CAP,
} from "../extensions/lib/realtime-helpers.js";

import {
  SAMPLE_RATE,
  CHANNELS,
  SAMPLE_WIDTH,
  pcmBytesForMs,
  synthTone,
  concatPcm,
  chimePcm,
  formatDurationMs,
  audioDurationMs,
} from "../extensions/lib/realtime-audio.js";

// --- realtime-helpers.js ---

test("env returns first non-empty match and undefined otherwise", () => {
  const a = "RT_TEST_ENV_A";
  const b = "RT_TEST_ENV_B";
  delete process.env[a];
  process.env[b] = "value-b";
  try {
    assert.equal(env(a, b), "value-b");
    process.env[a] = "";
    assert.equal(env(a, b), "value-b", "empty string is skipped");
    process.env[a] = "value-a";
    assert.equal(env(a, b), "value-a", "first match wins");
    assert.equal(env("RT_TEST_ENV_MISSING"), undefined);
  } finally {
    delete process.env[a];
    delete process.env[b];
  }
});

test("envBool parses truthy tokens and honors default", () => {
  const name = "RT_TEST_ENV_BOOL";
  try {
    delete process.env[name];
    assert.equal(envBool(name), false);
    assert.equal(envBool(name, true), true, "default used when unset");
    for (const t of ["1", "true", "YES", "On"]) {
      process.env[name] = t;
      assert.equal(envBool(name), true, `${t} is truthy`);
    }
    process.env[name] = "nope";
    assert.equal(envBool(name), false);
  } finally {
    delete process.env[name];
  }
});

test("b64 encodes buffers and strings", () => {
  assert.equal(b64(Buffer.from("hi")), "aGk=");
  assert.equal(b64("hi"), "aGk=");
});

test("normalizeBaseUrl strips trailing slashes and /v1", () => {
  assert.equal(normalizeBaseUrl("https://api.openai.com/"), "https://api.openai.com");
  assert.equal(normalizeBaseUrl("https://api.openai.com/v1"), "https://api.openai.com");
  assert.equal(normalizeBaseUrl("https://x.test/v1/"), "https://x.test");
  assert.equal(normalizeBaseUrl(""), "https://api.openai.com", "falls back on empty");
  assert.equal(normalizeBaseUrl(null), "https://api.openai.com");
});

test("realtimeUrl builds a ws URL with encoded model", () => {
  assert.equal(
    realtimeUrl("https://api.openai.com/v1", "gpt-realtime"),
    "wss://api.openai.com/v1/realtime?model=gpt-realtime",
  );
  assert.equal(
    realtimeUrl("http://localhost:8080", "a b"),
    "ws://localhost:8080/v1/realtime?model=a%20b",
    "http -> ws and model is URL-encoded",
  );
});

test("azureRealtimeUrl supports v1 and beta protocols", () => {
  assert.equal(
    azureRealtimeUrl("https://r.azure.test/", "dep", "2025-01-01", "v1"),
    "wss://r.azure.test/openai/v1/realtime?model=dep&api-version=2025-01-01",
  );
  assert.equal(
    azureRealtimeUrl("https://r.azure.test", "dep", "2025-01-01", "beta"),
    "wss://r.azure.test/openai/realtime?api-version=2025-01-01&deployment=dep",
  );
});

test("parseBooleanValue handles booleans, tokens, fallback, and throws", () => {
  assert.equal(parseBooleanValue(undefined, true), true);
  assert.equal(parseBooleanValue("", false), false);
  assert.equal(parseBooleanValue(true), true);
  assert.equal(parseBooleanValue("YES"), true);
  assert.equal(parseBooleanValue("off"), false);
  assert.throws(() => parseBooleanValue("maybe"), /Expected boolean value/);
});

test("parseRealtimeSpeed enforces the 0.25-1.5 range", () => {
  assert.equal(parseRealtimeSpeed(undefined), 1.0);
  assert.equal(parseRealtimeSpeed("1.25"), 1.25);
  assert.throws(() => parseRealtimeSpeed("0.1"), /between 0.25 and 1.5/);
  assert.throws(() => parseRealtimeSpeed("2"), /between 0.25 and 1.5/);
  assert.throws(() => parseRealtimeSpeed("nan"), /between 0.25 and 1.5/);
});

test("parseVadThreshold enforces the 0-1 range", () => {
  assert.equal(parseVadThreshold(undefined), 0.7);
  assert.equal(parseVadThreshold("0.3"), 0.3);
  assert.throws(() => parseVadThreshold("-0.1"), /between 0 and 1/);
  assert.throws(() => parseVadThreshold("1.5"), /between 0 and 1/);
});

test("estimateRealtimeTokensForText is ~chars/4 plus a floor", () => {
  assert.equal(estimateRealtimeTokensForText(""), 4);
  assert.equal(estimateRealtimeTokensForText("12345678"), 6); // 8/4 + 4
  assert.equal(estimateRealtimeTokensForText(null), 4, "nullish treated as empty");
});

test("TOOL_OUTPUT_CAP is the 16k default truncation cap", () => {
  assert.equal(TOOL_OUTPUT_CAP, 16_000);
});

test("truncateToolOutput keeps short text and truncates longer text with a suffix", () => {
  assert.equal(truncateToolOutput("short"), "short");
  assert.equal(truncateToolOutput("aaaaa", 5), "aaaaa", "text exactly at the cap is unchanged");
  assert.equal(truncateToolOutput("x".repeat(20), 5), "xxxxx\n\n[truncated 15 chars]");
  assert.equal(truncateToolOutput(null), "");
  assert.equal(truncateToolOutput(undefined), "");
});

test("numberEnv parses a numeric env var and falls back otherwise", () => {
  const name = "RT_TEST_NUMBER_ENV";
  try {
    delete process.env[name];
    assert.equal(numberEnv(name, 7), 7, "fallback when unset");
    process.env[name] = "42";
    assert.equal(numberEnv(name, 7), 42);
    process.env[name] = "not-a-number";
    assert.equal(numberEnv(name, 7), 7, "fallback when non-numeric");
  } finally {
    delete process.env[name];
  }
});

// --- realtime-audio.js ---

test("audio format constants match the fixed realtime PCM format", () => {
  assert.equal(SAMPLE_RATE, 24000);
  assert.equal(CHANNELS, 1);
  assert.equal(SAMPLE_WIDTH, 2);
});

test("pcmBytesForMs and audioDurationMs round-trip", () => {
  assert.equal(pcmBytesForMs(1000), SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH);
  assert.equal(pcmBytesForMs(0), 0);
  const buf = Buffer.alloc(pcmBytesForMs(500));
  assert.equal(audioDurationMs(buf), 500);
});

test("synthTone returns a non-empty 16-bit PCM buffer of the expected length", () => {
  const pcm = synthTone({ frequency: 440, durationMs: 100 });
  const expectedSamples = Math.floor(SAMPLE_RATE * 100 / 1000);
  assert.equal(pcm.length, expectedSamples * SAMPLE_WIDTH);
  assert.ok(pcm.length > 0);
});

test("concatPcm joins buffers and drops falsy entries", () => {
  const out = concatPcm(Buffer.from([1, 2]), null, undefined, Buffer.from([3]));
  assert.deepEqual([...out], [1, 2, 3]);
});

test("chimePcm yields audio for each known kind and a default", () => {
  for (const kind of ["listen", "speech-start", "speech-end", "unknown"]) {
    assert.ok(chimePcm(kind).length > 0, `${kind} chime should be non-empty`);
  }
});

test("formatDurationMs formats seconds and guards non-positive/NaN", () => {
  assert.equal(formatDurationMs(1500), "1.5s");
  assert.equal(formatDurationMs(0), "0.0s");
  assert.equal(formatDurationMs(-10), "0.0s");
  assert.equal(formatDurationMs(NaN), "0.0s");
});
