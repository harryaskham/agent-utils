// choice.mjs's client part for pi-client (extensions/durable/choice-client.js, bd-27804c).
import test from "node:test";
import assert from "node:assert/strict";

import choiceClient, { OWN_ANSWER, choicesLine, orderQuestions, sendLabel } from "../extensions/durable/choice-client.js";

/**
 * A pi-client ctx over a fake daemon session. Like pi-daemon, session.answerQuestion takes one of a
 * question's choices only; `/answer ID TEXT` (choice.mjs, listed by session.commands when
 * `answerCommand`) answers in words.
 */
function harness({ questions, selects = [], inputs = [], answerCommand = true, answerFails } = {}) {
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
          const question = pending.find((candidate) => candidate.id === params.questionId);
          if (question?.choices && question.freeText !== true && !question.choices.includes(params.answer)) throw new Error("answer is not one of the question's choices");
          pending = pending.filter((candidate) => candidate.id !== params.questionId);
          return null;
        }
        if (method === "session.commands") return { items: answerCommand ? [{ name: "answer", kind: "extension", description: "" }] : [{ name: "compact", kind: "builtin", description: "" }] };
        if (method === "conversation.submit") {
          const match = /^\/answer (\d+) ([\s\S]+)$/.exec(params.content);
          assert.ok(match, `a module command, not a prompt: ${params.content}`);
          if (answerFails) return { command: "answer", status: "done", notices: [`/answer failed: ${answerFails}`] };
          pending = pending.filter((candidate) => candidate.id !== Number(match[1]));
          return { command: "answer", status: "done", notices: [`Answered question ${match[1]}: ${match[2]}`] };
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
  const answers = () =>
    h.calls
      .filter(([method]) => method === "session.answerQuestion" || method === "conversation.submit")
      .map(([method, params]) => (method === "session.answerQuestion" ? [params.questionId, params.answer] : ["words", params.content]));
  assert.deepEqual(answers(), [[3, "yes"], [7, "green"], ["words", "/answer 8 Bella"]], "the blocking answer first; the drafts together at the end; words through /answer");
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

test("an answer in words goes through /answer; where the session has none, only the choices are offered", async () => {
  const words = { id: 8, question: "Pet's name?", choices: ["Rex", "Tom"], blocking: true };
  const h = harness({ questions: [words], selects: [(_title, options) => options[0], OWN_ANSWER], inputs: ["Bella"] });
  await h.run("choices");
  assert.deepEqual(h.calls.filter(([method]) => method === "conversation.submit").map(([, params]) => params.content), ["/answer 8 Bella"]);
  assert.equal(h.calls.some(([method, params]) => method === "session.answerQuestion" && params.answer === "Bella"), false, "never as a choice it is not");
  assert.equal(h.pending.length, 0);

  // The daemon refuses (a question that takes its choices only): the error shows, the question stays.
  const strict = harness({ questions: [words], selects: [(_title, options) => options[0], OWN_ANSWER, undefined], inputs: ["Bella"], answerFails: "question 8 takes one of its choices only" });
  await strict.run("choices");
  assert.ok(strict.notices.some(([text]) => text === "Answer failed: question 8 takes one of its choices only"), JSON.stringify(strict.notices));
  assert.equal(strict.pending.length, 1);

  // No /answer on the session (an older agent-utils): only the choices.
  let offered;
  const old = harness({ questions: [words], answerCommand: false, selects: [(_title, options) => options[0], (_title, options) => ((offered = options), "Rex")] });
  await old.run("choices");
  assert.deepEqual(offered, ["Rex", "Tom"]);
  assert.equal(old.calls.some(([method]) => method === "conversation.submit"), false);
});

test("a question that says freeText (pi-daemon bb1863d4) takes words through session.answerQuestion itself", async () => {
  const words = { id: 8, question: "Pet's name?", choices: ["Rex", "Tom"], blocking: true, freeText: true };
  let offered;
  const h = harness({ questions: [words], answerCommand: false, selects: [(_title, options) => options[0], (_title, options) => ((offered = options), OWN_ANSWER)], inputs: ["Bella"] });
  await h.run("choices");
  assert.deepEqual(offered, ["Rex", "Tom", OWN_ANSWER], "offered without /answer: the host takes words");
  assert.deepEqual(h.calls.filter(([method]) => method === "session.answerQuestion").map(([, params]) => params), [{ questionId: 8, answer: "Bella" }]);
  assert.equal(h.calls.some(([method]) => method === "conversation.submit"), false);
  assert.equal(h.pending.length, 0);
});

/**
 * A pi-client with several panes, a session each (pi-daemon bd-02a7f8): the ctx of an event or a
 * command refers to the focused pane; `ctx.pinned()` is that pane's own ctx (one a pane), whose
 * widgets are drawn in that pane only (`ui.widgetScope` "pane"). `scoped: false` is an earlier
 * pi-client: every widget is the client's, drawn wherever the focus is.
 */
function panesHarness(sessions, { scoped = true, selects = [] } = {}) {
  const handlers = new Map();
  const answers = [];
  const select = async (title, options) => {
    const pick = selects.shift();
    return typeof pick === "function" ? pick(title, options) : pick;
  };
  const commands = new Map();
  const timers = [];
  const notices = [];
  // What each pane shows of the line now, and every line ever drawn in it.
  const panes = new Map();
  const clientWidget = { now: undefined };
  let focused;
  // Calls held until released, to act while one is on its way.
  let hold;
  const pane = (name) => panes.get(name);
  const paneCtx = (state) => ({
    sessionManager: { getSessionId: () => (state.closed ? undefined : state.session) },
    chord: {
      async call(method, params) {
        const session = state.closed ? undefined : state.session;
        state.calls.push(method);
        if (session === undefined) throw new Error("no session attached");
        if (method === "session.commands") return { items: [] };
        if (method === "session.answerQuestion") {
          answers.push([state.name, session, params.questionId, params.answer]);
          sessions[session] = (sessions[session] ?? []).filter((question) => question.id !== params.questionId);
          return null;
        }
        assert.equal(method, "session.questions");
        // As the host answered when it was asked, however late that arrives.
        const listed = sessions[session] ?? [];
        if (hold !== undefined) await hold;
        return listed;
      },
    },
    ui: {
      widgetScope: "pane",
      setWidget: (_key, lines) => {
        state.now = lines;
        if (lines !== undefined) state.drawn.push(lines[0]);
      },
      notify: (text, level) => notices.push([state.name, text, level]),
      select,
      input: async () => undefined,
    },
    pinned: () => state.ctx,
  });
  const add = (name, session) => {
    const state = { name, session, closed: false, now: undefined, drawn: [], calls: [] };
    state.ctx = paneCtx(state);
    panes.set(name, state);
    focused ??= state;
    return state;
  };
  // The ctx extensions are given: whatever pane has the focus when each call is made.
  const ctx = {
    sessionManager: { getSessionId: () => focused.ctx.sessionManager.getSessionId() },
    chord: { call: (method, params) => focused.ctx.chord.call(method, params) },
    ui: {
      ...(scoped ? { widgetScope: "client" } : {}),
      setWidget: (_key, lines) => {
        clientWidget.now = lines;
        // The client's widgets are drawn where the focus is.
        if (lines !== undefined) focused.drawn.push(lines[0]);
      },
      notify: (text, level) => notices.push([focused.name, text, level]),
      select,
      input: async () => undefined,
    },
    pinned: () => (scoped ? focused.ctx : { ...focused.ctx, ui: { ...focused.ctx.ui, widgetScope: undefined, setWidget: ctx.ui.setWidget } }),
  };
  const pi = { on: (type, handler) => handlers.set(type, handler), registerCommand: (name, options) => commands.set(name, options) };
  choiceClient(pi, { pollMs: 10, setTimer: (fn) => (timers.push(fn), fn), clearTimer: (fn) => { const at = timers.indexOf(fn); if (at >= 0) timers.splice(at, 1); } });
  return {
    add,
    pane,
    notices,
    timers,
    answers,
    clientWidget,
    focus: (name) => { focused = pane(name); },
    // As pi-client says a pane's session has started: the pane has the focus.
    start: (name) => { focused = pane(name); return handlers.get("session_start")({ type: "session_start" }, ctx); },
    emit: (type) => handlers.get(type)({ type }, ctx),
    run: (name) => commands.get(name).handler("", ctx),
    // Run every look-again that is due, as the timer would.
    tick: async () => { for (const fn of timers.splice(0)) await fn(); },
    held: () => { let release; hold = new Promise((resolve) => { release = resolve; }); return () => { hold = undefined; release(); }; },
    // Calls from now on answer at once; one held before still waits for its release.
    passing: () => { hold = undefined; },
  };
}

const LINE = "◇ 1 question for you · /choices";

test("each session's line is drawn in its own pane and no other, whoever has the focus (pi-daemon bd-02a7f8)", async () => {
  const h = panesHarness({ asked: [later], quiet: [], calm: [] });
  h.add("x", "asked"); h.add("y", "quiet"); h.add("z", "calm");
  await h.start("x");
  assert.deepEqual(h.pane("x").now, [LINE]);
  // The focus goes to a session with nothing waiting, and its questions take a while to read:
  // nothing is drawn under it meanwhile, or after; the first pane keeps its line.
  const release = h.held();
  const started = h.start("y");
  assert.equal(h.pane("y").now, undefined, "nothing of another session's while its own are read");
  // The first pane's look-again comes due while the second's questions are on their way.
  const ticked = h.tick();
  release();
  await started; await ticked;
  assert.deepEqual(h.pane("y").drawn, [], "a session with nothing waiting never says /choices");
  assert.deepEqual(h.pane("x").now, [LINE], "the session that has one keeps its line, without the focus");
  await h.start("z");
  await h.emit("tool_execution_end");
  await h.emit("agent_end");
  assert.deepEqual(h.pane("z").drawn, []);
  assert.equal(h.clientWidget.now, undefined, "nothing is set as the client's, which is drawn wherever the focus is");
  // /choices typed where nothing waits says so, and leaves the other pane's line.
  await h.run("choices");
  assert.deepEqual(h.notices.at(-1), ["z", "No questions are waiting for you.", "info"]);
  assert.deepEqual(h.pane("x").now, [LINE]);
});

test("a pane's line goes when its question is answered elsewhere, though the focus is on another pane", async () => {
  const sessions = { asked: [later], quiet: [] };
  const h = panesHarness(sessions);
  h.add("x", "asked"); h.add("y", "quiet");
  await h.start("x");
  await h.start("y");
  assert.equal(h.timers.length, 1, "the session with a question waiting is looked at again; the other is not");
  // The client stops: nothing looks again. (Started again, it does.)
  await h.emit("session_shutdown");
  assert.equal(h.timers.length, 0);
  await h.start("x");
  h.focus("y");
  assert.equal(h.timers.length, 1);
  await h.tick();
  assert.deepEqual(h.pane("x").now, [LINE]);
  assert.equal(h.timers.length, 1);
  sessions.asked = [];
  await h.tick();
  assert.equal(h.pane("x").now, undefined, "answered from another client: its line goes, in its pane");
  assert.equal(h.timers.length, 0, "and nothing looks again");
  assert.deepEqual(h.pane("y").calls, ["session.questions"], "the pane with the focus was not asked for it");
});

test("a pane that comes to show another session does not keep the first one's line; one that closed is looked at no more", async () => {
  const h = panesHarness({ asked: [later], quiet: [], other: [{ ...later, id: 9 }] });
  h.add("x", "asked"); h.add("y", "other");
  await h.start("x");
  await h.start("y");
  assert.equal(h.timers.length, 2);
  // The first pane shows another session now: its line is not that session's.
  h.pane("x").session = "quiet";
  const release = h.held();
  const started = h.start("x");
  assert.equal(h.pane("x").now, undefined, "gone before the new session's questions are read");
  release();
  await started;
  assert.equal(h.pane("x").now, undefined);
  assert.equal(h.timers.length, 1, "only the pane with a question waiting is looked at again");
  // The other pane closes with its question waiting: looked at once more, and no more.
  h.pane("y").closed = true;
  await h.tick();
  assert.equal(h.timers.length, 0, "a closed pane is not looked at again");
  // A session that changes under a read on its way: the answer is not taken for the new one.
  const z = h.add("z", "asked");
  const later2 = h.held();
  const reading = h.start("z");
  z.session = "quiet";
  later2();
  await reading;
  assert.equal(z.now, undefined, "the first session's questions are not shown under the second");
  assert.deepEqual(z.drawn, []);
  assert.deepEqual(z.calls, ["session.questions", "session.questions"], "the new session's own were read");
});

test("in an earlier pi-client (every widget the client's) one line follows the focus, and goes at once from a session it is not of", async () => {
  const h = panesHarness({ asked: [later], quiet: [] }, { scoped: false });
  h.add("x", "asked"); h.add("y", "quiet");
  await h.start("x");
  assert.deepEqual(h.clientWidget.now, [LINE]);
  const release = h.held();
  const started = h.start("y");
  assert.equal(h.clientWidget.now, undefined, "taken away before the other session's questions are read");
  assert.equal(h.timers.length, 0, "and the first session is not looked at again under the second");
  release();
  await started;
  assert.equal(h.clientWidget.now, undefined);
  assert.deepEqual(h.pane("y").drawn, []);
  await h.start("x");
  assert.deepEqual(h.clientWidget.now, [LINE]);
});

test("an answer that arrives late does not overtake a later one; /choices acts on the pane it was typed in, wherever the focus goes", async () => {
  const sessions = { asked: [later], quiet: [] };
  const h = panesHarness(sessions, {
    selects: [
      // The list is open in the first pane, and the focus goes to the other one.
      (_title, options) => (h.focus("y"), options[0]),
      "green",
      (_title, options) => options[0], // ➤ Send 1 answer
    ],
  });
  h.add("x", "asked"); h.add("y", "quiet");
  // Asked while the question waits, and answered late: by then it was answered elsewhere and a
  // later read said so.
  const release = h.held();
  const first = h.start("x");
  h.passing();
  sessions.asked = [];
  await h.emit("agent_end");
  assert.equal(h.pane("x").now, undefined);
  release();
  await first;
  assert.equal(h.pane("x").now, undefined, "the earlier read, arriving late, draws nothing");
  assert.deepEqual(h.pane("x").drawn, []);
  assert.equal(h.timers.length, 0);

  sessions.asked = [later];
  await h.start("x");
  await h.run("choices");
  assert.deepEqual(h.answers, [["x", "asked", 7, "green"]], "the answer goes to the session /choices was typed for");
  assert.deepEqual(h.notices.at(-1), ["x", "No questions are waiting for you.", "info"], "and what it says, it says there");
  assert.deepEqual(h.pane("y").drawn, []);
});
