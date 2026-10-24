// Choices for pi-daemon sessions (extensions/durable/choice.mjs, bd-ac1906): the questions are
// pi-daemon's question documents; async ones sit on background tasks marked blocking: false.
import test from "node:test";
import assert from "node:assert/strict";

import { ASYNC_DOC, ASYNC_TASK, INPUT_DOC, choiceResult, createAsyncChoiceTask, createChoiceTools, normalizeChoices, questionContext, resultText } from "../extensions/lib/durable-choice.js";

test("choices get ids and distinct shown labels; a settled question maps back to the choice", () => {
  const choices = normalizeChoices([{ label: "yes", headline: "Ship", summary: "go now", value: 1 }, { label: "no" }, { label: "maybe", headline: "Ship" }]);
  assert.deepEqual(choices.map((choice) => [choice.id, choice.shown]), [["1", "Ship"], ["2", "no"], ["3", "Ship (3)"]]);
  assert.equal(questionContext("Background.", choices), "Background.\nShip: go now");
  assert.deepEqual(choiceResult(choices, { status: "answered", answer: "Ship" }), { status: "selected", index: 0, id: "1", label: "yes", value: 1 });
  assert.deepEqual(choiceResult(choices, { status: "answered", answer: "free" }), { status: "freeform", text: "free" });
  assert.deepEqual(choiceResult(choices, { status: "cancelled" }), { status: "cancelled" });
  assert.equal(resultText({ status: "selected", index: 1, label: "no" }), "selected 2: no");
  assert.throws(() => normalizeChoices([{ label: "only" }]), /at least two/);
});

/** A Durable session as far as the tools use it: documents by kind and owner, and tasks. */
function durable() {
  const docs = new Map();
  const tasks = [];
  let next = 10;
  const key = (token, owner) => `${token.definition.kind}:${owner ?? "session"}`;
  const tx = {
    async doc(token, owner) {
      if (token.definition.scope === "task" && typeof owner !== "number") throw new TypeError("task id must be a number");
      const at = key(token, owner);
      if (!docs.has(at)) docs.set(at, token.definition.initial());
      return docs.get(at);
    },
    async createTask(task, input, options) {
      const id = ++next;
      tasks.push({ id, name: task.definition.name, input, options });
      return id;
    },
  };
  return { docs, tasks, tx, commit: async (change) => JSON.parse(JSON.stringify((await change(tx)) ?? null)), question: (id) => docs.get(`${INPUT_DOC.definition.kind}:${id}`) };
}

test("async_choice posts non-blocking questions on background tasks; status and cancel read and settle them", async () => {
  const store = durable();
  const tools = Object.fromEntries(createChoiceTools({ now: () => 5 }).map((tool) => [tool.name, tool]));
  const api = { conversationId: 1, commit: (change) => store.commit(change) };
  const posted = await tools.async_choice.execute({ questions: [{ question: "Ship it?", key: "ship", choices: [{ label: "yes" }, { label: "no" }] }, { question: "Rename?", choices: [{ label: "a" }, { label: "b" }] }] }, api, {});
  assert.match(posted.content[0].text, /^Posted 2 async questions \(2 pending\)/);
  // pi-durable 1.2 renamed a tool result's `content` to `output`: both, for either host.
  assert.deepEqual(posted.output, posted.content);
  assert.deepEqual(store.tasks.map((task) => [task.name, task.options.background, task.input.key]), [
    [ASYNC_TASK, true, "ship"],
    [ASYNC_TASK, true, undefined],
  ]);
  const [first, second] = posted.details.ids;
  assert.deepEqual(store.question(Number(first)), { status: "pending", question: "Ship it?", choices: ["yes", "no"], blocking: false });

  const status = await tools.async_choice_status.execute({ ids: ["ship"] }, api, {});
  assert.match(status.content[0].text, new RegExp(`^- ${first} \\[key=ship\\]: pending`));
  const withdrawn = await tools.async_choice_cancel.execute({ ids: [second] }, api, {});
  assert.equal(withdrawn.content[0].text, `Withdrew 1: ${second}`);
  assert.equal(store.question(Number(second)).status, "cancelled", "the question leaves the clients");
  assert.equal((await tools.async_choice_cancel.execute({}, api, {})).isError, true);
  assert.equal((await tools.async_choice.execute({ question: "x", choices: [{ label: "one" }] }, api, {})).isError, true);
});

