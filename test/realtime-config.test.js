import test from "node:test";
import assert from "node:assert/strict";

import {
  buildServerVadTurnDetection,
  makeInitialConfig,
} from "../extensions/lib/realtime-config.js";

// Dedicated tests for the pure env-driven realtime config builders (bd-80fc47).
// makeInitialConfig reads many PI_RT_*/OPENAI_*/AZURE_* vars, so each case runs
// against a clean, namespaced env that is restored afterward (hermetic). Model
// and voice fields delegate to realtime-models and are not asserted here.

const RT_ENV = /^(PI_RT_|OPENAI_|AZURE_|TTS_REALTIME_)/;

// Clear all realtime-namespaced env, apply overrides, and return a restore fn.
function withEnv(overrides = {}) {
  const saved = {};
  for (const k of Object.keys(process.env)) {
    if (RT_ENV.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return () => {
    for (const k of Object.keys(process.env)) if (RT_ENV.test(k)) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
  };
}

test("buildServerVadTurnDetection: fixed fields, env defaults, and option overrides", () => {
  let restore = withEnv();
  try {
    const d = buildServerVadTurnDetection();
    assert.equal(d.type, "server_vad");
    assert.equal(d.create_response, false);
    assert.equal(d.interrupt_response, true);
    assert.equal(d.threshold, 0.7);
    assert.equal(d.prefix_padding_ms, 300);
    assert.equal(d.silence_duration_ms, 1100);
  } finally { restore(); }

  // Env supplies the defaults when no options are passed.
  restore = withEnv({
    PI_RT_VAD_THRESHOLD: "0.5",
    PI_RT_VAD_PREFIX_PADDING_MS: "200",
    PI_RT_VAD_SILENCE_MS: "900",
  });
  try {
    const d = buildServerVadTurnDetection();
    assert.equal(d.threshold, 0.5);
    assert.equal(d.prefix_padding_ms, 200);
    assert.equal(d.silence_duration_ms, 900);
    // Options win over env.
    const o = buildServerVadTurnDetection({ threshold: 0.33, prefixPaddingMs: 150, silenceMs: 600 });
    assert.equal(o.threshold, 0.33);
    assert.equal(o.prefix_padding_ms, 150);
    assert.equal(o.silence_duration_ms, 600);
  } finally { restore(); }
});

test("makeInitialConfig: stable defaults on a clean environment", () => {
  const restore = withEnv();
  try {
    const c = makeInitialConfig();
    assert.equal(c.baseUrl, "https://api.openai.com");
    assert.equal(c.directAzure, false);
    assert.equal(c.azureApiVersion, "2025-04-01-preview");
    assert.equal(c.azureProtocol, "v1");
    assert.equal(c.speed, 1.0);
    assert.equal(c.vadThreshold, 0.7);
    assert.equal(c.bufferMs, 180);
    assert.equal(c.playbackChunkMs, 80);
    assert.equal(c.reasoningEffort, "off");
    assert.equal(c.sendReasoning, false);
    assert.equal(c.audioEnabled, true);
    assert.equal(c.chimeEnabled, true);
    assert.equal(c.summaryContext, false);
    assert.equal(c.debug, false);
    assert.equal(c.statusWidgetVisible, false);
    assert.equal(c.autoReconnect, false);
    assert.equal(c.reconnectAttempts, 0);
    assert.equal(c.reconnectMaxAttempts, 5);
    assert.equal(c.reconnectBaseDelayMs, 1000);
    assert.equal(c.recordCommand, undefined);
    assert.equal(c.playbackCommand, undefined);
  } finally { restore(); }
});

test("makeInitialConfig: env overrides are reflected", () => {
  const restore = withEnv({
    PI_RT_BASE_URL: "http://localhost:9999",
    PI_RT_REASONING_EFFORT: "high",
    PI_RT_BUFFER_MS: "250",
    PI_RT_PLAYBACK_CHUNK_MS: "40",
    PI_RT_DEBUG: "1",
    PI_RT_SUMMARY: "true",
    PI_RT_SEND_REASONING: "yes",
    PI_RT_RECONNECT_MAX_ATTEMPTS: "9",
    PI_RT_RECORD_CMD: "rec-cmd",
  });
  try {
    const c = makeInitialConfig();
    assert.equal(c.baseUrl, "http://localhost:9999");
    assert.equal(c.reasoningEffort, "high");
    assert.equal(c.bufferMs, 250);
    assert.equal(c.playbackChunkMs, 40);
    assert.equal(c.debug, true);
    assert.equal(c.summaryContext, true);
    assert.equal(c.sendReasoning, true);
    assert.equal(c.reconnectMaxAttempts, 9);
    assert.equal(c.recordCommand, "rec-cmd");
  } finally { restore(); }
});

test("makeInitialConfig: directAzure is detected from either flag", () => {
  for (const overrides of [{ PI_RT_DIRECT_AZURE: "1" }, { PI_RT_PROVIDER: "azure" }, { PI_RT_PROVIDER: "AZURE" }]) {
    const restore = withEnv(overrides);
    try {
      assert.equal(makeInitialConfig().directAzure, true, JSON.stringify(overrides));
    } finally { restore(); }
  }
  const restore = withEnv({ PI_RT_PROVIDER: "openai" });
  try {
    assert.equal(makeInitialConfig().directAzure, false);
  } finally { restore(); }
});

test("makeInitialConfig: audio-disable inverts audioEnabled and chime can be turned off", () => {
  let restore = withEnv({ PI_RT_DISABLE_AUDIO: "1" });
  try {
    assert.equal(makeInitialConfig().audioEnabled, false);
  } finally { restore(); }

  restore = withEnv({ PI_RT_CHIME: "0" });
  try {
    assert.equal(makeInitialConfig().chimeEnabled, false);
  } finally { restore(); }
});
