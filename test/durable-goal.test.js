// /goal for pi-daemon sessions (extensions/lib/durable-goal.js through loop.mjs): a goal shares the
// loops document and numbers; its task nudges an idle conversation until goal_done ends it, and
// stops on an interruption, repeated failures or its nudge limit.
import test from "node:test";
import assert from "node:assert/strict";

import { LOOPS_DOC, createLoopCommands, createLoopTask } from "../extensions/lib/durable-loop.js";
import {
  GOAL_FAILURE_BACKOFF_MS,
  GOAL_TASK,
  createGoalCommands,
  createGoalTask,
  createGoalTools,
  goalNudge,
  goalSection,
  parseGoalArgs,
} from "../extensions/lib/durable-goal.js";
import { liveLoopSchedules, nextLoopIn } from "../extensions/lib/loop-indicator.js";
import { loopStatus } from "../extensions/durable/loop-client.js";

/** A Durable session as far as loops and goals use it: documents, tasks and their aborts. */
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
      tasks.push({ record: { id, kind: task.definition.name, conversationId: options.conversationId, input, background: options.background } });
      return id;
    },
  };
  const commit = async (change) => JSON.parse(JSON.stringify((await change(tx)) ?? null));
  const registry = () => docs.get(LOOPS_DOC.definition.kind);
  return { docs, tasks, aborted, tx, commit, registry };
}

function commandContext(store, conversationId = 1) {
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
        snapshot: async () => store.registry(),
        abortTask: async (id) => void store.aborted.push(id),
      },
    },
  };
}

test("/goal arguments: a goal with an optional --max, or show, stop and done", () => {
  assert.deepEqual(parseGoalArgs(""), { verb: "show" });
  assert.deepEqual(parseGoalArgs("stop"), { verb: "stop" });
  assert.deepEqual(parseGoalArgs("clear"), { verb: "stop" });
  assert.deepEqual(parseGoalArgs("done"), { verb: "done" });
  assert.deepEqual(parseGoalArgs("all tests pass on main"), { goal: "all tests pass on main", maxNudges: 50 });
  assert.deepEqual(parseGoalArgs("--max 5 ship the release"), { goal: "ship the release", maxNudges: 5 });
  assert.deepEqual(parseGoalArgs("ship it --max=7"), { goal: "ship it", maxNudges: 7 });
  assert.match(parseGoalArgs("ship --max 0").error, /--max/);
  assert.match(parseGoalArgs("--max 3").error, /^Usage/);
});

