// choice.mjs's client part for pi-client (extensions/durable/choice-client.js, bd-27804c).
import test from "node:test";
import assert from "node:assert/strict";

import choiceClient, { choicesLine, orderQuestions } from "../extensions/durable/choice-client.js";

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

test("/choices lists them blocking first and answers the one picked; the line goes", async () => {
  let listed;
  let asked;
  const h = harness({
    questions: [later, now],
    selects: [(title, options) => ((listed = [title, options]), options[1]), (title, options) => ((asked = [title, options]), "green")],
  });
  await h.run("choices");
  assert.deepEqual(listed, ["Questions for you", ["1. ? Proceed?", "2. ◇ Favourite colour?"]]);
  assert.deepEqual(asked, ["Favourite colour?\n\nNo hurry.", ["red", "green"]]);
  assert.deepEqual(h.calls.find(([method]) => method === "session.answerQuestion"), ["session.answerQuestion", { questionId: 7, answer: "green" }]);
  assert.deepEqual(h.widgets.at(-1), ["agent-utils-choices", undefined]);
});

test("escaping leaves the question pending; a free-text question takes typed text", async () => {
  const h = harness({ questions: [later], selects: [(_title, options) => options[0], undefined] });
  await h.run("choices");
  assert.equal(h.calls.some(([method]) => method === "session.answerQuestion"), false);
  assert.equal(h.pending.length, 1);
  const free = harness({ questions: [{ id: 9, question: "Name?", blocking: false }], selects: [(_title, options) => options[0]], inputs: ["Ada"] });
  await free.run("choices");
  assert.deepEqual(free.calls.at(-2), ["session.answerQuestion", { questionId: 9, answer: "Ada" }]);
});

test("without pi-client's ctx.chord (TUI Pi) it does nothing, and /choices says why", async () => {
  const h = harness({ questions: [later] });
  delete h.ctx.chord;
  await h.emit("session_start");
  assert.equal(h.widgets.length, 0);
  await h.run("choices");
  assert.match(h.notices.at(-1)[0], /needs pi-client/);
});
