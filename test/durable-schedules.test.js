// /loop, /after and /cron on Durable's stored sleeps (pi-durable 1.4): a task sleeps until its
// tick holding no invocation, delivers, and commits its next sleep in the same transaction; a
// prompt that is a command runs as one (pi-daemon.command) where the host has it; the commands
// abort sleeping tasks; the loops chip shows an /after's and a /cron's next time.
import test from "node:test";
import assert from "node:assert/strict";

import { LOOPS_DOC, LOOP_TASK, createLoopCommands, createLoopTask, isCommandPrompt } from "../extensions/lib/durable-loop.js";
import { liveLoopSchedules, nextLoopIn } from "../extensions/lib/loop-indicator.js";
import { loopStatus } from "../extensions/durable/loop-client.js";

const COMMAND_SPEC = Symbol.for("pi-daemon.commandTask");

/** A Durable session as far as the schedules use it. */
function durable() {
  const docs = new Map();
  const tasks = [];
  const aborted = [];
  let next = 0;
  const tx = {
    async doc(token) {
      if (!docs.has(token.definition.kind)) docs.set(token.definition.kind, token.definition.initial());
      return docs.get(token.definition.kind);
    },
    async createTask(task, input, options) {
      const id = ++next;
      tasks.push({ record: { id, kind: task.definition.name, version: task.definition.version, conversationId: options.conversationId, input, background: options.background, checkpoint: task.definition.initial(input) } });
      return id;
    },
  };
  // As Durable's: what a change returns is handed back as is, and its drafts fail once settled.
  let settled = false;
  const draft = (value) =>
    value !== null && typeof value === "object"
      ? new Proxy(value, { get: (target, key) => { if (settled) throw new Error("Cannot use a settled overlay"); return draft(target[key]); } })
      : value;
  const commit = async (change) => {
    settled = false;
    const result = await change({ ...tx, doc: async (token) => draft(await tx.doc(token)) });
    settled = true;
    return result;
  };
  return { docs, tasks, aborted, tx, commit, registry: () => docs.get(LOOPS_DOC.definition.kind) };
}

/** A sleeping-capable runtime over `store`, for one phase of the loop task. */
function runtime(store, { now }) {
  const submitted = [];
  const sleeps = [];
  const commits = [];
  return {
    submitted,
    sleeps,
    commits,
    value: {
      taskId: 9,
      conversationId: 1,
      signal: new AbortController().signal,
      snapshot: async () => JSON.parse(JSON.stringify(store.registry() ?? null)),
      conversation: async () => ({ submit: async (submission) => submitted.push(submission), waitForIdle: async () => {} }),
      sleepUntil: async (until, checkpoint) => sleeps.push({ until, checkpoint }),
      commit: async (change) => commits.push(await store.commit(change)),
      now: () => now,
    },
  };
}

async function entry(store, number, fields) {
  (await store.tx.doc(LOOPS_DOC)).loops[String(number)] = { taskId: "9", ...fields };
}

test("a loop sleeps until its tick, delivers, and commits the next sleep at once", async () => {
  const store = durable();
  await entry(store, 1, { prompt: "Check the inbox", intervalSecs: 60, startedAt: 0 });
  const input = { number: 1, prompt: "Check the inbox", intervalSecs: 60, deliverAs: "followUp", firstAt: 60_000, startedAt: 0 };
  const task = createLoopTask({ now: () => 61_000, timeZone: "UTC" });

  // wait: a stored sleep to nextAt, to wake in deliver; nothing delivered.
  const waiting = runtime(store, { now: 61_000 });
  await task.definition.phases.wait({ input, state: { checkpoint: { phase: "wait", nextAt: 60_000, fired: 0 } } }, waiting.value, {});
  assert.deepEqual(waiting.sleeps, [{ until: 60_000, checkpoint: { phase: "deliver", nextAt: 60_000, fired: 0 } }]);
  assert.deepEqual(waiting.submitted, []);

  // deliver: the prompt with the time, then a sleep until the next tick (missed ones skipped).
  const delivering = runtime(store, { now: 61_000 });
  await task.definition.phases.deliver({ input, state: { checkpoint: { phase: "deliver", nextAt: 60_000, fired: 0 } } }, delivering.value, {});
  assert.deepEqual(delivering.submitted.map((s) => [s.content, s.requestId]), [["[1970-01-01 00:01:01 UTC] Check the inbox", "loop:9:1"]]);
  assert.deepEqual(delivering.commits, [{ status: "sleeping", until: 120_000, checkpoint: { phase: "deliver", nextAt: 120_000, fired: 1, lastAt: 61_000 } }]);

  // Stopped: no delivery, the entry gone, the task done.
  store.registry().loops["1"].stopped = true;
  const stopped = runtime(store, { now: 121_000 });
  await task.definition.phases.deliver({ input, state: { checkpoint: { phase: "deliver", nextAt: 120_000, fired: 1 } } }, stopped.value, {});
  assert.deepEqual(stopped.submitted, []);
  assert.deepEqual(stopped.commits, [{ status: "terminal", outcome: { status: "completed", result: { stopped: true } } }]);
  assert.equal(store.registry().loops["1"], undefined);
});

