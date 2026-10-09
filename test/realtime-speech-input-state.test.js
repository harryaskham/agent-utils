import test from "node:test";
import assert from "node:assert/strict";

import {
  SPEECH_INPUT_MODES,
  SpeechInputStateMachine,
} from "../extensions/lib/realtime-speech-input-state.js";

test("editor speech state machine validates and reports explicit modes", () => {
  const state = new SpeechInputStateMachine();
  assert.deepEqual(state.snapshot(), { mode: "idle" });
  for (const mode of ["ptt", "vad", "realtime", "idle"]) {
    assert.equal(state.transition(mode), mode);
    assert.deepEqual(state.snapshot(), { mode });
  }
  assert.throws(() => state.transition("mystery"), /unsupported speech input mode/);
});

test("idle Space and Ctrl-Space never start capture from a focus-blind listener", () => {
  const state = new SpeechInputStateMachine();
  for (const key of [" ", "\u0000", "\x1b[32;5u"]) {
    assert.deepEqual(state.terminalAction(key, { editorEmpty: true }), { action: "pass", consume: false });
  }
});

test("Ctrl-Space reaches the registered shortcut instead of raw VAD/Realtime control", () => {
  for (const mode of Object.values(SPEECH_INPUT_MODES)) {
    const state = new SpeechInputStateMachine(mode);
    for (const key of ["\u0000", "\x1b[32;5u"]) assert.deepEqual(state.terminalAction(key), { action: "pass", consume: false });
  }
});

test("PTT release keys map to send, preserve, and cancel actions", () => {
  const state = new SpeechInputStateMachine(SPEECH_INPUT_MODES.PTT);
  for (const key of [" ", "\r", "\n"]) {
    assert.deepEqual(state.terminalAction(key), { action: "commit-send", consume: true });
  }
  assert.deepEqual(state.terminalAction("\u001b"), { action: "preserve", consume: true });
  assert.deepEqual(state.terminalAction("\u0003"), { action: "cancel", consume: true });
  assert.deepEqual(state.terminalAction("x"), { action: "pass", consume: false });
});
