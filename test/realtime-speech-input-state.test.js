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

test("idle Space starts PTT only for an empty editor and enabled shortcuts", () => {
  const state = new SpeechInputStateMachine();
  assert.deepEqual(state.terminalAction(" ", { editorEmpty: true }), { action: "start-ptt", consume: true });
  assert.deepEqual(state.terminalAction(" ", { editorEmpty: false }), { action: "pass", consume: false });
  assert.deepEqual(state.terminalAction(" ", { editorEmpty: true, shortcutsEnabled: false }), { action: "pass", consume: false });
});

test("Ctrl-Space toggles always-listening VAD without affecting Realtime", () => {
  const state = new SpeechInputStateMachine();
  assert.deepEqual(state.terminalAction("\u0000", { editorEmpty: true }), { action: "start-vad", consume: true });
  state.transition(SPEECH_INPUT_MODES.VAD);
  assert.deepEqual(state.terminalAction("\u0000"), { action: "stop-vad", consume: true });
  state.transition(SPEECH_INPUT_MODES.REALTIME);
  assert.deepEqual(state.terminalAction("\u0000"), { action: "pass", consume: false });
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