test("a command prompt runs as a command (pi-daemon.command) where the host has it, else is sent as text", async () => {
  assert.equal(isCommandPrompt("/compact"), true);
  assert.equal(isCommandPrompt("!make test"), true);
  assert.equal(isCommandPrompt("check /tmp"), false);
  assert.equal(isCommandPrompt("/"), false);
  const input = { number: 2, prompt: "/compact", intervalSecs: 60, deliverAs: "followUp", firstAt: 0, startedAt: 0 };
  const task = createLoopTask({ now: () => 1_000, timeZone: "UTC" });

  // No pi-daemon.command (an older host): the text, as before.
  const old = durable();
  await entry(old, 2, { prompt: "/compact", intervalSecs: 60, startedAt: 0 });
  const sent = runtime(old, { now: 1_000 });
  await task.definition.phases.deliver({ input, state: { checkpoint: { phase: "deliver", nextAt: 0, fired: 0 } } }, sent.value, {});
  assert.equal(sent.submitted.length, 1);
  assert.equal(old.tasks.length, 0);

  globalThis[COMMAND_SPEC] = { name: "pi-daemon.command", version: 1 };
  try {
    const store = durable();
    await entry(store, 2, { prompt: "/compact", intervalSecs: 60, startedAt: 0 });
    const ran = runtime(store, { now: 1_000 });
    await task.definition.phases.deliver({ input, state: { checkpoint: { phase: "deliver", nextAt: 0, fired: 0 } } }, ran.value, {});
    assert.deepEqual(ran.submitted, [], "not sent to the model");
    assert.deepEqual(
      store.tasks.map((t) => [t.record.kind, t.record.version, t.record.input, t.record.background, t.record.checkpoint]),
      [["pi-daemon.command", 1, { text: "/compact", requestId: "loop:9:1" }, true, { phase: "run" }]],
      "a command task, created with the tick's sleep",
    );
    assert.equal(ran.commits[0].status, "sleeping");
  } finally {
    delete globalThis[COMMAND_SPEC];
  }
});

test("an /after fires once and ends; a /cron sleeps until its next occurrence and keeps it in the document", async () => {
  const store = durable();
  await entry(store, 3, { kind: "after", prompt: "stand up", startedAt: 0, nextAt: 600_000 });
  const after = { number: 3, prompt: "stand up", deliverAs: "followUp", firstAt: 600_000, startedAt: 0, kind: "after" };
  const task = createLoopTask({ now: () => 600_500, timeZone: "UTC" });
  const once = runtime(store, { now: 600_500 });
  await task.definition.phases.deliver({ input: after, state: { checkpoint: { phase: "deliver", nextAt: 600_000, fired: 0 } } }, once.value, {});
  assert.equal(once.submitted.length, 1);
  assert.deepEqual(once.commits, [{ status: "terminal", outcome: { status: "completed", result: { fired: 1 } } }]);
  assert.equal(store.registry().loops["3"], undefined, "gone from the chip and lists");

  // Weekdays at 09:00 in London; delivered Friday 30 Oct 2026 09:00 GMT, next Monday 2 Nov.
  const friday = Date.parse("2026-10-30T09:00:00Z");
  const cron = { number: 4, prompt: "standup notes", deliverAs: "followUp", firstAt: friday, startedAt: 0, kind: "cron", cron: { expression: "0 9 * * 1-5", timeZone: "Europe/London" } };
  await entry(store, 4, { kind: "cron", prompt: "standup notes", startedAt: 0, nextAt: friday, cron: cron.cron });
  const weekly = runtime(store, { now: friday + 2_000 });
  await createLoopTask({ now: () => friday + 2_000, timeZone: "UTC" }).definition.phases.deliver({ input: cron, state: { checkpoint: { phase: "deliver", nextAt: friday, fired: 0 } } }, weekly.value, {});
  const monday = Date.parse("2026-11-02T09:00:00Z");
  assert.deepEqual(weekly.commits, [{ status: "sleeping", until: monday, checkpoint: { phase: "deliver", nextAt: monday, fired: 1, lastAt: friday + 2_000 } }]);
  assert.equal(store.registry().loops["4"].nextAt, monday);
});

