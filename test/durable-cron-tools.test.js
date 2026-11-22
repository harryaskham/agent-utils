// The agent's own crons in pi-daemon sessions (extensions/durable/loop.mjs): create_cron,
// list_crons, update_cron and delete_cron share the session's registry and numbers with /cron,
// /loop and the loop tools. An update keeps the number: a new task takes it, and the replaced
// task ends without delivering and without touching the new one's entry.
import test from "node:test";
import assert from "node:assert/strict";

import { LOOPS_DOC, LOOP_TASK, MAX_LOOP_ENTRIES, createCronTools, createLoopCommands, createLoopTask, createLoopTools, formatWhen } from "../extensions/lib/durable-loop.js";
import { liveLoopSchedules } from "../extensions/lib/loop-indicator.js";
import { loopStatus } from "../extensions/durable/loop-client.js";

/** A Durable session as far as the schedules use it; drafts fail once their commit has settled, as Durable's do. */
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
      tasks.push({ record: { id, kind: task.definition.name, conversationId: options.conversationId, input, background: options.background, checkpoint: task.definition.initial(input) } });
      return id;
    },
  };
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

/** One phase's runtime for task `taskId` over `store`. */
function runtime(store, taskId, { busy = false, whileBusy } = {}) {
  const submitted = [];
  const commits = [];
  return {
    submitted,
    commits,
    value: {
      taskId,
      conversationId: 1,
      signal: new AbortController().signal,
      snapshot: async () => JSON.parse(JSON.stringify(store.registry() ?? null)),
      conversation: async () => ({
        async submit(submission) {
          if (busy && submission.whenBusy === "reject") throw Object.assign(new Error("busy"), { name: "ConversationBusy" });
          submitted.push(submission);
        },
        waitForIdle: async () => whileBusy?.(),
      }),
      sleepUntil: async () => {},
      commit: async (change) => commits.push(await store.commit(change)),
    },
  };
}

const NOW = Date.parse("2026-11-22T17:00:00Z"); // a Sunday
const texts = (result) => result.output.map((part) => part.text).join("\n");

function setup() {
  const store = durable();
  const task = createLoopTask({ now: () => NOW, timeZone: "UTC" });
  const options = { task, now: () => NOW, timeZone: "UTC" };
  const tools = Object.fromEntries([...createLoopTools(options), ...createCronTools(options)].map((tool) => [tool.name, tool]));
  const api = { conversationId: 1, commit: (change) => store.commit(change) };
  const notices = [];
  const ctx = {
    sessionId: "s",
    conversationId: 1,
    context: {},
    notify: (text) => notices.push(text),
    harness: {
      commit: (change) => store.commit(change),
      inspect: async () => ({ tasks: store.tasks.filter((entry) => !store.aborted.includes(entry.record.id)) }),
      snapshot: async () => JSON.parse(JSON.stringify(store.registry() ?? null)),
      abortTask: async (id) => store.aborted.push(id),
    },
  };
  return { store, task, tools, api, ctx, notices, commands: createLoopCommands(options) };
}

