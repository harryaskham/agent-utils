// choice.mjs's client part for pi-client (extensions/durable/choice-client.js, bd-27804c).
import test from "node:test";
import assert from "node:assert/strict";

import choiceClient, { OWN_ANSWER, choicesLine, orderQuestions, sendLabel } from "../extensions/durable/choice-client.js";

function harness({ questions, selects = [], inputs = [] } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const timers = [];
  const calls = [];
  const widgets = [];
  const notices = [];
  let pending = [...questions];
  const ctx = {
    chord: {
      async call(method, params) {
        calls.push([method, params]);
        if (method === "session.questions") return pending;
        if (method === "session.answerQuestion") {
          pending = pending.filter((question) => question.id !== params.questionId);
          return null;
        }
        throw new Error(`unexpected ${method}`);
      },
    },
    ui: {
      setWidget: (key, lines) => widgets.push([key, lines]),
      notify: (text, level) => notices.push([text, level]),
      select: async (title, options) => {
        const pick = selects.shift();
        return typeof pick === "function" ? pick(title, options) : pick;
      },
      input: async () => inputs.shift(),
    },
  };
  const pi = {
    on: (type, handler) => handlers.set(type, handler),
    registerCommand: (name, options) => commands.set(name, options),
  };
  choiceClient(pi, { pollMs: 10, setTimer: (fn) => (timers.push(fn), timers.length), clearTimer: () => {} });
  return {
    ctx,
    calls,
    widgets,
    notices,
    timers,
    emit: (type) => handlers.get(type)?.({ type }, ctx),
    run: (name) => commands.get(name).handler("", ctx),
    get pending() {
      return pending;
    },
  };
}

const later = { id: 7, question: "Favourite colour?", choices: ["red", "green"], blocking: false, context: "No hurry." };
const now = { id: 3, question: "Proceed?", choices: ["yes", "no"] };

test("the line counts the questions that wait without blocking", async () => {
  const h = harness({ questions: [later, now] });
  await h.emit("session_start");
  assert.deepEqual(h.widgets.at(-1), ["agent-utils-choices", ["◇ 1 question for you · /choices"]]);
  assert.equal(h.timers.length, 1, "it looks again while questions wait");
  assert.equal(choicesLine(0), undefined);
  assert.deepEqual(orderQuestions([later, now]).map((question) => question.id), [3, 7]);
});

test("/choices stays open: a blocking answer goes at once, others are drafts sent together", async () => {
  const other = { id: 8, question: "Pet's name?", choices: ["Rex", "Tom"], blocking: false };
  const lists = [];
  const asked = [];
  const list = (pick) => (title, options) => (lists.push([title, options]), pick(options));
  const answer = (choice) => (title, options) => (asked.push([title, options]), choice);
  const h = harness({
    questions: [later, now, other],
    selects: [
      list((options) => options[0]), // the blocking one first
      answer("yes"),
      list((options) => options.find((option) => option.includes("Favourite colour"))),
      answer("green"),
      list((options) => options.find((option) => option.includes("Pet's name"))),
      answer(OWN_ANSWER),
      list((options) => options[0]), // ➤ Send 2 answers
    ],
    inputs: ["Bella"],
  });
  await h.run("choices");
  const answers = () => h.calls.filter(([method]) => method === "session.answerQuestion").map(([, params]) => [params.questionId, params.answer]);
  assert.deepEqual(answers(), [[3, "yes"], [7, "green"], [8, "Bella"]], "the blocking answer first; the drafts together at the end");
  assert.deepEqual(lists[0], ["Questions for you", ["1. ? Proceed?", "2. ◇ Favourite colour?", "3. ◇ Pet's name?"]]);
  assert.deepEqual(asked[0], ["Proceed?", ["yes", "no", OWN_ANSWER]]);
  assert.equal(asked[1][0], "Favourite colour?\n\nNo hurry.");
  // Drafts show in the list, under a send entry, before anything of theirs is sent.
  assert.deepEqual(lists[2], ["Questions for you · 1 drafted, sent together", [sendLabel(1), "1. ✓ Favourite colour? → green", "2. ◇ Pet's name?"]]);
  assert.deepEqual(lists[3][1][0], sendLabel(2));
  assert.equal(lists.length, 4, "the list came back after each answer, and closed once nothing waited");
  assert.match(h.notices.at(-1)[0], /No questions are waiting/);
  assert.deepEqual(h.widgets.at(-1), ["agent-utils-choices", undefined]);
});

test("escaping keeps drafts (the line counts them) and questions pending; a free-text question takes typed text", async () => {
  const h = harness({ questions: [later], selects: [(_title, options) => options[0], "red", undefined] });
  await h.run("choices");
  assert.equal(h.calls.some(([method]) => method === "session.answerQuestion"), false);
  assert.equal(h.pending.length, 1);
  assert.match(h.notices.at(-1)[0], /1 drafted answer kept/);
  assert.deepEqual(h.widgets.at(-1), ["agent-utils-choices", ["◇ 1 question for you · 1 drafted · /choices"]]);
  // The next /choices offers to send it.
  let offered;
  h.ctx.ui.select = async (_title, options) => {
    offered ??= options;
    return offered === options ? options[0] : undefined;
  };
  await h.run("choices");
  assert.equal(offered[0], sendLabel(1));
  assert.deepEqual(h.calls.filter(([method]) => method === "session.answerQuestion").map(([, params]) => params), [{ questionId: 7, answer: "red" }]);

  const free = harness({ questions: [{ id: 9, question: "Name?", blocking: false }], selects: [(_title, options) => options[0], (_title, options) => options[0]], inputs: ["Ada"] });
  await free.run("choices");
  assert.deepEqual(free.calls.filter(([method]) => method === "session.answerQuestion").map(([, params]) => params), [{ questionId: 9, answer: "Ada" }]);
});

test("a draft for a question answered elsewhere goes", async () => {
  const h = harness({ questions: [later], selects: [(_title, options) => options[0], "red", undefined] });
  await h.run("choices");
  assert.match(h.widgets.at(-1)[1][0], /1 drafted/);
  // Answered from another client meanwhile.
  await h.ctx.chord.call("session.answerQuestion", { questionId: 7, answer: "green" });
  await h.emit("agent_end");
  assert.deepEqual(h.widgets.at(-1), ["agent-utils-choices", undefined]);
});

test("without pi-client's ctx.chord (TUI Pi) it does nothing, and /choices says why", async () => {
  const h = harness({ questions: [later] });
  delete h.ctx.chord;
  await h.emit("session_start");
  assert.equal(h.widgets.length, 0);
  await h.run("choices");
  assert.match(h.notices.at(-1)[0], /needs pi-client/);
});