test("/after and /cron start schedules; their stops and /loop stop abort the sleeping tasks", async () => {
  const store = durable();
  const notices = [];
  const ctx = {
    sessionId: "s",
    conversationId: 1,
    context: {},
    notify: (text) => notices.push(text),
    harness: {
      commit: (change) => store.commit(change),
      inspect: async () => ({ tasks: store.tasks.filter((t) => !store.aborted.includes(t.record.id)) }),
      snapshot: async () => JSON.parse(JSON.stringify(store.registry() ?? null)),
      abortTask: async (id) => store.aborted.push(id),
    },
  };
  const now = Date.parse("2026-10-30T10:00:00Z");
  const commands = createLoopCommands({ task: createLoopTask(), now: () => now, timeZone: "UTC" });

  await commands.after.run("10m /compact", ctx);
  assert.match(notices.at(-1), /^\/after #1: "\/compact" in 10m/);
  await commands.cron.run("'30 9 * * 1-5' tz=Europe/London check the build", ctx);
  assert.match(notices.at(-1), /^Cron #2: "check the build" at 30 9 \* \* 1-5 \(Europe\/London\), next in /);
  await commands.cron.run("@daily !make backup", ctx);
  assert.match(notices.at(-1), /\(UTC\)/, "the default zone");
  const loops = store.registry().loops;
  assert.deepEqual([loops["1"].kind, loops["1"].nextAt], ["after", now + 600_000]);
  assert.deepEqual([loops["2"].kind, loops["2"].cron, loops["2"].nextAt], ["cron", { expression: "30 9 * * 1-5", timeZone: "Europe/London" }, Date.parse("2026-11-02T09:30:00Z")]);
  assert.deepEqual(store.tasks.map((t) => [t.record.kind, t.record.input.kind, t.record.checkpoint.nextAt]), [
    [LOOP_TASK, "after", now + 600_000],
    [LOOP_TASK, "cron", Date.parse("2026-11-02T09:30:00Z")],
    [LOOP_TASK, "cron", Date.parse("2026-10-31T00:00:00Z")],
  ]);

  await commands.cron.run("list", ctx);
  assert.match(notices.at(-1), /#1: once, in 10m — "\/compact"\n#2: cron 30 9 \* \* 1-5 \(Europe\/London\), next in \d+h — "check the build"\n#3: cron @daily \(UTC\), next in 14h — "!make backup"/);
  await commands.cron.run("bad schedule here x y z", ctx);
  assert.match(notices.at(-1), /cron minute: "bad" is not a number/);

  // Stops abort the sleeping tasks at once.
  await commands.after.run("cancel 1", ctx);
  assert.deepEqual(store.aborted, [1]);
  await commands.cron.run("stop 2", ctx);
  assert.deepEqual(store.aborted, [1, 2]);
  await commands.loop.run("stop all", ctx);
  assert.deepEqual(store.aborted, [1, 2, 3]);
  assert.match(notices.at(-1), /Stopped 1 loop\(s\)\./);
});

test("the loops chip shows an /after's and a /cron's next time", () => {
  const now = 1_000_000;
  const doc = {
    last: 3,
    loops: {
      1: { prompt: "a", intervalSecs: 300, startedAt: now - 60_000 },
      2: { kind: "after", prompt: "b", startedAt: now, nextAt: now + 120_000 },
      3: { kind: "cron", prompt: "c", startedAt: now, nextAt: now + 7_200_000, cron: { expression: "@hourly", timeZone: "UTC" } },
    },
  };
  assert.equal(loopStatus(doc, now), "⟳ 3 loops · #1 every 5m (next 4m) · #2 once (in 2m) · #3 cron (next 2h)");
  assert.deepEqual(liveLoopSchedules(doc), [{ startedAt: now - 60_000, intervalSecs: 300 }, { nextAt: now + 120_000 }, { nextAt: now + 7_200_000 }]);
  assert.equal(nextLoopIn(liveLoopSchedules(doc), now), 120_000);
});
