// /goal for pi-daemon sessions (extensions/lib/durable-goal.js through loop.mjs): goals share the
// loops document and numbers; /goal adds one (a conversation may have several); one task per
// conversation nudges for all its open goals in one message until goal_done ends each, and stops
// on an interruption, repeated failures or each goal's nudge limit.
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
        inspect: async () => ({ tasks: store.tasks.filter((entry) => !store.aborted.includes(entry.record.id)) }),
        snapshot: async () => store.registry(),
        abortTask: async (id) => void store.aborted.push(id),
      },
    },
  };
}

test("/goal arguments: add one (with --max), list, and done or stop one, all, or the only one", () => {
  assert.deepEqual(parseGoalArgs(""), { verb: "list" });
  assert.deepEqual(parseGoalArgs("list"), { verb: "list" });
  assert.deepEqual(parseGoalArgs("stop"), { verb: "stop", which: undefined });
  assert.deepEqual(parseGoalArgs("clear all"), { verb: "stop", which: "all" });
  assert.deepEqual(parseGoalArgs("done 3"), { verb: "done", which: 3 });
  assert.deepEqual(parseGoalArgs("stop #12"), { verb: "stop", which: 12 });
  assert.match(parseGoalArgs("done three").error, /Not a goal number/);
  assert.deepEqual(parseGoalArgs("all tests pass on main"), { goal: "all tests pass on main", maxNudges: 50 });
  assert.deepEqual(parseGoalArgs("--max 5 ship the release"), { goal: "ship the release", maxNudges: 5 });
  assert.deepEqual(parseGoalArgs("ship it --max=7"), { goal: "ship it", maxNudges: 7 });
  assert.match(parseGoalArgs("ship --max 0").error, /--max/);
  assert.match(parseGoalArgs("--max 3").error, /^Usage/);
});

