// /loop for pi-daemon sessions as Durable background tasks (extensions/durable/loop.mjs): the
// /loop and /loops commands and the agent's create_loop/list_loops/stop_loop tools share one
// registry document; a stop wakes the loop's task, which ends without delivering.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOOPS_DOC,
  LOOP_TASK,
  createLoopCommands,
  createLoopTask,
  createLoopTools,
  formatInterval,
  nextFireAt,
  parseIntervalSpec,
  timestampPrefix,
} from "../extensions/lib/durable-loop.js";

test("intervals parse like the TUI /loop, with a floor, and missed ticks are skipped", () => {
  assert.equal(parseIntervalSpec("5m"), 300);
  assert.equal(parseIntervalSpec("1h30m"), 5400);
  assert.equal(parseIntervalSpec("10s"), 30, "clamped to the minimum");
  assert.equal(parseIntervalSpec("10s", 1), 10);
  assert.equal(parseIntervalSpec("soon"), null);
  assert.equal(parseIntervalSpec("10"), 600, "a bare number is minutes, as in the TUI /loop");
  assert.equal(formatInterval(5400), "90m");
  assert.equal(nextFireAt(1000, 100, 1350), 1400, "missed ticks are skipped, not replayed");
  assert.match(timestampPrefix(new Date("2026-10-19T15:04:05Z"), "UTC"), /^\[2026-10-19 15:04:05 UTC\]$/);
});

/** A Durable session as far as the loop uses it: documents, tasks and their aborts. */
function durable() {
  const docs = new Map();
  const tasks = [];
  let next = 0;
  const tx = {
    async doc(token) {
      if (!docs.has(token.definition.kind)) docs.set(token.definition.kind, token.definition.initial());
      return docs.get(token.definition.kind);
    },
    async createTask(task, input, options) {
      const id = `t${++next}`;
      tasks.push({ record: { id, kind: task.definition.name, conversationId: options.conversationId, input, background: options.background, state: { checkpoint: task.definition.initial(input) } } });
      return id;
    },
  };
  const commit = async (change) => JSON.parse(JSON.stringify((await change(tx)) ?? null));
  const registry = () => docs.get(LOOPS_DOC.definition.kind);
  return { docs, tasks, tx, commit, registry };
}

function commandContext(store, conversationId = "c1") {
  const notices = [];
  return {
    notices,
    ctx: {
      sessionId: "s",
      conversationId,
      context: {},
      notify: (text) => notices.push(text),
      harness: {
        commit: (change) => store.commit(change),
        inspect: async () => ({ tasks: store.tasks }),
      },
    },
  };
}

