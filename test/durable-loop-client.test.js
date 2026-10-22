// loop.mjs's client part for pi-client (extensions/durable/loop-client.js, bd-27804c).
import test from "node:test";
import assert from "node:assert/strict";

import loopClient, { liveLoops, loopStatus, shortDuration } from "../extensions/durable/loop-client.js";

const T0 = 1_700_000_000_000;
const doc = {
  last: 2,
  loops: {
    1: { taskId: "11", prompt: "Check the inbox", intervalSecs: 300, deliverAs: "followUp", startedAt: T0, conversationId: 1 },
    2: { taskId: "12", prompt: "Hourly", intervalSecs: 3600, deliverAs: "followUp", startedAt: T0, conversationId: 1 },
    3: { taskId: "13", prompt: "Stopped", intervalSecs: 60, deliverAs: "followUp", startedAt: T0, conversationId: 1, stopped: true },
  },
};

test("the status line: live loops, their intervals and next firings", () => {
  assert.deepEqual(liveLoops(doc).map((loop) => loop.number), [1, 2]);
  assert.equal(loopStatus(doc, T0 + 120_000), "⟳ 2 loops · #1 every 5m (next 3m) · #2 every 1h (next 58m)");
  assert.equal(loopStatus({ last: 0, loops: {} }, T0), undefined);
  assert.equal(loopStatus(null, T0), undefined);
  assert.deepEqual([shortDuration(45_000), shortDuration(5_400_000), shortDuration(90_000_000)], ["45s", "1h30m", "1d1h"]);
});

test("it follows the focused session's loops document, and the next one when focus moves", async () => {
  const handlers = new Map();
  const statuses = [];
  const watches = [];
  const ctx = (session) => ({
    chord: {
      async watchDocument(address, onValue) {
        const watch = { session, address, onValue, stopped: false };
        watches.push(watch);
        return () => (watch.stopped = true);
      },
    },
    ui: { setStatus: (key, text) => statuses.push([key, text]) },
  });
  loopClient({ on: (type, handler) => handlers.set(type, handler) }, { now: () => T0 + 120_000, setTimer: () => 1, clearTimer: () => {} });
  await handlers.get("session_start")({}, ctx("a"));
  assert.deepEqual(watches[0].address, { kind: "agent-utils.loops", version: 1, scope: "session" });
  watches[0].onValue(doc);
  assert.deepEqual(statuses.at(-1), ["agent-utils-loops", "⟳ 2 loops · #1 every 5m (next 3m) · #2 every 1h (next 58m)"]);
  // Another pane focused: the first watch stops; the line follows the other session.
  await handlers.get("session_start")({}, ctx("b"));
  assert.equal(watches[0].stopped, true);
  assert.deepEqual(statuses.at(-1), ["agent-utils-loops", undefined]);
  watches[1].onValue({ last: 1, loops: { 1: { ...doc.loops[1] } } });
  assert.match(statuses.at(-1)[1], /^⟳ 1 loop · #1 every 5m/);
  // A late value of the first session's watch changes nothing.
  watches[0].onValue({ last: 0, loops: {} });
  assert.match(statuses.at(-1)[1], /^⟳ 1 loop/);
});

test("without pi-client's ctx.chord (TUI Pi) it does nothing", async () => {
  const handlers = new Map();
  const statuses = [];
  loopClient({ on: (type, handler) => handlers.set(type, handler) });
  await handlers.get("session_start")({}, { ui: { setStatus: (...args) => statuses.push(args) } });
  assert.equal(statuses.length, 0);
});
