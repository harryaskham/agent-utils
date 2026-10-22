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

test("it follows each session's loops: a status line for the focused one, events for the chips", async () => {
  const { LOOPS_EVENT, LOOPS_REQUEST } = await import("../extensions/lib/loop-indicator.js");
  const handlers = new Map();
  const bus = new Map();
  const events = { on: (name, listener) => bus.set(name, [...(bus.get(name) ?? []), listener]), emit: (name, data) => (bus.get(name) ?? []).forEach((listener) => listener(data)) };
  const published = [];
  events.on(LOOPS_EVENT, (data) => published.push(data));
  const statuses = [];
  const watches = [];
  // pi-client's live ctx: it refers to the pane being drawn, else the focused one.
  let current = "a";
  const ctx = {
    sessionManager: { getSessionId: () => current },
    chord: {
      async watchDocument(address, onValue) {
        const watch = { session: current, address, onValue, stopped: false };
        watches.push(watch);
        return () => (watch.stopped = true);
      },
    },
    ui: { setStatus: (key, text) => statuses.push([key, text]) },
  };
  loopClient({ on: (type, handler) => handlers.set(type, handler), events }, { now: () => T0 + 120_000, setTimer: () => 1, clearTimer: () => {} });
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  assert.deepEqual(watches.map((watch) => [watch.session, watch.address]), [["a", { kind: "agent-utils.loops", version: 1, scope: "session" }]]);
  watches[0].onValue(doc);
  assert.deepEqual(statuses.at(-1), ["agent-utils-loops", "⟳ 2 loops · #1 every 5m (next 3m) · #2 every 1h (next 58m)"]);
  assert.deepEqual(published.at(-1), { sessionId: "a", loops: [{ startedAt: T0, intervalSecs: 300 }, { startedAt: T0, intervalSecs: 3600 }] });
  // Another pane focused: its session is followed too; a's is kept for its pane's chip.
  current = "b";
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  assert.equal(watches[0].stopped, false);
  assert.equal(watches[1].session, "b");
  assert.deepEqual(statuses.at(-1), ["agent-utils-loops", undefined], "b has no loops");
  // A chip asks while it draws a's pane: no status line any more (the chip shows the loops), and
  // a's loops are published again.
  current = "a";
  events.emit(LOOPS_REQUEST, { sessionId: "a" });
  assert.deepEqual(statuses.at(-1), ["agent-utils-loops", undefined]);
  assert.equal(published.at(-1).sessionId, "a");
  // A pane the live ctx is not on is not followed by mistake.
  events.emit(LOOPS_REQUEST, { sessionId: "c" });
  assert.equal(watches.length, 2);
  // Asked for while its pane is drawn, a third session is followed.
  current = "c";
  events.emit(LOOPS_REQUEST, { sessionId: "c" });
  await Promise.resolve();
  assert.deepEqual(watches.map((watch) => watch.session), ["a", "b", "c"]);
  await handlers.get("session_shutdown")({}, ctx);
  assert.ok(watches.every((watch) => watch.stopped));
});

test("without pi-client's ctx.chord (TUI Pi) it does nothing", async () => {
  const handlers = new Map();
  const statuses = [];
  loopClient({ on: (type, handler) => handlers.set(type, handler) });
  await handlers.get("session_start")({}, { ui: { setStatus: (...args) => statuses.push(args) } });
  assert.equal(statuses.length, 0);
});
