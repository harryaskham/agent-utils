// The client part of choice.mjs (bd-ac1906, bd-27804c), for pi-client: questions the session's
// agent asked without waiting (async_choice, or any non-blocking question) wait behind a line,
// "◇ N questions for you · /choices"; /choices lists every waiting question (blocking ones
// first) and asks the one picked with Pi's dialogs; the answer goes back to the session.
// Escaping leaves a question pending. Answers from elsewhere (another client, Cacophony) are
// picked up as the session works, and now and then while questions wait.
//
// It reaches the session through pi-client's ctx.chord (pi-daemon 1.14); in TUI Pi, where
// choice.js has its own inbox, it does nothing. List it in pi-client's client.extensions.

/** Look again this often while questions wait, for answers given elsewhere. */
export const CHOICES_POLL_MS = 5_000;
const WIDGET = "agent-utils-choices";

/** The line for `count` non-blocking questions, or none. */
export function choicesLine(count, theme) {
  if (count === 0) return undefined;
  const text = `◇ ${count} question${count === 1 ? "" : "s"} for you · /choices`;
  return [typeof theme?.fg === "function" ? theme.fg("accent", text) : text];
}

/** Waiting questions, blocking ones first, as /choices lists them. */
export function orderQuestions(questions) {
  return [...questions].sort((a, b) => Number(b.blocking !== false) - Number(a.blocking !== false));
}

export default function choiceClient(pi, { pollMs = CHOICES_POLL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let questions = [];
  let timer;
  let generation = 0;

  const waiting = () => questions.filter((question) => question.blocking === false);
  const show = (ctx) => ctx.ui?.setWidget?.(WIDGET, choicesLine(waiting().length, ctx.ui?.theme));

  // The questions of the session ctx refers to now (pi-client's focused pane).
  const refresh = async (ctx) => {
    if (typeof ctx?.chord?.call !== "function") return;
    const mine = ++generation;
    let listed;
    try {
      listed = await ctx.chord.call("session.questions");
    } catch {
      return;
    }
    if (mine !== generation) return;
    questions = Array.isArray(listed) ? listed.filter((question) => typeof question?.id === "number" && typeof question.question === "string") : [];
    show(ctx);
    clearTimer(timer);
    timer = undefined;
    if (waiting().length > 0) {
      timer = setTimer(() => void refresh(ctx), pollMs);
      timer?.unref?.();
    }
  };

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("tool_execution_end", (_event, ctx) => refresh(ctx));
  pi.on("agent_end", (_event, ctx) => refresh(ctx));
  pi.on("session_shutdown", () => {
    clearTimer(timer);
    timer = undefined;
  });

  pi.registerCommand("choices", {
    description: "Questions waiting for your answer: the agent's choices, blocking or not",
    handler: async (_args, ctx) => {
      if (typeof ctx?.chord?.call !== "function") {
        ctx?.ui?.notify?.("/choices here lists pi-daemon sessions' questions: it needs pi-client.", "warning");
        return;
      }
      await refresh(ctx);
      if (questions.length === 0) {
        ctx.ui.notify("No questions are waiting for you.", "info");
        return;
      }
      const ordered = orderQuestions(questions);
      const labels = ordered.map((question, index) => `${index + 1}. ${question.blocking === false ? "◇" : "?"} ${question.question.replace(/\s+/g, " ")}`);
      const picked = await ctx.ui.select("Questions for you", labels);
      if (picked === undefined) return;
      const question = ordered[labels.indexOf(picked)];
      if (question === undefined) return;
      const title = question.context ? `${question.question}\n\n${question.context}` : question.question;
      const answer = Array.isArray(question.choices) && question.choices.length > 0 ? await ctx.ui.select(title, question.choices) : await ctx.ui.input(title, "Your answer");
      // Escaping leaves it pending.
      if (answer === undefined || answer === "") return;
      try {
        await ctx.chord.call("session.answerQuestion", { questionId: question.id, answer });
      } catch (error) {
        ctx.ui.notify(`Answer failed: ${error?.message ?? error}`, "error");
      }
      await refresh(ctx);
    },
  });
}
