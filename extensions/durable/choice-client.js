// The client part of choice.mjs (bd-ac1906, bd-27804c), for pi-client: questions the session's
// agent asked without waiting (async_choice, or any non-blocking question) wait behind a line,
// "◇ N questions for you · /choices"; /choices lists every waiting question (blocking ones
// first) and stays open: pick one, answer it, and the list comes back. A non-blocking answer is a
// draft until "Send N answers" sends every draft together (the module delivers them to the agent
// as one message), so the agent does not start on the first while you answer the rest. A blocking
// question's answer goes at once: the agent is waiting for it. Escaping keeps drafts and leaves
// questions pending. Answers from elsewhere (another client, Cacophony) are
// picked up as the session works, and now and then while questions wait.
//
// What waits is a session's, and pi-client shows many sessions, a pane each. The line stands
// under its own session's editor and no other: where a ctx pinned to a pane has widgets of that
// pane's own (pi-client's `ui.widgetScope` "pane"), each pane looked at has its questions, its
// line and its looking-again kept apart here, and the line is drawn in that pane whoever has the
// focus. (It was one line for the whole client, drawn wherever the focus was: a session with
// nothing waiting said "/choices" for as long as it took to read its own questions, or longer.)
// In an earlier pi-client there is one line, which follows the focus as before.
//
// A question with choices can be answered in words ("✎ Your own answer") when it says so: a
// pi-daemon that honours `freeText` (bb1863d4, bd-dab67b) lists it on the question and takes the
// words through session.answerQuestion. Older hosts take only the choices there, so where the
// session runs choice.mjs's /answer, words go as `/answer ID TEXT` (a module command, run even
// while the agent works).
//
// It reaches the session through pi-client's ctx.chord (pi-daemon 1.14); in TUI Pi, where
// choice.js has its own inbox, it does nothing. List it in pi-client's client.extensions.

/** Look again this often while questions wait, for answers given elsewhere. */
export const CHOICES_POLL_MS = 5_000;
const WIDGET = "agent-utils-choices";

/** The line for `count` non-blocking questions (`drafted` of them answered, not sent), or none. */
export function choicesLine(count, theme, drafted = 0) {
  if (count === 0) return undefined;
  const text = `◇ ${count} question${count === 1 ? "" : "s"} for you${drafted > 0 ? ` · ${drafted} drafted` : ""} · /choices`;
  return [typeof theme?.fg === "function" ? theme.fg("accent", text) : text];
}

/** The list's first entry while drafts wait: send them all. */
export const sendLabel = (count) => `➤ Send ${count} answer${count === 1 ? "" : "s"}`;
/** A question with choices may still be answered in words. */
export const OWN_ANSWER = "✎ Your own answer…";

/** Waiting questions, blocking ones first, as /choices lists them. */
export function orderQuestions(questions) {
  return [...questions].sort((a, b) => Number(b.blocking !== false) - Number(a.blocking !== false));
}