test("/goal adds goals as /loop adds loops: one task per conversation, listed, ended one at a time or all", async () => {
  let clock = 1_000_000;
  const store = durable();
  const goalTask = createGoalTask();
  const { goal } = createGoalCommands({ task: goalTask, now: () => clock });
  const { loop, loops } = createLoopCommands({ task: createLoopTask(), now: () => clock });
  const { ctx, notices } = commandContext(store);

  await loop.run("5m Check the inbox", ctx);
  await goal.run("--max 20 all tests pass on main", ctx);
  assert.match(notices.at(-1), /^Goal #2 added: "all tests pass on main"\. .*at most 20 times.*\/goal done 2 or \/goal stop 2/);
  await goal.run("docs updated", ctx);
  assert.match(notices.at(-1), /^Goal #3 added: "docs updated"\..* 2 goals are open; each nudge lists them all\./);
  const goalTasks = store.tasks.filter((entry) => entry.record.kind === GOAL_TASK);
  assert.equal(goalTasks.length, 1, "the conversation's goals share one task");
  assert.equal(goalTasks[0].record.background, true);
  assert.deepEqual(store.registry().loops["2"], { taskId: "2", kind: "goal", prompt: "all tests pass on main", maxNudges: 20, nudges: 0, startedAt: clock, conversationId: 1 });
  assert.equal(store.registry().loops["3"].taskId, "2");

  clock += 120_000;
  await goal.run("", ctx);
  assert.equal(notices.at(-1), '#2: goal — "all tests pass on main" (0 nudges of 20, running 2m)\n#3: goal — "docs updated" (0 nudges of 50, running 2m)');
  await loops.run("", ctx);
  assert.match(notices.at(-1), /^#1: every 5m .*\n#2: goal .*\n#3: goal /);

  // /loop stop all stops schedules, not goals.
  await loop.run("stop all", ctx);
  assert.equal(notices.at(-1), "Stopped 1 loop(s).");
  assert.equal(store.registry().loops["2"].stopped, undefined);

  // With several open, /goal stop asks which; /goal done N ends one, and their task goes on.
  await goal.run("stop", ctx);
  assert.match(notices.at(-1), /^2 goals are open: \/goal stop N, or \/goal stop all\.\n#2: .*\n#3: /);
  await goal.run("done 2", ctx);
  assert.equal(notices.at(-1), 'Goal #2 marked done: "all tests pass on main".');
  assert.deepEqual(store.registry().loops["2"].done, { summary: "marked done by the operator", by: "operator", at: clock });
  assert.deepEqual(store.aborted, [1], "only the stopped loop's task: the goals' task still has #3");
  // /loop stop N on a goal with siblings leaves their task too.
  await goal.run("third thing", ctx);
  await loop.run("stop 4", ctx);
  assert.equal(store.registry().loops["4"].stopped, true);
  assert.deepEqual(store.aborted, [1]);

  // Another conversation's goals have their own task; the only open goal needs no number.
  const other = commandContext(store, 7);
  await goal.run("write the docs", other.ctx);
  assert.equal(store.tasks.filter((entry) => entry.record.kind === GOAL_TASK).length, 2);
  await goal.run("stop", other.ctx);
  assert.match(other.notices.at(-1), /^Goal #5 stopped: "write the docs"\./);
  assert.deepEqual(store.aborted, [1, 3], "its task had no goal left");

  await goal.run("stop all", ctx);
  assert.equal(notices.at(-1), 'Goal #3 stopped: "docs updated".');
  assert.deepEqual(store.aborted, [1, 3, 2]);
  await goal.run("stop 9", ctx);
  assert.equal(notices.at(-1), "No open goal #9.");
  await goal.run("", ctx);
  assert.match(notices.at(-1), /^No goals\./);
});

test("goal_done ends the goal named by id; the only open goal needs none; several need one", async () => {
  const store = durable();
  const goalTask = createGoalTask();
  const { goal } = createGoalCommands({ task: goalTask, now: () => 5 });
  const [goalDone] = createGoalTools({ task: goalTask, now: () => 9 });
  const { ctx } = commandContext(store);
  const api = { conversationId: 1, commit: (change) => store.commit(change) };

  assert.equal((await goalDone.execute({ summary: "done" }, api, {})).isError, true);
  await goal.run("all tests pass", ctx);
  await goal.run("docs updated", ctx);
  const several = await goalDone.execute({ summary: "green" }, api, {});
  assert.equal(several.isError, true);
  assert.match(several.output[0].text, /pass the id[\s\S]*#1: all tests pass\n#2: docs updated/);
  const one = await goalDone.execute({ id: 1, summary: "CI green on main at abc123" }, api, {});
  assert.equal(one.output[0].text, "Goal #1 done. 1 goal still open.");
  assert.deepEqual(store.registry().loops["1"].done, { summary: "CI green on main at abc123", blocked: false, by: "agent", at: 9 });
  assert.equal((await goalDone.execute({ id: 7, summary: "x" }, api, {})).isError, true);
  const elsewhere = await goalDone.execute({ id: 2, summary: "x" }, { ...api, conversationId: 3 }, {});
  assert.equal(elsewhere.isError, true, "another conversation's goal is not this agent's to end");
  const last = await goalDone.execute({ summary: "README and docs/goal.md", blocked: false }, api, {});
  assert.equal(last.output[0].text, "Goal #2 done. No more nudges.");
  assert.equal((await goalDone.execute({ summary: "" }, api, {})).isError, true);
});

/** The goal task's runtime: the session's registry, one conversation, commits and sleeps. */
function goalRuntime(store, { taskId = 1, settle = () => ({ status: "done" }) } = {}) {
  const submitted = [];
  const results = [];
  let idleWaits = 0;
  const runtime = {
    taskId,
    conversationId: 1,
    snapshot: async () => store.registry(),
    conversation: async () => ({
      waitForIdle: async () => void idleWaits++,
      submit: async (draft) => {
        submitted.push(draft);
        return { wait: async () => settle(draft, submitted.length) };
      },
    }),
    commit: async (change) => {
      const result = await store.commit(change);
      results.push(result);
      return result;
    },
    sleepUntil: () => {},
  };
  return { runtime, submitted, results, idleWaits: () => idleWaits };
}

const at = Date.parse("2026-11-08T12:00:00Z");
const watch = (task, checkpoint = { phase: "watch", nudges: 0, failures: 0 }) => ({ input: { conversationId: 1, startedAt: 0 }, state: { checkpoint } });

async function goals(texts) {
  const store = durable();
  const task = createGoalTask({ now: () => at, timeZone: "UTC" });
  const { goal } = createGoalCommands({ task, now: () => 1 });
  for (const text of texts) await goal.run(text, commandContext(store).ctx);
  return { store, task };
}

test("one nudge lists every open goal, counts a nudge for each, and the task ends when none is left", async () => {
  const { store, task } = await goals(["all tests pass", "--max 2 docs updated"]);
  const run = goalRuntime(store);
  await task.definition.phases.watch(watch(task), run.runtime, {});
  assert.equal(run.idleWaits(), 1, "it waits for the conversation's own work first");
  assert.equal(run.submitted.length, 1, "one nudge for both goals");
  assert.equal(run.submitted[0].requestId, "goal:1:1", "one request id per nudge, so a retried nudge is the same submission");
  assert.equal(run.submitted[0].whenBusy, "followUp");
  assert.equal(run.submitted[0].content, `[2026-11-08 12:00:00 UTC] ${goalNudge([{ number: 1, prompt: "all tests pass" }, { number: 2, prompt: "docs updated" }])}`);
  assert.match(run.submitted[0].content, /\[goals\] Keep working toward these 2 goals:\n- #1: all tests pass\n- #2: docs updated\n/);
  assert.deepEqual(run.results.at(-1), { status: "running", checkpoint: { phase: "watch", nudges: 1, failures: 0 } });
  assert.equal(store.registry().loops["1"].nudges, 1);
  assert.equal(store.registry().loops["2"].nudges, 1);

  // #2 reaches its limit of 2 and ends; #1 goes on, alone.
  await task.definition.phases.watch(watch(task, { phase: "watch", nudges: 1, failures: 0 }), run.runtime, {});
  assert.equal(store.registry().loops["2"], undefined);
  assert.equal(store.registry().loops["1"].nudges, 2);
  await task.definition.phases.watch(watch(task, { phase: "watch", nudges: 2, failures: 0 }), run.runtime, {});
  assert.equal(run.submitted.at(-1).content, `[2026-11-08 12:00:00 UTC] ${goalNudge([{ number: 1, prompt: "all tests pass" }])}`);
  assert.match(run.submitted.at(-1).content, /^\[[^\]]+\] \[goal #1\] Keep working toward this goal: all tests pass\nWhen it is fully done and checked, call goal_done with id 1/);

  // The agent called goal_done for #1 during the next run: the task ends and forgets it.
  const done = goalRuntime(store, {
    settle: () => {
      store.registry().loops["1"].stopped = true;
      store.registry().loops["1"].done = { summary: "green", by: "agent" };
      return { status: "done" };
    },
  });
  await task.definition.phases.watch(watch(task, { phase: "watch", nudges: 3, failures: 0 }), done.runtime, {});
  assert.equal(done.results.at(-1).status, "terminal");
  assert.deepEqual(store.registry().loops, {});
});

test("a goal added after the others ended gets a task of its own; a task with nothing open ends", async () => {
  const { store, task } = await goals(["first"]);
  store.registry().loops["1"].stopped = true;
  // No open goal shares task 1 (it is about to end), so the new goal starts task 2.
  const { goal } = createGoalCommands({ task, now: () => 2 });
  await goal.run("second", commandContext(store).ctx);
  assert.equal(store.registry().loops["2"].taskId, "2");

  // Task 1 has nothing open: it ends without nudging and drops its ended goal.
  const one = goalRuntime(store, { taskId: 1 });
  await task.definition.phases.watch(watch(task), one.runtime, {});
  assert.equal(one.submitted.length, 0);
  assert.equal(one.results.at(-1).status, "terminal");
  assert.equal(store.registry().loops["1"], undefined);

  // Task 2 nudges for the new goal.
  const two = goalRuntime(store, { taskId: 2 });
  await task.definition.phases.watch(watch(task), two.runtime, {});
  assert.equal(two.submitted.length, 1);
  assert.match(two.submitted[0].content, /\[goal #2\]/);
});

test("the goal task stops on an interruption or repeated failures, and waits after a failure", async () => {
  // The operator aborts a nudged run: every goal of the task ends rather than restarting the agent.
  let { store, task } = await goals(["one", "two"]);
  let run = goalRuntime(store, { settle: () => ({ status: "unanswered", reason: "aborted" }) });
  await task.definition.phases.watch(watch(task), run.runtime, {});
  assert.deepEqual(run.results.at(-1).outcome.result, { nudges: 1, interrupted: true });
  assert.deepEqual(store.registry().loops, {});

  // A failed run waits before the next nudge; three in a row end the goals.
  ({ store, task } = await goals(["one"]));
  run = goalRuntime(store, { settle: () => ({ status: "unanswered", reason: "provider error" }) });
  await task.definition.phases.watch(watch(task), run.runtime, {});
  const sleeping = run.results.at(-1);
  assert.equal(sleeping.status, "sleeping");
  assert.equal(sleeping.until - at, GOAL_FAILURE_BACKOFF_MS);
  assert.deepEqual(sleeping.checkpoint, { phase: "watch", nudges: 1, failures: 1 });
  await task.definition.phases.watch(watch(task, { phase: "watch", nudges: 2, failures: 2 }), run.runtime, {});
  assert.deepEqual(run.results.at(-1).outcome.result, { nudges: 3, failed: "provider error" });
  assert.deepEqual(store.registry().loops, {});

  // Aborted (the last goal stopped): its goals are forgotten.
  ({ store, task } = await goals(["one"]));
  run = goalRuntime(store);
  await task.definition.abort(watch(task), run.runtime, {});
  assert.equal(run.results.at(-1).status, "terminal");
  assert.deepEqual(store.registry().loops, {});
});

test("the goal section lists the conversation's open goals; the chips count them without a time", async () => {
  const { store } = await goals(["all tests pass", "docs updated"]);
  const section = goalSection();
  const read = { snapshot: async () => store.registry() };
  assert.equal(
    await section.render({ conversationId: 1, read }, {}),
    "The operator set 2 goals for this conversation:\n- #1: all tests pass\n- #2: docs updated\nKeep working toward them. Call goal_done with a goal's id and a summary only once it is fully done and checked (or with blocked: true if it cannot be done). Until then you are nudged to continue whenever you stop.",
  );
  assert.equal(await section.render({ conversationId: 2, read }, {}), undefined, "another conversation has no goal");

  const doc = { loops: { 1: { kind: "goal", prompt: "x", nudges: 3 }, 2: { intervalSecs: 300, startedAt: 0 } } };
  assert.deepEqual(liveLoopSchedules(doc), [{ goal: true }, { startedAt: 0, intervalSecs: 300 }]);
  assert.equal(nextLoopIn(liveLoopSchedules(doc), 60_000), 240_000, "a goal has no next time");
  assert.equal(nextLoopIn([{ goal: true }], 0), undefined);
  assert.match(loopStatus(doc, 60_000), /^⟳ 2 loops · #1 goal \(3 nudged\) · #2 every 5m/);
});
