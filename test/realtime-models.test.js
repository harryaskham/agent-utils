import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_MODEL,
  DEFAULT_TRANSCRIPTION_MODEL,
  DEFAULT_VOICE,
  isRealtimeModel,
  normalizeRealtimeModelId,
  normalizeTranscriptionModel,
  resolveRealtimeVoice,
  shouldAutoRestartMicMode,
} from "../extensions/lib/realtime-models.js";

// Set the voice-related env vars to known values (or clear them) with restore.
function withVoiceEnv({ PI_RT_VOICE, OPENAI_TTS_VOICE, TTS_VOICE }, fn) {
  const keys = ["PI_RT_VOICE", "OPENAI_TTS_VOICE", "TTS_VOICE"];
  const orig = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const next = { PI_RT_VOICE, OPENAI_TTS_VOICE, TTS_VOICE };
  try {
    for (const k of keys) {
      if (next[k] === undefined) delete process.env[k];
      else process.env[k] = next[k];
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  }
}

test("normalizeRealtimeModelId trims, strips provider prefix, and falls back", () => {
  assert.equal(normalizeRealtimeModelId(""), DEFAULT_MODEL);
  assert.equal(normalizeRealtimeModelId(null), DEFAULT_MODEL);
  assert.equal(normalizeRealtimeModelId("  gpt-realtime  "), "gpt-realtime");
  assert.equal(normalizeRealtimeModelId("gpt-realtime-2"), "gpt-realtime-2");
  assert.equal(normalizeRealtimeModelId("openai/gpt-realtime"), "gpt-realtime");
  // unknown id (with or without provider prefix) -> default.
  assert.equal(normalizeRealtimeModelId("provider/unknown-model"), DEFAULT_MODEL);
  assert.equal(normalizeRealtimeModelId("gpt-4o"), DEFAULT_MODEL);
});

test("normalizeTranscriptionModel maps whisper/empty to the realtime default", () => {
  assert.equal(normalizeTranscriptionModel(undefined), DEFAULT_TRANSCRIPTION_MODEL);
  assert.equal(normalizeTranscriptionModel(""), DEFAULT_TRANSCRIPTION_MODEL);
  assert.equal(normalizeTranscriptionModel("whisper"), DEFAULT_TRANSCRIPTION_MODEL);
  assert.equal(normalizeTranscriptionModel("custom-stt"), "custom-stt");
});

test("resolveRealtimeVoice honors env precedence and validates the voice", () => {
  withVoiceEnv({}, () => {
    assert.equal(resolveRealtimeVoice(), DEFAULT_VOICE, "no env -> marin");
  });
  withVoiceEnv({ PI_RT_VOICE: "echo", OPENAI_TTS_VOICE: "sage", TTS_VOICE: "verse" }, () => {
    assert.equal(resolveRealtimeVoice(), "echo", "PI_RT_VOICE wins");
  });
  withVoiceEnv({ OPENAI_TTS_VOICE: "sage", TTS_VOICE: "verse" }, () => {
    assert.equal(resolveRealtimeVoice(), "sage", "OPENAI_TTS_VOICE over TTS_VOICE");
  });
  withVoiceEnv({ TTS_VOICE: "verse" }, () => {
    assert.equal(resolveRealtimeVoice(), "verse", "TTS_VOICE last");
  });
  withVoiceEnv({ PI_RT_VOICE: "bogus-voice" }, () => {
    assert.equal(resolveRealtimeVoice(), DEFAULT_VOICE, "unknown voice -> marin");
  });
  // empty string is skipped by the env reader, falling through to the next key.
  withVoiceEnv({ PI_RT_VOICE: "", OPENAI_TTS_VOICE: "coral" }, () => {
    assert.equal(resolveRealtimeVoice(), "coral");
  });
});

test("isRealtimeModel matches the provider or a gpt-realtime id prefix", () => {
  assert.equal(isRealtimeModel({ provider: "openai-realtime" }), true);
  assert.equal(isRealtimeModel({ id: "gpt-realtime-2" }), true);
  assert.equal(isRealtimeModel({ id: "gpt-realtime" }), true);
  assert.equal(isRealtimeModel({ id: "gpt-4o", provider: "openai" }), false);
  assert.equal(isRealtimeModel({}), false);
  assert.equal(isRealtimeModel(null), false);
});

test("shouldAutoRestartMicMode is true only for vad and continuous", () => {
  assert.equal(shouldAutoRestartMicMode("vad"), true);
  assert.equal(shouldAutoRestartMicMode("continuous"), true);
  assert.equal(shouldAutoRestartMicMode("ptt"), false);
  assert.equal(shouldAutoRestartMicMode(undefined), false);
});