export default function choiceClient(pi, { pollMs = CHOICES_POLL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  // A view: the questions of the session one pane shows (or, in a client whose widgets are all
  // the client's, of the session the focus is on), its line, and its looking-again.
  const newView = (ctx) => ({ ctx, session: "", questions: [], generation: 0, timer: undefined });
  // By the pane's pinned ctx (pi-client has one a pane): gone with the pane.
  const paneViews = new WeakMap();
  const clientView = newView(undefined);
  // The views that will look again, for session_shutdown.
  const polling = new Set();

  // Drafted answers by session and question, sent together from /choices.
  const drafts = new Map();
  const sessionOf = (ctx) => { try { return String(ctx?.sessionManager?.getSessionId?.() ?? ""); } catch { return ""; } };
  const draftKey = (view, id) => `${view.session}\u0000${id}`;
  const draftsOf = (view) => view.questions.filter((question) => drafts.has(draftKey(view, question.id)));
  const waiting = (view) => view.questions.filter((question) => question.blocking === false);
  const show = (view) => view.ctx?.ui?.setWidget?.(WIDGET, choicesLine(waiting(view).length, view.ctx.ui?.theme, draftsOf(view).length));
  const stop = (view) => {
    clearTimer(view.timer);
    view.timer = undefined;
    polling.delete(view);
  };

  // The view of the session ctx refers to now: its pane's own where panes have their own widgets.
  const viewOf = (ctx) => {
    if (ctx?.ui?.widgetScope !== undefined && typeof ctx.pinned === "function") {
      let pinned;
      try {
        pinned = ctx.pinned();
      } catch {
        pinned = undefined;
      }
      // (One pinned ctx a pane is what a pane's view is kept by: not so, there is one view.)
      if (pinned?.ui?.widgetScope === "pane" && ctx.pinned() === pinned) {
        let view = paneViews.get(pinned);
        if (view === undefined) paneViews.set(pinned, (view = newView(pinned)));
        return view;
      }
    }
    clientView.ctx = ctx;
    return clientView;
  };

  // Read a view's session's questions, and draw its line.
  const refresh = async (view) => {
    const ctx = view.ctx;
    if (typeof ctx?.chord?.call !== "function") return;
    const session = sessionOf(ctx);
    if (session !== view.session) {
      // Another session than the questions held are of (the pane came to show it; with one
      // view, the focus went to it): they are not shown under it while its own are read.
      view.session = session;
      stop(view);
      if (view.questions.length > 0) {
        view.questions = [];
        show(view);
      }
    }
    const mine = ++view.generation;
    let listed;
    try {
      listed = await ctx.chord.call("session.questions");
    } catch {
      return;
    }
    if (mine !== view.generation) return;
    // It came to show another session while this one was asked about: that one's are read.
    if (sessionOf(ctx) !== session) return refresh(view);
    view.questions = Array.isArray(listed) ? listed.filter((question) => typeof question?.id === "number" && typeof question.question === "string") : [];
    // Drafts for questions answered elsewhere (or withdrawn) go.
    const open = new Set(view.questions.map((question) => draftKey(view, question.id)));
    for (const key of [...drafts.keys()]) if (key.startsWith(`${session}\u0000`) && !open.has(key)) drafts.delete(key);
    show(view);
    stop(view);
    if (waiting(view).length > 0) {
      view.timer = setTimer(() => void refresh(view), pollMs);
      view.timer?.unref?.();
      polling.add(view);
    }
  };

  pi.on("session_start", (_event, ctx) => refresh(viewOf(ctx)));
  pi.on("tool_execution_end", (_event, ctx) => refresh(viewOf(ctx)));
  pi.on("agent_end", (_event, ctx) => refresh(viewOf(ctx)));
  pi.on("session_shutdown", () => {
    for (const view of [...polling]) stop(view);
  });

  pi.registerCommand("choices", {
    description: "Questions waiting for your answer: the agent's choices, blocking or not",
    handler: async (_args, typed) => {
      if (typeof typed?.chord?.call !== "function") {
        typed?.ui?.notify?.("/choices here lists pi-daemon sessions' questions: it needs pi-client.", "warning");
        return;
      }
      // The session the command was typed for, and its pane, wherever the focus goes meanwhile.
      const view = viewOf(typed);
      const ctx = view.ctx;
      // Whether the session's daemon runs choice.mjs's /answer (answers in words).
      let answersInWords;
      const takesWords = async () => {
        if (answersInWords === undefined) {
          try {
            const listed = await ctx.chord.call("session.commands");
            answersInWords = (listed?.items ?? []).some((command) => command?.name === "answer" && command.kind === "extension");
          } catch {
            answersInWords = false;
          }
        }
        return answersInWords;
      };
      const inWords = (question, answer) => Array.isArray(question.choices) && question.choices.length > 0 && !question.choices.includes(answer);
      const send = async (question, answer) => {
        try {
          if (inWords(question, answer) && question.freeText !== true) {
            if (!(await takesWords())) throw new Error("this session takes one of the question's choices only (answers in words need agent-utils' choice.mjs with /answer)");
            const result = await ctx.chord.call("conversation.submit", { requestId: `choices-answer:${question.id}:${Date.now()}`, content: `/answer ${question.id} ${answer}`, wait: true });
            const failed = (result?.notices ?? []).map(String).find((notice) => /^\/answer failed:/.test(notice));
            if (failed !== undefined) throw new Error(failed.replace(/^\/answer failed:\s*/, ""));
          } else {
            await ctx.chord.call("session.answerQuestion", { questionId: question.id, answer });
          }
          drafts.delete(draftKey(view, question.id));
          return true;
        } catch (error) {
          ctx.ui.notify(`Answer failed: ${error?.message ?? error}`, "error");
          return false;
        }
      };
      // The list stays open: answer one, and it comes back with the rest.
      for (;;) {
        await refresh(view);
        const questions = view.questions;
        if (questions.length === 0) {
          ctx.ui.notify("No questions are waiting for you.", "info");
          return;
        }
        const ordered = orderQuestions(questions);
        const drafted = draftsOf(view);
        const labels = ordered.map((question, index) => {
          const draft = drafts.get(draftKey(view, question.id));
          return `${index + 1}. ${draft !== undefined ? "✓" : question.blocking === false ? "◇" : "?"} ${question.question.replace(/\s+/g, " ")}${draft !== undefined ? ` → ${draft}` : ""}`;
        });
        const items = drafted.length > 0 ? [sendLabel(drafted.length), ...labels] : labels;
        const title = drafted.length > 0 ? `Questions for you · ${drafted.length} drafted, sent together` : "Questions for you";
        const picked = await ctx.ui.select(title, items);
        if (picked === undefined) {
          // Escaping keeps the drafts for the next /choices.
          if (drafted.length > 0) ctx.ui.notify(`${drafted.length} drafted answer${drafted.length === 1 ? "" : "s"} kept: /choices sends them.`, "info");
          show(view);
          return;
        }
        if (picked === sendLabel(drafted.length)) {
          // Back to back: the module delivers answers given together as one message.
          let sent = 0;
          for (const question of drafted) if (await send(question, drafts.get(draftKey(view, question.id)))) sent += 1;
          ctx.ui.notify(`Sent ${sent} answer${sent === 1 ? "" : "s"}.`, "info");
          continue;
        }
        const question = ordered[labels.indexOf(picked)];
        if (question === undefined) continue;
        const prompt = question.context ? `${question.question}\n\n${question.context}` : question.question;
        const choices = Array.isArray(question.choices) && question.choices.length > 0 ? question.choices : undefined;
        // Answers in words only where the session takes them (choice.mjs's /answer).
        const options = choices === undefined ? undefined : question.freeText === true || (await takesWords()) ? [...choices, OWN_ANSWER] : choices;
        let answer = options === undefined ? await ctx.ui.input(prompt, "Your answer") : await ctx.ui.select(prompt, options);
        if (answer === OWN_ANSWER) answer = await ctx.ui.input(prompt, "Your answer");
        // Escaping goes back to the list; the question stays pending.
        if (answer === undefined || answer === "") continue;
        // The agent waits for a blocking question: it goes at once. Others wait as drafts.
        if (question.blocking !== false) await send(question, answer);
        else drafts.set(draftKey(view, question.id), answer);
      }
    },
  });
}