test("the agent creates, lists, updates and deletes its own crons, sharing numbers with /cron and the loops", async () => {
  const { store, tools, api, ctx, notices, commands } = setup();
  assert.deepEqual(Object.keys(tools), ["create_loop", "list_loops", "stop_loop", "create_cron", "list_crons", "update_cron", "delete_cron"]);
  assert.equal(texts(await tools.list_crons.execute({}, api, {})), "No crons.");

  // Create: the operator's /cron is #1, the agent's cron #2, a loop #3.
  await commands.cron.run("@daily tidy the notes", ctx);
  const created = await tools.create_cron.execute({ schedule: "0 9 * * 1-5", timeZone: "Europe/London", prompt: "Write the standup notes", steer: true }, api, {});
  assert.equal(created.isError, undefined);
  assert.equal(texts(created), 'Cron #2 created: 0 9 * * 1-5 (Europe/London), next Mon 23 Nov 2026 09:00 GMT, steers — "Write the standup notes". Change it with update_cron, delete it with delete_cron {"id": 2}.');
  const monday = Date.parse("2026-11-23T09:00:00Z");
  assert.deepEqual(created.details, { id: 2, schedule: "0 9 * * 1-5", timeZone: "Europe/London", prompt: "Write the standup notes", deliverAs: "steer", nextAt: monday });
  assert.deepEqual(created.content, created.output, "both names of the result's text, as the loop tools");
  await tools.create_loop.execute({ interval: "30m", prompt: "Watch the queue" }, api, {});
  // The task and the entry are those /cron makes.
  assert.deepEqual(store.tasks[1].record, {
    id: 2,
    kind: LOOP_TASK,
    conversationId: 1,
    input: { number: 2, prompt: "Write the standup notes", deliverAs: "steer", firstAt: monday, startedAt: NOW, kind: "cron", cron: { expression: "0 9 * * 1-5", timeZone: "Europe/London" } },
    background: true,
    checkpoint: { phase: "wait", nextAt: monday, fired: 0 },
  });
  assert.deepEqual(store.registry().loops["2"], { taskId: "2", kind: "cron", prompt: "Write the standup notes", deliverAs: "steer", startedAt: NOW, nextAt: monday, conversationId: 1, cron: { expression: "0 9 * * 1-5", timeZone: "Europe/London" } });

  // List: the crons only, each with its next time; list_loops and /cron list show them too.
  const listed = await tools.list_crons.execute({}, api, {});
  assert.equal(texts(listed), ['#1: @daily (UTC), next Mon 23 Nov 2026 00:00 UTC — "tidy the notes"', '#2: 0 9 * * 1-5 (Europe/London), next Mon 23 Nov 2026 09:00 GMT, steers — "Write the standup notes"'].join("\n"));
  assert.deepEqual(listed.details.crons.map((cron) => [cron.id, cron.schedule, cron.timeZone, cron.deliverAs]), [[1, "@daily", "UTC", "followUp"], [2, "0 9 * * 1-5", "Europe/London", "steer"]]);
  assert.match(texts(await tools.list_loops.execute({}, api, {})), /#2: cron 0 9 \* \* 1-5 \(Europe\/London\), next in 16h — "Write the standup notes"\n#3: every 30m/);

  // Update the schedule: the same number, a new task on the new schedule, the old one's entry stopped.
  const moved = await tools.update_cron.execute({ id: 2, schedule: "30 7 * * *" }, api, {});
  const tomorrow = Date.parse("2026-11-23T07:30:00Z");
  assert.equal(texts(moved), 'Cron #2 updated: 30 7 * * * (Europe/London), next Mon 23 Nov 2026 07:30 GMT, steers — "Write the standup notes".');
  assert.deepEqual(moved.details, { id: 2, schedule: "30 7 * * *", timeZone: "Europe/London", prompt: "Write the standup notes", deliverAs: "steer", nextAt: tomorrow });
  assert.deepEqual(store.tasks.at(-1).record.input, { number: 2, prompt: "Write the standup notes", deliverAs: "steer", firstAt: tomorrow, startedAt: NOW, kind: "cron", cron: { expression: "30 7 * * *", timeZone: "Europe/London" } });
  assert.deepEqual(store.registry().loops["2"], { taskId: "4", kind: "cron", prompt: "Write the standup notes", deliverAs: "steer", startedAt: NOW, nextAt: tomorrow, conversationId: 1, cron: { expression: "30 7 * * *", timeZone: "Europe/London" } });
  assert.deepEqual(store.registry().loops["2~2"], { taskId: "2", kind: "cron", stopped: true, replacedBy: "4" });

  // Update the prompt, the zone and the delivery: what is left out stays.
  const reworded = await tools.update_cron.execute({ id: 2, prompt: "Write the notes, then post them", timeZone: "Europe/Berlin", steer: false }, api, {});
  assert.equal(texts(reworded), 'Cron #2 updated: 30 7 * * * (Europe/Berlin), next Mon 23 Nov 2026 07:30 CET — "Write the notes, then post them".');
  assert.equal(store.registry().loops["2"].taskId, "5");
  assert.equal(store.registry().loops["2"].nextAt, Date.parse("2026-11-23T06:30:00Z"));
  // The same again changes nothing, and starts no task.
  const same = await tools.update_cron.execute({ id: 2, schedule: "30 7 * * *", steer: false }, api, {});
  assert.match(texts(same), /^Cron #2 already has that schedule, prompt and delivery: 30 7 \* \* \* \(Europe\/Berlin\)/);
  assert.equal(store.tasks.length, 5);

  // Every reader sees one #2: the tools, /cron list, the pi-client line and chips.
  assert.deepEqual((await tools.list_crons.execute({}, api, {})).details.crons.map((cron) => [cron.id, cron.schedule, cron.prompt]), [[1, "@daily", "tidy the notes"], [2, "30 7 * * *", "Write the notes, then post them"]]);
  assert.equal(loopStatus(store.registry(), NOW), "⟳ 3 loops · #1 cron (next 7h) · #2 cron (next 13h30m) · #3 every 30m (next 30m)");
  assert.equal(liveLoopSchedules(store.registry()).length, 3);
  // A command sees the tasks: it ends the two replaced ones at once and adopts neither.
  await commands.cron.run("list", ctx);
  assert.deepEqual(store.aborted, [2, 4]);
  assert.match(notices.at(-1), /^#1: cron @daily \(UTC\).*\n#2: cron 30 7 \* \* \* \(Europe\/Berlin\), next in 13h — "Write the notes, then post them"\n#3: every 30m/);

  // What cannot be done says why.
  for (const [args, problem] of [
    [{ id: 2 }, /^Nothing to change/],
    [{ id: 2, schedule: "61 * * * *" }, /^Invalid schedule: cron minute: 61 is outside 0-59\.$/],
    [{ id: 2, timeZone: "Mars/Olympus" }, /^Unknown time zone "Mars\/Olympus"/],
    [{ id: 2, prompt: "  " }, /^Cron prompt cannot be empty\.$/],
    [{ id: 2, schedule: "0 0 30 2 *" }, /never fires/],
    [{ id: 9, prompt: "x" }, /^No cron #9\. list_crons/],
    [{ id: 3, prompt: "x" }, /^#3 is a loop, not a cron: stop_loop \{"id": 3\} stops it\.$/],
    [{ id: "two", prompt: "x" }, /^Invalid cron id "two"\.$/],
  ]) {
    const refused = await tools.update_cron.execute(args, api, {});
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(texts(refused), problem);
  }
  for (const [args, problem] of [
    [{ schedule: "every day", prompt: "x" }, /^Invalid schedule: a cron schedule has five fields/],
    [{ schedule: "@daily", prompt: "" }, /^Cron prompt cannot be empty\.$/],
    [{ schedule: "@daily", prompt: "x", timeZone: "Nowhere" }, /^Unknown time zone "Nowhere"/],
    [{ schedule: "0 0 30 2 *", prompt: "x" }, /never fires/],
  ]) {
    const refused = await tools.create_cron.execute(args, api, {});
    assert.equal(refused.isError, true, JSON.stringify(args));
    assert.match(texts(refused), problem);
  }
  assert.equal(store.tasks.length, 5, "a refused call starts nothing");

  // Delete: a cron by id; never a loop; all is every cron and nothing else.
  assert.match(texts(await tools.delete_cron.execute({}, api, {})), /^Give the id of the cron to delete, or all: true\.$/);
  const notCron = await tools.delete_cron.execute({ id: 3 }, api, {});
  assert.deepEqual([notCron.isError, texts(notCron)], [true, '#3 is a loop, not a cron: stop_loop {"id": 3} stops it.']);
  assert.equal(store.registry().loops["3"].stopped, undefined);
  const deleted = await tools.delete_cron.execute({ id: 2 }, api, {});
  assert.deepEqual([texts(deleted), deleted.details], ["Cron #2 deleted.", { deleted: [2] }]);
  assert.equal((await tools.delete_cron.execute({ id: 2 }, api, {})).isError, true, "gone");
  assert.equal((await tools.update_cron.execute({ id: 2, prompt: "x" }, api, {})).isError, true, "a deleted cron is not updated");
  await tools.create_cron.execute({ schedule: "@hourly", prompt: "check the build" }, api, {});
  assert.deepEqual((await tools.list_crons.execute({}, api, {})).details.crons.map((cron) => [cron.id, cron.timeZone]), [[1, "UTC"], [4, "UTC"]], "numbers are not reused; the default zone");
  const all = await tools.delete_cron.execute({ all: true }, api, {});
  assert.deepEqual([texts(all), all.details], ["Deleted 2 cron(s): #1, #4.", { deleted: [1, 4] }]);
  assert.equal(texts(await tools.delete_cron.execute({ all: true }, api, {})), "No crons to delete.");
  assert.match(texts(await tools.list_loops.execute({}, api, {})), /^#3: every 30m — "Watch the queue"/, "the loop goes on");
});

test("a replaced cron's task ends without delivering and leaves its number to the new task", async () => {
  const { store, task, tools, api } = setup();
  await tools.create_cron.execute({ schedule: "0 9 * * *", prompt: "old words" }, api, {});
  await tools.update_cron.execute({ id: 1, schedule: "0 10 * * *", prompt: "new words" }, api, {});
  const [old, fresh] = store.tasks.map((entry) => entry.record);
  assert.deepEqual([old.id, fresh.id, store.registry().loops["1"].taskId], [1, 2, "2"]);

  // The replaced task wakes at its old time: nothing sent, its own entry gone, #1 still the new task's.
  const woken = runtime(store, old.id);
  await task.definition.phases.deliver({ input: old.input, state: { checkpoint: { phase: "deliver", nextAt: old.input.firstAt, fired: 0 } } }, woken.value, {});
  assert.deepEqual(woken.submitted, []);
  assert.deepEqual(woken.commits, [{ status: "terminal", outcome: { status: "completed", result: { stopped: true } } }]);
  assert.deepEqual(Object.keys(store.registry().loops), ["1"]);
  assert.equal(store.registry().loops["1"].taskId, "2");

  // The new task delivers the new words and keeps its next time in the entry.
  const due = runtime(store, fresh.id);
  await task.definition.phases.deliver({ input: fresh.input, state: { checkpoint: { phase: "deliver", nextAt: fresh.input.firstAt, fired: 0 } } }, due.value, {});
  assert.deepEqual(due.submitted.map((submission) => submission.content), ["[2026-11-22 17:00:00 UTC] new words"]);
  assert.equal(due.commits[0].status, "sleeping");
  assert.equal(store.registry().loops["1"].nextAt, due.commits[0].until);

  // Replaced again, and this time the old task is aborted (a command does that): the number stays the new task's.
  await tools.update_cron.execute({ id: 1, prompt: "newer words" }, api, {});
  const aborting = runtime(store, fresh.id);
  await task.definition.abort({ input: fresh.input }, aborting.value, {});
  assert.deepEqual(aborting.commits, [{ status: "terminal", outcome: { status: "aborted", reason: "loop stopped" } }]);
  assert.deepEqual([Object.keys(store.registry().loops), store.registry().loops["1"].taskId, store.registry().loops["1"].prompt], [["1"], "3", "newer words"]);
});

test("a tick that waited for the agent's turn to end delivers nothing once its cron was deleted or replaced meanwhile", async () => {
  for (const change of [(tools, api) => tools.delete_cron.execute({ id: 1 }, api, {}), (tools, api) => tools.update_cron.execute({ id: 1, prompt: "new words" }, api, {})]) {
    const { store, task, tools, api } = setup();
    await tools.create_cron.execute({ schedule: "0 9 * * *", prompt: "old words" }, api, {});
    const { id, input } = store.tasks[0].record;
    // The tick is due while the agent works; in that turn the agent deletes or changes the cron.
    const waiting = runtime(store, id, { busy: true, whileBusy: () => change(tools, api) });
    await task.definition.phases.deliver({ input, state: { checkpoint: { phase: "deliver", nextAt: input.firstAt, fired: 0 } } }, waiting.value, {});
    assert.deepEqual(waiting.submitted, []);
    assert.deepEqual(waiting.commits, [{ status: "terminal", outcome: { status: "completed", result: { stopped: true } } }]);
  }

  // Stopped between the tick's check and its commit: the command is not run and no next tick is set.
  const spec = Symbol.for("pi-daemon.commandTask");
  globalThis[spec] = { name: "pi-daemon.command", version: 1 };
  try {
    const { store, task, tools, api } = setup();
    await tools.create_cron.execute({ schedule: "0 9 * * *", prompt: "/compact" }, api, {});
    const { id, input } = store.tasks[0].record;
    const late = runtime(store, id);
    const snapshot = late.value.snapshot;
    late.value.snapshot = async () => {
      const before = await snapshot();
      await tools.delete_cron.execute({ id: 1 }, api, {});
      return before;
    };
    await task.definition.phases.deliver({ input, state: { checkpoint: { phase: "deliver", nextAt: input.firstAt, fired: 0 } } }, late.value, {});
    assert.deepEqual(late.commits, [{ status: "terminal", outcome: { status: "completed", result: { stopped: true } } }]);
    assert.equal(store.tasks.length, 1, "no command task");
    assert.deepEqual(store.registry().loops, {});
  } finally {
    delete globalThis[spec];
  }
});

test("entries a tool stopped or replaced are bounded until their tasks end", async () => {
  const { store, tools, api, ctx, commands } = setup();
  await tools.create_cron.execute({ schedule: "@yearly", prompt: "v0" }, api, {});
  // Each update leaves a replaced task asleep until its next time.
  let version = 0;
  while (Object.keys(store.registry().loops).length < MAX_LOOP_ENTRIES) assert.equal((await tools.update_cron.execute({ id: 1, prompt: `v${++version}` }, api, {})).isError, undefined);
  const full = await tools.update_cron.execute({ id: 1, prompt: "one more" }, api, {});
  assert.deepEqual([full.isError, /^128 stopped or replaced schedules have not ended yet/.test(texts(full))], [true, true]);
  assert.equal((await tools.create_cron.execute({ schedule: "@daily", prompt: "another" }, api, {})).isError, true);
  assert.equal(store.registry().loops["1"].prompt, `v${version}`, "the refused update changed nothing");
  // A command ends them, and the tools work again.
  await commands.loops.run("", ctx);
  assert.equal(store.aborted.length, MAX_LOOP_ENTRIES - 1);
  // (The fake's abort only records; Durable's runs the task's abort, which removes its entry.)
  for (const key of Object.keys(store.registry().loops)) if (store.registry().loops[key].stopped) delete store.registry().loops[key];
  assert.equal((await tools.update_cron.execute({ id: 1, prompt: "one more" }, api, {})).isError, undefined);
});

test("a time is told as a clock in the cron's zone shows it", () => {
  assert.equal(formatWhen(Date.parse("2026-07-01T08:00:00Z"), "Europe/London"), "Wed 1 Jul 2026 09:00 BST");
  assert.equal(formatWhen(Date.parse("2026-11-23T09:00:00Z"), "UTC"), "Mon 23 Nov 2026 09:00 UTC");
  assert.equal(formatWhen(0, "Not/AZone"), "1970-01-01T00:00:00.000Z");
});