test("the async task steers the conversation with the answer and records it", async () => {
  const store = durable();
  const task = createAsyncChoiceTask();
  (await store.tx.doc(ASYNC_DOC)).records["12"] = { id: "12", status: "pending", question: "Ship it?" };
  const question = await store.tx.doc(INPUT_DOC, 12);
  Object.assign(question, { question: "Ship it?", choices: ["yes", "no"], blocking: false, status: "answered", answer: "yes" });
  const submitted = [];
  const commits = [];
  const runtime = {
    taskId: 12,
    conversationId: 1,
    signal: new AbortController().signal,
    watchDoc: async () => ({ value: { ...question }, start() {}, stop: async () => undefined }),
    conversation: async () => ({ submit: async (submission) => submitted.push(submission) }),
    commit: async (change) => commits.push(await change(store.tx)),
  };
  await task.definition.phases.wait({ input: { question: "Ship it?", key: "ship", choices: normalizeChoices([{ label: "yes" }, { label: "no" }]) } }, runtime, {});
  assert.deepEqual(submitted.map((submission) => [submission.content, submission.whenBusy, submission.requestId]), [['[async_choice answer] ship: "Ship it?" → yes (id 12)', "steer", "async-choice:12"]]);
  assert.equal((await store.tx.doc(ASYNC_DOC)).records["12"].status, "answered");
  assert.equal(commits.at(-1).status, "terminal");
});

/** A Durable execution environment running commands with `vars` as its environment. */
function execEnvWith(vars) {
  return {
    async exec(command, options, context) {
      const { execFile } = await import("node:child_process");
      return new Promise((resolve) =>
        execFile(command[0], command.slice(1), { env: { PATH: process.env.PATH, ...vars }, timeout: options?.timeout }, (error, stdout, stderr) => {
          if (stdout) options?.onOutput?.(stdout, context, { stream: "stdout" });
          if (stderr) options?.onOutput?.(stderr, context, { stream: "stderr" });
          resolve({ ok: true, value: { exitCode: error ? (typeof error.code === "number" ? error.code : 1) : 0 } });
        }),
      );
    },
  };
}

test("the Cacophony mirror takes the session's identity and caco, never the worker's", async () => {
  const { sessionIdentity, execFileVia } = await import("../extensions/lib/durable-choice.js");
  assert.deepEqual(await sessionIdentity(execEnvWith({ CACO_AGENT_ID: "a1", CACO_PROJECT: "p" }), {}), { agentId: "a1", project: "p" });
  assert.deepEqual(await sessionIdentity(execEnvWith({ CACO_AGENT_ID: "a1", CACO_PROJECT: "p", CACO_BIN: "/x/caco" }), {}), { agentId: "a1", project: "p", bin: "/x/caco" });
  assert.equal(await sessionIdentity(execEnvWith({ CACO_AGENT_ID: "a1" }), {}), undefined, "no project: no mirror");
  assert.equal(await sessionIdentity(execEnvWith({ CACO_AGENT_ID: "a1", CACO_PROJECT: "p", DISABLE_PI_CACO: "1" }), {}), undefined);
  assert.equal(await sessionIdentity(execEnvWith({ CACO_AGENT_ID: "a1", CACO_PROJECT: "p", PI_INCOGNITO: "true" }), {}), undefined);
  // execFile through the environment: stdout, and a failing command's error.
  const run = (command, args) => new Promise((resolve) => execFileVia(execEnvWith({ GREETING: "hi" }), {})(command, args, {}, (error, stdout) => resolve({ error: error?.message, stdout })));
  assert.deepEqual(await run("sh", ["-c", "printf %s \"$GREETING\""]), { error: undefined, stdout: "hi" });
  assert.match((await run("sh", ["-c", "echo nope >&2; exit 3"])).error, /nope/);
});
