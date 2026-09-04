import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_SESSION_VOICES, resolveSessionSpeechAssignment, resolveSessionSpeechPolicy, sessionSpeechIdentity } from "../extensions/lib/tts-identity.js";

test("session voice and pan assignment is stable, bounded, and purpose-separated", () => {
  const policy = { voices: ["a", "b", "c"], panMin: -0.9, panMax: 0.9 };
  const first = resolveSessionSpeechAssignment("session-123", policy);
  assert.deepEqual(resolveSessionSpeechAssignment("session-123", policy), first);
  assert.ok(policy.voices.includes(first.voice));
  assert.ok(first.pan >= -0.9 && first.pan <= 0.9);
  assert.notDeepEqual(resolveSessionSpeechAssignment("session-other", policy), first);
});

test("speech policy reads settings and env and defaults to valid MAI Voice 2 Flash pool", () => {
  assert.ok(DEFAULT_SESSION_VOICES.length > 30);
  assert.ok(DEFAULT_SESSION_VOICES.every((voice) => voice.endsWith(":MAI-Voice-2-Flash")));
  assert.deepEqual(resolveSessionSpeechPolicy({ voices: ["x"], panRange: { min: -0.2, max: 0.3 } }, {}), { voices: ["x"], panMin: -0.2, panMax: 0.3 });
  assert.deepEqual(resolveSessionSpeechPolicy({}, { PI_TTS_VOICES: "a,b", PI_TTS_PAN_MIN: "-0.4", PI_TTS_PAN_MAX: "0.5" }), { voices: ["a", "b"], panMin: -0.4, panMax: 0.5 });
});

test("session identity prefers Pi session identity over agent/process fallbacks", () => {
  assert.equal(sessionSpeechIdentity({ sessionManager: { getSessionId: () => "pi-session" } }, { AGENT_ID: "agent" }), "pi-session");
  assert.equal(sessionSpeechIdentity({}, { CACO_AGENT_ID: "caco-agent" }), "caco-agent");
});