test("/goal sets one goal per conversation in the loops registry; /loop lists it, and only /goal or its number stop it", async () => {
  let clock = 1_000_000;
  const store = durable();
  const goalTask = createGoalTask();
  const { goal } = createGoalCommands({ task: goalTask, now: () => clock });
  const { loop, loops } = createLoopCommands({ task: createLoopTask(), now: () => clock });
  const { ctx, notices } = commandContext(store);

  await loop.run("5m Check the inbox", ctx);
  await goal.run("--max 20 all tests pass on main", ctx);
  assert.match(notices.at(-1), /^Goal #2 set: "all tests pass on main"\. .*at most 20 times.*Stop with \/goal stop\.$/);
  assert.equal(store.tasks[1].record.kind, GOAL_TASK);
  assert.equal(store.tasks[1].record.background, true);
  assert.deepEqual(store.tasks[1].record.input, { number: 2, goal: "all tests pass on main", maxNudges: 20, startedAt: clock });
  assert.deepEqual(store.registry().loops["2"], { taskId: "2", kind: "goal", prompt: "all tests pass on main", maxNudges: 20, nudges: 0, startedAt: clock, conversationId: 1 });

  clock += 120_000;
  await goal.run("", ctx);
  assert.equal(notices.at(-1), '#2: goal — "all tests pass on main" (0 nudges of 20, running 2m)');
  await loops.run("", ctx);
  assert.equal(notices.at(-1), '#1: every 5m — "Check the inbox" (running 2m)\n#2: goal — "all tests pass on main" (0 nudges of 20, running 2m)', "the registry keeps the goal (its task is live)");

  // /loop stop all stops schedules, not the goal.
  await loop.run("stop all", ctx);
  assert.equal(notices.at(-1), "Stopped 1 loop(s).");
  assert.equal(store.registry().loops["2"].stopped, undefined);

  // A new goal replaces the conversation's live one (and aborts its task); another conversation's stays.
  const other = commandContext(store, 7);
  await goal.run("write the docs", other.ctx);
  await goal.run("ship the release", ctx);
  assert.match(notices.at(-1), /^Goal #4 set: "ship the release".* It replaces goal #2\./);
  assert.equal(store.registry().loops["2"].stopped, true);
  assert.deepEqual(store.aborted, [1, 2], "the stopped loop's task, then the replaced goal's");
  assert.equal(store.registry().loops["3"].stopped, undefined, "another conversation's goal is untouched");

  await goal.run("done", ctx);
  assert.equal(notices.at(-1), 'Goal #4 marked done: "ship the release".');
  assert.deepEqual(store.registry().loops["4"].done, { summary: "marked done by the operator", by: "operator", at: clock });
  await goal.run("stop", ctx);
  assert.equal(notices.at(-1), "No goal to end.");
  await goal.run("stop", other.ctx);
  assert.equal(other.notices.at(-1), 'Goal #3 stopped: "write the docs".');
});

test("goal_done ends the conversation's goal; without one it is an error", async () => {
  const store = durable();
  const goalTask = createGoalTask();
  const { goal } = createGoalCommands({ task: goalTask, now: () => 5 });
  const [goalDone] = createGoalTools({ task: goalTask, now: () => 9 });
  const { ctx } = commandContext(store);
  const api = { conversationId: 1, commit: (change) => store.commit(change) };

  const none = await goalDone.execute({ summary: "done" }, api, {});
  assert.equal(none.isError, true);
  await goal.run("all tests pass", ctx);
  const result = await goalDone.execute({ summary: "CI green on main at abc123" }, api, {});
  assert.equal(result.output[0].text, "Goal #1 done. No more nudges.");
  assert.deepEqual(store.registry().loops["1"].done, { summary: "CI green on main at abc123", blocked: false, by: "agent", at: 9 });
  assert.equal(store.registry().loops["1"].stopped, true);
  assert.equal((await goalDone.execute({ summary: "" }, api, {})).isError, true);
});

/** The goal task's runtime: the session's registry, one conversation, commits and sleeps. */
function goalRuntime(store, { settle = () => ({ status: "done" }), conversation = true } = {}) {
  const submitted = [];
  const results = [];
  let idleWaits = 0;
  const runtime = {
    taskId: "t1",
    conversationId: 1,
    snapshot: async () => store.registry(),
    conversation: async () =>
      conversation
        ? {
            waitForIdle: async () => void idleWaits++,
            submit: async (draft) => {
              submitted.push(draft);
              return { wait: async () => settle(draft, submitted.length) };
            },
          }
        : undefined,
    commit: async (change) => {
      const result = await store.commit(change);
      results.push(result);
      return result;
    },
    sleepUntil: () => {},
  };
  return { runtime, submitted, results, idleWaits: () => idleWaits };
}

async function startGoal(store, text = "all tests pass", maxNudges = 50) {
  const task = createGoalTask({ now: () => Date.parse("2026-11-01T12:00:00Z"), timeZone: "UTC" });
  const ops = createGoalCommands({ task, now: () => 1 });
  await ops.goal.run(`--max ${maxNudges} ${text}`, commandContext(store).ctx);
  const record = store.tasks.at(-1).record;
  return { task, taskState: (checkpoint) => ({ input: record.input, state: { checkpoint: checkpoint ?? task.definition.initial(record.input) } }) };
}

test("the goal task nudges an idle conversation, counts nudges, and ends once goal_done marks it", async () => {
  const store = durable();
  const { task, taskState } = await startGoal(store);
  const run = goalRuntime(store);
  await task.definition.phases.watch(taskState(), run.runtime, {});
  assert.equal(run.idleWaits(), 1, "it waits for the conversation's own work first");
  assert.equal(run.submitted.length, 1);
  assert.equal(run.submitted[0].requestId, "goal:t1:1", "one request id per nudge, so a retried nudge is the same submission");
  assert.equal(run.submitted[0].whenBusy, "followUp");
  assert.equal(run.submitted[0].content, `[2026-11-01 12:00:00 UTC] ${goalNudge("all tests pass", 1)}`);
  assert.deepEqual(run.results.at(-1), { status: "running", checkpoint: { phase: "watch", nudges: 1, failures: 0 } });
  assert.equal(store.registry().loops["1"].nudges, 1);

  // The agent called goal_done during the next run: the task ends and forgets the goal.
  const done = goalRuntime(store, {
    settle: () => {
      store.registry().loops["1"].stopped = true;
      store.registry().loops["1"].done = { summary: "green", by: "agent" };
      return { status: "done" };
    },
  });
  await task.definition.phases.watch(taskState({ phase: "watch", nudges: 1, failures: 0 }), done.runtime, {});
  assert.equal(done.results.at(-1).status, "terminal");
  assert.deepEqual(done.results.at(-1).outcome.result.done, { summary: "green", by: "agent" });
  assert.equal(store.registry().loops["1"], undefined);
});

test("the goal task stops on an interruption, after repeated failures, at its limit, or when stopped", async () => {
  // The operator aborts a nudged run: the goal ends rather than restarting the agent.
  let store = durable();
  let started = await startGoal(store);
  let run = goalRuntime(store, { settle: () => ({ status: "unanswered", reason: "aborted" }) });
  await started.task.definition.phases.watch(started.taskState(), run.runtime, {});
  assert.deepEqual(run.results.at(-1).outcome.result, { nudges: 1, interrupted: true });
  assert.equal(store.registry().loops["1"], undefined);

  // A failed run waits before the next nudge; three in a row end the goal.
  store = durable();
  started = await startGoal(store);
  run = goalRuntime(store, { settle: () => ({ status: "unanswered", reason: "provider error" }) });
  await started.task.definition.phases.watch(started.taskState(), run.runtime, {});
  const sleeping = run.results.at(-1);
  assert.equal(sleeping.status, "sleeping");
  assert.equal(sleeping.until - Date.parse("2026-11-01T12:00:00Z"), GOAL_FAILURE_BACKOFF_MS);
  assert.deepEqual(sleeping.checkpoint, { phase: "watch", nudges: 1, failures: 1 });
  await started.task.definition.phases.watch(started.taskState({ phase: "watch", nudges: 2, failures: 2 }), run.runtime, {});
  assert.deepEqual(run.results.at(-1).outcome.result, { nudges: 3, failed: "provider error" });

  // The nudge limit.
  store = durable();
  started = await startGoal(store, "ship it", 2);
  run = goalRuntime(store);
  await started.task.definition.phases.watch(started.taskState({ phase: "watch", nudges: 2, failures: 0 }), run.runtime, {});
  assert.equal(run.submitted.length, 0);
  assert.deepEqual(run.results.at(-1).outcome.result, { nudges: 2, gaveUp: true });

  // Stopped while the conversation was busy: no nudge.
  store = durable();
  started = await startGoal(store);
  run = goalRuntime(store);
  run.runtime.conversation = async () => ({
    waitForIdle: async () => void (store.registry().loops["1"].stopped = true),
    submit: async () => assert.fail("a stopped goal sends nothing"),
  });
  await started.task.definition.phases.watch(started.taskState(), run.runtime, {});
  assert.deepEqual(run.results.at(-1).outcome.result, { nudges: 0, stopped: true });
});

test("the goal section names the conversation's live goal; the chips count it without a time", async () => {
  const store = durable();
  await startGoal(store, "all tests pass");
  const section = goalSection();
  const read = { snapshot: async () => store.registry() };
  assert.match(await section.render({ conversationId: 1, read }, {}), /^The operator set a goal for this conversation \(goal #1\): all tests pass\n.*goal_done/);
  assert.equal(await section.render({ conversationId: 2, read }, {}), undefined, "another conversation has no goal");

  const doc = { loops: { 1: { kind: "goal", prompt: "x", nudges: 3 }, 2: { intervalSecs: 300, startedAt: 0 } } };
  assert.deepEqual(liveLoopSchedules(doc), [{ goal: true }, { startedAt: 0, intervalSecs: 300 }]);
  assert.equal(nextLoopIn(liveLoopSchedules(doc), 60_000), 240_000, "the goal has no next time");
  assert.equal(nextLoopIn([{ goal: true }], 0), undefined);
  assert.match(loopStatus(doc, 60_000), /^⟳ 2 loops · #1 goal \(3 nudged\) · #2 every 5m/);
});
