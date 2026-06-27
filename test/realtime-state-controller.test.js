import test from "node:test";
import assert from "node:assert/strict";

import { RealtimeStateController } from "../extensions/lib/realtime-state-controller.js";

// Dedicated branch-coverage net for RealtimeStateController (bd-41323d). The
// integration test in realtime-agent.test.js covers the happy path; this file
// pins the cross-effect transitions, guards, falsy coercion, and every mode()
// branch — the subtle parts where a state-machine refactor would silently drift.

test("constructor and snapshot expose the default idle lifecycle", () => {
  const state = new RealtimeStateController();
  assert.deepEqual(state.snapshot(), {
    connection: "off",
    connected: false,
    connecting: false,
    phase: "idle",
    micMode: null,
    widgetVisible: false,
    mode: "off",
  });
});

test("setConnection drives phase cross-effects and coerces falsy to off", () => {
  const connecting = new RealtimeStateController();
  connecting.setConnection("connecting");
  assert.equal(connecting.connection, "connecting");
  assert.equal(connecting.phase, "connecting");
  assert.equal(connecting.connecting, true);
  assert.equal(connecting.connected, false);

  const errored = new RealtimeStateController();
  errored.setConnection("error");
  assert.equal(errored.connection, "error");
  assert.equal(errored.phase, "error");

  // connected does not force a phase; a prior non-special phase is preserved.
  const connected = new RealtimeStateController();
  connected.setPhase("speaking");
  connected.setConnection("connected");
  assert.equal(connected.connection, "connected");
  assert.equal(connected.connected, true);
  assert.equal(connected.phase, "speaking");

  // "off"/null/"" all normalize to off and reset a non-replaying phase to idle.
  const off = new RealtimeStateController();
  off.setPhase("speaking");
  off.setConnection("off");
  assert.equal(off.connection, "off");
  assert.equal(off.phase, "idle");
  off.setConnection(null);
  assert.equal(off.connection, "off");
  off.setConnection("");
  assert.equal(off.connection, "off");
});

test("setConnection off preserves an in-flight replaying phase", () => {
  const state = new RealtimeStateController();
  state.setPhase("replaying");
  state.setConnection("off");
  // The phase!=="replaying" guard means replay audio is not cut to idle.
  assert.equal(state.phase, "replaying");
  assert.equal(state.connection, "off");
  assert.equal(state.mode(), "off"); // mode still reports the connection as off
});

test("setPhase drives connection cross-effects and coerces falsy to idle", () => {
  const connecting = new RealtimeStateController();
  connecting.setPhase("connecting");
  assert.equal(connecting.connection, "connecting");

  const errored = new RealtimeStateController();
  errored.setPhase("error");
  assert.equal(errored.connection, "error");

  const idle = new RealtimeStateController();
  idle.setPhase("thinking");
  idle.setPhase(null);
  assert.equal(idle.phase, "idle");
  idle.setPhase("");
  assert.equal(idle.phase, "idle");
});

test("setMicMode and setWidgetVisible coerce their inputs", () => {
  const state = new RealtimeStateController();
  state.setMicMode("ptt");
  assert.equal(state.micMode, "ptt");
  state.setMicMode(null);
  assert.equal(state.micMode, null);
  state.setMicMode("");
  assert.equal(state.micMode, null);

  state.setWidgetVisible(1);
  assert.equal(state.widgetVisible, true);
  state.setWidgetVisible(0);
  assert.equal(state.widgetVisible, false);
  state.setWidgetVisible("shown");
  assert.equal(state.widgetVisible, true);
  state.setWidgetVisible(undefined);
  assert.equal(state.widgetVisible, false);
});

test("mode() maps every connection/phase combination", () => {
  const state = new RealtimeStateController();

  // Connection-level states win regardless of phase.
  assert.equal(state.mode(), "off");
  state.setConnection("connecting");
  assert.equal(state.mode(), "connecting");
  state.setConnection("error");
  assert.equal(state.mode(), "error");

  // Now connected: phase-derived modes.
  state.setConnection("connected");
  state.setMicMode("vad");
  state.setPhase("recording");
  assert.equal(state.mode(), "listen:vad");
  assert.equal(state.mode({ sttOnly: true }), "stt:vad");

  // recording WITHOUT a micMode falls through to the default.
  state.setMicMode(null);
  assert.equal(state.mode(), "connected");
  assert.equal(state.mode({ sttOnly: true }), "stt");

  state.setPhase("transcribing");
  assert.equal(state.mode(), "transcribing");
  state.setPhase("thinking");
  assert.equal(state.mode(), "responding");
  state.setPhase("speaking");
  assert.equal(state.mode(), "speaking");
  state.setPhase("replaying");
  assert.equal(state.mode(), "replaying");

  // Connected + idle is the catch-all: connected, or stt in STT-only mode.
  state.setPhase("idle");
  assert.equal(state.mode(), "connected");
  assert.equal(state.mode({ sttOnly: true }), "stt");
});

test("snapshot merges extra fields and computes the derived mode with them", () => {
  const state = new RealtimeStateController();
  state.setConnection("connected");
  state.setMicMode("ptt");
  state.setPhase("recording");

  const snap = state.snapshot({ sttOnly: true, label: "x" });
  assert.equal(snap.connection, "connected");
  assert.equal(snap.connected, true);
  assert.equal(snap.phase, "recording");
  assert.equal(snap.micMode, "ptt");
  assert.equal(snap.mode, "stt:ptt"); // mode() received the sttOnly extra
  assert.equal(snap.label, "x"); // arbitrary extra fields are merged through
  assert.equal(snap.sttOnly, true);
});
