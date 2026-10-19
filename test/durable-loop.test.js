// /loop for pi-daemon sessions as a Durable background task (extensions/durable/loop.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import {
  LOOP_TASK,
  createLoopCommands,
  createLoopTask,
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
  assert.equal(formatInterval(5400), "90m");
  assert.equal(formatInterval(7200), "2h");
  assert.equal(nextFireAt(1000, 100, 1050), 1100);
  assert.equal(nextFireAt(1000, 100, 1350), 1400, "three missed ticks are skipped, not replayed");
  assert.match(timestampPrefix(new Date("2026-10-19T15:04:05Z"), "UTC"), /^\[2026-10-19 15:04:05 UTC\]$/);
});

/** A module command context over a fake Durable harness. */
function harness(conversationId = "c1") {
  const tasks = [];
  const aborted = [];
  const notices = [];
  let next = 0;
  const ctx = {
    sessionId: "s",
    conversationId,
    context: {},
    notify: (text) => notices.push(text),
    harness: {
      async inspect() {
        return { tasks: tasks.filter((task) => !aborted.includes(task.record.id)) };
      },
      async abortTask(id) {
        aborted.push(id);
        return "marked";
      },
      async commit(change) {
        return change({
          createTask(task, input, options) {
            const id = `t${++next}`;
            tasks.push({ record: { id, kind: task.definition.name, conversationId: options.conversationId, input, state: { status: "pending", checkpoint: task.definition.initial(input) }, background: options.background } });
            return id;
          },
        });
      },
    },
  };
  return { ctx, tasks, aborted, notices };
}

test("/loop starts one background loop per conversation; status, interval and off manage it", async () => {
  const task = createLoopTask();
  const { loop } = createLoopCommands({ task, now: () => 1_000_000 });
  const h = harness();
  await loop.run("5m Check the inbox", h.ctx);
  assert.equal(h.tasks.length, 1);
  assert.equal(h.tasks[0].record.kind, LOOP_TASK);
  assert.equal(h.tasks[0].record.background, true);
  assert.deepEqual(h.tasks[0].record.input, { prompt: "Check the inbox", intervalSecs: 300, deliverAs: "followUp", firstAt: 1_300_000 });
  assert.match(h.notices.at(-1), /^Loop every 5m: Check the inbox/);

  await loop.run("status", h.ctx);
  assert.match(h.notices.at(-1), /every 5m · next in 5m · sent 0× · Check the inbox/);

  // A new loop replaces the old one; /loop interval keeps the prompt and delivery.
  await loop.run("10m --steer Run the tests", h.ctx);
  assert.deepEqual(h.aborted, ["t1"]);
  assert.equal(h.tasks[1].record.input.deliverAs, "steer");
  await loop.run("interval 1h", h.ctx);
  assert.deepEqual(h.aborted, ["t1", "t2"]);
  assert.deepEqual([h.tasks[2].record.input.prompt, h.tasks[2].record.input.intervalSecs, h.tasks[2].record.input.deliverAs], ["Run the tests", 3600, "steer"]);

  await loop.run("off", h.ctx);
  assert.deepEqual(h.aborted, ["t1", "t2", "t3"]);
  await loop.run("off", h.ctx);
  assert.equal(h.notices.at(-1), "No loop to stop.");
  await loop.run("whenever do things", h.ctx);
  assert.match(h.notices.at(-1), /^Usage: \/loop/);
  // Without pi-daemon's harness (older hosts), it says so.
  await loop.run("5m x", { notify: (text) => h.notices.push(text) });
  assert.match(h.notices.at(-1), /pi-daemon 1\.10/);
});

/** Run the loop task's phase once over a fake runtime and conversation. */
async function tick(input, checkpoint, { busy = false, now = 2_000 } = {}) {
  const submitted = [];
  const commits = [];
  const waits = [];
  let idleWaits = 0;
  const task = createLoopTask({ now: () => now, wait: async (ms) => waits.push(ms), timeZone: "UTC" });
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
    conversation: async () => conversation,
    commit: async (change) => commits.push(change()),
  };
  await task.definition.phases.wait({ input, state: { status: "running", checkpoint } }, runtime, {});
  return { submitted, commits, waits, idleWaits };
}

test("a tick waits until nextAt, delivers once, and commits the next tick", async () => {
  const input = { prompt: "Check the inbox", intervalSecs: 1, deliverAs: "followUp", firstAt: 1_500 };
  // Idle: one submission that starts a turn (rejected only if busy), stamped with the time.
  const idle = await tick(input, { phase: "wait", nextAt: 1_500, fired: 0 }, { now: 2_000 });
  assert.deepEqual(idle.waits, [-500]);
  assert.equal(idle.submitted.length, 1);
  assert.equal(idle.submitted[0].whenBusy, "reject");
  assert.equal(idle.submitted[0].requestId, "loop:t9:1");
  assert.match(idle.submitted[0].content, /^\[1970-01-01 00:00:02 UTC\] Check the inbox$/);
  assert.deepEqual(idle.commits, [{ status: "running", checkpoint: { phase: "wait", nextAt: 2_500, fired: 1, lastAt: 2_000 } }]);

  // Busy: wait for the work to end, then one follow-up with the same request id.
  const busy = await tick(input, { phase: "wait", nextAt: 1_500, fired: 4 }, { busy: true });
  assert.equal(busy.idleWaits, 1);
  assert.deepEqual(busy.submitted.map((submission) => [submission.whenBusy, submission.requestId]), [["followUp", "loop:t9:5"]]);

  // Steer delivery: at once.
  const steer = await tick({ ...input, deliverAs: "steer" }, { phase: "wait", nextAt: 1_500, fired: 0 }, { busy: true });
  assert.deepEqual(steer.submitted.map((submission) => submission.whenBusy), ["steer"]);
  assert.equal(steer.idleWaits, 0);
});

test("aborting the loop task commits an aborted outcome", async () => {
  const commits = [];
  await createLoopTask().definition.abort({}, { commit: async (change) => commits.push(change()) }, {});
  assert.deepEqual(commits, [{ status: "terminal", outcome: { status: "aborted", reason: "loop stopped" } }]);
});