test("/loop and /loops run several numbered loops, list them and stop one or all, as the TUI /loop", async () => {
  let clock = 1_000_000;
  const task = createLoopTask();
  const { loop, loops } = createLoopCommands({ task, now: () => clock });
  const store = durable();
  const { ctx, notices } = commandContext(store);

  await loop.run("5m Check the inbox", ctx);
  await loop.run("10 --steer Run the tests", ctx);
  await loop.run("1h Tidy the notes", ctx);
  assert.equal(store.tasks.length, 3);
  assert.ok(store.tasks.every((entry) => entry.record.kind === LOOP_TASK && entry.record.background === true));
  assert.deepEqual(store.tasks[0].record.input, { number: 1, prompt: "Check the inbox", intervalSecs: 300, deliverAs: "followUp", firstAt: 1_000_000, startedAt: 1_000_000 });
  assert.equal(notices[0], 'Loop #1 started: "Check the inbox" every 5m. Stop with /loop stop 1');
  assert.deepEqual(Object.keys(store.registry().loops), ["1", "2", "3"]);
  assert.equal(store.registry().loops["2"].taskId, "t2");

  clock += 3 * 60_000;
  await loops.run("", ctx);
  assert.equal(notices.at(-1), ['#1: every 5m — "Check the inbox" (running 3m)', '#2: every 10m (steer) — "Run the tests" (running 3m)', '#3: every 1h — "Tidy the notes" (running 3m)'].join("\n"));

  // Stop one by number: its registry entry is marked, and the others go on.
  await loop.run("stop 2", ctx);
  assert.equal(notices.at(-1), "Loop #2 stopped.");
  assert.equal(store.registry().loops["2"].stopped, true);
  await loop.run("stop 2", ctx);
  assert.equal(notices.at(-1), "No loop #2 found.");
  await loop.run("stop two", ctx);
  assert.equal(notices.at(-1), 'Invalid loop id "two".');
  await loop.run("list", ctx);
  assert.match(notices.at(-1), /^#1: .*\n#3: /);
  await loop.run("end", ctx);
  assert.equal(notices.at(-1), "Stopped 2 loop(s).");
  await loop.run("off", ctx);
  assert.equal(notices.at(-1), "No active loops to stop.");

  // An entry whose task is gone (it ended without cleaning up) is dropped.
  store.tasks.splice(0);
  store.registry().loops["9"] = { taskId: "t9", prompt: "ghost", intervalSecs: 60, startedAt: clock };
  await loops.run("", ctx);
  assert.equal(notices.at(-1), "No active loops.");

  // A loop started before the registry existed is adopted with its number, then listed and stopped.
  store.tasks.push({ record: { id: "t-old", kind: LOOP_TASK, conversationId: "c1", input: { number: 12, prompt: "old loop", intervalSecs: 1800, deliverAs: "followUp", startedAt: clock } } });
  await loops.run("", ctx);
  assert.equal(notices.at(-1), '#12: every 30m — "old loop" (running 0s)');
  await loop.run("5m next one", ctx);
  assert.match(notices.at(-1), /^Loop #13 started/);
  await loop.run("stop 12", ctx);
  assert.equal(notices.at(-1), "Loop #12 stopped.");

  await loop.run("soon do things", ctx);
  assert.equal(notices.at(-1), 'Invalid interval "soon". Use e.g. 30s, 5m, 1h.');
  await loop.run("", ctx);
  assert.match(notices.at(-1), /^Usage: \/loop/);
  await loop.run("5m x", { notify: (text) => notices.push(text) });
  assert.match(notices.at(-1), /pi-daemon 1\.10/);
});

test("the agent manages its own loops with create_loop, list_loops and stop_loop, sharing numbers with /loop", async () => {
  const clock = 2_000_000;
  const task = createLoopTask();
  const store = durable();
  const tools = Object.fromEntries(createLoopTools({ task, now: () => clock }).map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools), ["create_loop", "list_loops", "stop_loop"]);
  const api = { conversationId: "c2", commit: (change) => store.commit(change) };
  const { loop } = createLoopCommands({ task, now: () => clock });
  const { ctx, notices } = commandContext(store, "c2");

  await loop.run("5m From the operator", ctx);
  const created = await tools.create_loop.execute({ interval: "30m", prompt: "Watch the queue", steer: true }, api, {});
  assert.equal(created.content[0].text, 'Loop #2 started: "Watch the queue" every 30m. Stop with stop_loop {"id": 2}.');
  assert.deepEqual(created.details, { id: 2, intervalSecs: 1800, deliverAs: "steer" });
  assert.equal(store.tasks[1].record.conversationId, "c2");

  const listed = await tools.list_loops.execute({}, api, {});
  assert.deepEqual(listed.details.loops.map((entry) => entry.id), [1, 2]);
  assert.match(listed.content[0].text, /#2: every 30m \(steer\) — "Watch the queue"/);

  assert.equal((await tools.stop_loop.execute({ id: 1 }, api, {})).content[0].text, "Loop #1 stopped.");
  await loop.run("list", ctx);
  assert.match(notices.at(-1), /^#2: /);
  assert.equal((await tools.stop_loop.execute({ all: true }, api, {})).content[0].text, "Stopped 1 loop(s).");
  assert.equal((await tools.list_loops.execute({}, api, {})).content[0].text, "No active loops.");

  const bad = await tools.create_loop.execute({ interval: "soon", prompt: "x" }, api, {});
  assert.equal(bad.isError, true);
  assert.equal((await tools.create_loop.execute({ interval: "5m", prompt: " " }, api, {})).isError, true);
});

/** Run the loop task's phase once over a fake runtime; `stopDuringSleep` stops it mid-sleep. */
async function tick(input, checkpoint, { busy = false, now = 2_000, stopped = false, stopDuringSleep = false } = {}) {
  const submitted = [];
  const commits = [];
  const waits = [];
  let idleWaits = 0;
  const store = durable();
  const doc = await store.tx.doc(LOOPS_DOC);
  doc.loops[String(input.number)] = { taskId: "t9", prompt: input.prompt, intervalSecs: input.intervalSecs, startedAt: 0, ...(stopped ? { stopped: true } : {}) };
  let listener;
  const watch = {
    get value() {
      return JSON.parse(JSON.stringify(doc));
    },
    start: (callback) => (listener = callback),
    stop: async () => "stopped",
  };
  const wait = async (ms, signal) => {
    waits.push(ms);
    if (!stopDuringSleep) return;
    doc.loops[String(input.number)].stopped = true;
    await listener?.(JSON.parse(JSON.stringify(doc)));
    if (signal.aborted) throw new Error("woken");
  };
  const task = createLoopTask({ now: () => now, wait, timeZone: "UTC" });
  const conversation = {
    async submit(submission) {
      if (busy && submission.whenBusy === "reject") {
        const error = new Error("busy");
        error.name = "ConversationBusy";
        throw error;
      }
      submitted.push(submission);
    },
    async waitForIdle() {
      idleWaits += 1;
    },
  };
  const runtime = {
    taskId: "t9",
    conversationId: "c1",
    signal: new AbortController().signal,
    watchDoc: async () => watch,
    conversation: async () => conversation,
    commit: async (change) => commits.push(await change(store.tx)),
  };
  await task.definition.phases.wait({ input, state: { status: "running", checkpoint } }, runtime, {});
  return { submitted, commits, waits, idleWaits, registry: doc };
}

test("a tick waits until nextAt, delivers once and commits the next tick; a stop ends it without delivering", async () => {
  const input = { number: 4, prompt: "Check the inbox", intervalSecs: 1, deliverAs: "followUp", firstAt: 1_500, startedAt: 1_000 };
  const idle = await tick(input, { phase: "wait", nextAt: 1_500, fired: 0 });
  assert.deepEqual(idle.waits, [-500]);
  assert.deepEqual(idle.submitted.map((submission) => [submission.whenBusy, submission.requestId]), [["reject", "loop:t9:1"]]);
  assert.match(idle.submitted[0].content, /^\[1970-01-01 00:00:02 UTC\] Check the inbox$/);
  assert.deepEqual(idle.commits, [{ status: "running", checkpoint: { phase: "wait", nextAt: 2_500, fired: 1, lastAt: 2_000 } }]);

  const busy = await tick(input, { phase: "wait", nextAt: 1_500, fired: 4 }, { busy: true });
  assert.equal(busy.idleWaits, 1);
  assert.deepEqual(busy.submitted.map((submission) => [submission.whenBusy, submission.requestId]), [["followUp", "loop:t9:5"]]);
  const steer = await tick({ ...input, deliverAs: "steer" }, { phase: "wait", nextAt: 1_500, fired: 0 }, { busy: true });
  assert.deepEqual(steer.submitted.map((submission) => submission.whenBusy), ["steer"]);

  // Stopped already, or while asleep: no delivery, the entry is removed and the task ends.
  for (const options of [{ stopped: true }, { stopDuringSleep: true }]) {
    const ended = await tick(input, { phase: "wait", nextAt: 1_500, fired: 2 }, options);
    assert.deepEqual(ended.submitted, []);
    assert.deepEqual(ended.commits, [{ status: "terminal", outcome: { status: "completed", result: { stopped: true } } }]);
    assert.equal(ended.registry.loops["4"], undefined);
  }
});

test("aborting the loop task removes its entry and commits an aborted outcome", async () => {
  const store = durable();
  (await store.tx.doc(LOOPS_DOC)).loops["7"] = { taskId: "t7" };
  const commits = [];
  await createLoopTask().definition.abort({ input: { number: 7 } }, { commit: async (change) => commits.push(await change(store.tx)) }, {});
  assert.deepEqual(commits, [{ status: "terminal", outcome: { status: "aborted", reason: "loop stopped" } }]);
  assert.equal(store.registry().loops["7"], undefined);
});

test("/loop completes its arguments as Pi's commands do: the verbs, and after stop the live loops", async () => {
  const task = createLoopTask();
  const { loop } = createLoopCommands({ task, now: () => 1_000_000 });
  const store = durable();
  const { ctx } = commandContext(store);
  // The registry read without a commit, as completions run per keystroke.
  ctx.harness.snapshot = async (token) => store.docs.get(token.definition.kind);
  await loop.run("5m Check the inbox", ctx);
  await loop.run("1h Tidy the notes", ctx);
  assert.deepEqual((await loop.getArgumentCompletions("", ctx)).map((item) => item.value), ["list", "stop "]);
  assert.deepEqual((await loop.getArgumentCompletions("st", ctx)).map((item) => item.value), ["stop "]);
  assert.deepEqual(await loop.getArgumentCompletions("stop ", ctx), [
    { value: "stop all", label: "all", description: "Stop every loop" },
    { value: "stop 1", label: "#1", description: "Check the inbox" },
    { value: "stop 2", label: "#2", description: "Tidy the notes" },
  ]);
  assert.deepEqual((await loop.getArgumentCompletions("off 2", ctx)).map((item) => item.value), ["off 2"]);
  // An interval and a prompt: nothing to complete.
  assert.equal(await loop.getArgumentCompletions("5m check", ctx), null);
});
