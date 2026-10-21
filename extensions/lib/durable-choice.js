// Choices for pi-daemon sessions (bd-ac1906): agent-utils' interactive_choice and async_choice as
// a Durable profile module, on pi-daemon's questions. A question is pi-daemon's question document
// (`pi-daemon.input`, task scope) on the task that asks it:
// - interactive_choice records it on its own tool call and waits (blocking, as ask_user);
// - async_choice gives each question a background task of its own, marked blocking: false, and
//   returns at once; the task waits for the answer and steers the conversation with it.
// Clients see both through pi-daemon (pi-client's question and /choices, AHP input requests),
// and the answers survive restarts. async_choice_status and async_choice_cancel read and settle
// the session's record of async questions. Plain objects only: no pi-durable import.

/** pi-daemon's question document (src/input.ts): any task may carry one. */
export const INPUT_DOC = {
  definition: { kind: "pi-daemon.input", version: 1, scope: "task", initial: () => ({ status: "pending", question: "" }) },
};

/** The session's async questions, for status and cancel (tools cannot inspect tasks). */
export const ASYNC_DOC = {
  definition: { kind: "agent-utils.async-choices", version: 1, scope: "session", initial: () => ({ records: {} }) },
};

export const ASYNC_TASK = "agent-utils.async-choice";
export const MAX_CHOICES = 9;
export const MAX_ASYNC_PENDING = 64;
export const MAX_ASYNC_PER_CALL = 8;
const MAX_TEXT = 4_000;
const MAX_LABEL = 200;

const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A tool's choices with ids, and each one's label as shown (its headline, else its label). */
export function normalizeChoices(choices) {
  if (!Array.isArray(choices) || choices.length < 2) throw new Error("give at least two choices");
  if (choices.length > MAX_CHOICES) throw new Error(`at most ${MAX_CHOICES} choices`);
  const seen = new Set();
  return choices.map((choice, index) => {
    const label = clip(choice?.label, MAX_LABEL);
    if (!label) throw new Error(`choice ${index + 1} has no label`);
    let shown = clip(choice.headline || label, MAX_LABEL);
    // Shown labels must differ: the answer is one of them.
    while (seen.has(shown)) shown = `${shown} (${index + 1})`;
    seen.add(shown);
    return {
      id: clip(choice.id, 64) || String(index + 1),
      label,
      shown,
      ...(choice.summary ? { summary: clip(choice.summary, 400) } : {}),
      ...(choice.value !== undefined ? { value: choice.value } : {}),
    };
  });
}

/** The question's background as pi-daemon shows it: the caller's context, then each choice's summary. */
export function questionContext(context, choices) {
  const summaries = choices.filter((choice) => choice.summary).map((choice) => `${choice.shown}: ${choice.summary}`);
  return [clip(context, MAX_TEXT), ...summaries].filter(Boolean).join("\n") || undefined;
}

/** What a settled question means: the choice picked (by its shown label), or nothing. */
export function choiceResult(choices, state) {
  if (state?.status === "answered") {
    const index = choices.findIndex((choice) => choice.shown === state.answer);
    if (index < 0) return { status: "freeform", text: String(state.answer ?? "") };
    const choice = choices[index];
    return { status: "selected", index, id: choice.id, label: choice.label, ...(choice.value !== undefined ? { value: choice.value } : {}) };
  }
  return { status: state?.status === "cancelled" ? "cancelled" : "timeout" };
}

export function resultText(result) {
  if (result.status === "selected") return `selected ${result.index + 1}: ${result.label}`;
  if (result.status === "freeform") return `answered: ${result.text}`;
  if (result.status === "timeout") return "no selection (timed out)";
  return "no selection (cancelled)";
}

/** Record a question on a task, once: a replayed call finds it and keeps waiting. */
async function recordQuestion(tx, taskId, { question, choices, context, blocking }) {
  const doc = await tx.doc(INPUT_DOC, taskId);
  if (doc.question === "") {
    doc.question = clip(question, MAX_TEXT);
    doc.choices = choices.map((choice) => choice.shown);
    if (context) doc.context = context;
    if (blocking === false) doc.blocking = false;
  }
  return { status: doc.status, question: doc.question, ...(doc.answer === undefined ? {} : { answer: doc.answer }) };
}

/** Wait until a task's question is answered or cancelled (or `timeoutMs`, then cancel it). */
async function waitForAnswer(watchable, commit, taskId, context, { timeoutMs, signal } = {}) {
  const watch = await watchable.watchDoc(INPUT_DOC, taskId, context);
  if (watch === undefined) throw new Error("the question is missing");
  let timer;
  let aborted = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const settle = (value) => {
        if (value !== null && value !== undefined && value.status !== "pending") resolve(value);
      };
      aborted = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) return aborted();
      signal?.addEventListener?.("abort", aborted, { once: true });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          void commit(async (tx) => {
            const doc = await tx.doc(INPUT_DOC, taskId);
            if (doc.status === "pending") doc.status = "cancelled";
            return { status: doc.status, question: doc.question, ...(doc.answer === undefined ? {} : { answer: doc.answer }) };
          }).then((state) => resolve(state.status === "cancelled" ? { ...state, status: "timeout" } : state), reject);
        }, timeoutMs);
      }
      settle(watch.value);
      watch.start(async (value) => settle(value));
    });
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener?.("abort", aborted);
    await watch.stop().catch(() => undefined);
  }
}

const CHOICE_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable option ID; generated when omitted." },
    label: { type: "string", description: "Choice label returned on selection." },
    headline: { type: "string", description: "Short display headline; defaults to label." },
    summary: { type: "string", description: "Optional short explanation." },
    value: { description: "Optional caller value returned with the answer." },
  },
  required: ["label"],
};

/** The async question task (a Durable task definition as a plain object). */
export function createAsyncChoiceTask() {
  const finish = (runtime, task, context, record) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(ASYNC_DOC);
      const current = doc.records[String(runtime.taskId)];
      if (current) Object.assign(current, record, { settledAt: Date.now() });
      return { status: "terminal", outcome: { status: "completed", result: record } };
    }, context);
  return {
    definition: {
      name: ASYNC_TASK,
      version: 1,
      initial: () => ({ phase: "wait" }),
      phases: {
        async wait(task, runtime, context) {
          const { question, choices, key } = task.input;
          const settled = await waitForAnswer(runtime, (change) => runtime.commit(change, context), runtime.taskId, context, { signal: runtime.signal });
          const result = choiceResult(choices, settled);
          if (result.status === "selected" || result.status === "freeform") {
            // The answer reaches the agent as a steering message, as the TUI's async choices do.
            const conversation = await runtime.conversation(runtime.conversationId, context);
            const answer = result.status === "selected" ? `${result.label}${result.value !== undefined ? ` (${JSON.stringify(result.value)})` : ""}` : result.text;
            const content = `[async_choice answer] ${key ? `${key}: ` : ""}"${question}" → ${answer} (id ${runtime.taskId})`;
            await conversation?.submit({ type: "input", content, whenBusy: "steer", requestId: `async-choice:${runtime.taskId}` }, context);
          }
          await finish(runtime, task, context, { status: result.status === "selected" || result.status === "freeform" ? "answered" : result.status, result });
        },
      },
      async abort(task, runtime, context) {
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(ASYNC_DOC);
          const current = doc.records[String(runtime.taskId)];
          if (current && current.status === "pending") Object.assign(current, { status: "cancelled", settledAt: Date.now() });
          return { status: "terminal", outcome: { status: "aborted", reason: "async choice withdrawn" } };
        }, context);
      },
    },
  };
}

const text = (value, details) => ({ content: [{ type: "text", text: value }], ...(details === undefined ? {} : { details }) });

/** The tools: interactive_choice, async_choice, async_choice_status, async_choice_cancel. */
export function createChoiceTools({ asyncTask = createAsyncChoiceTask(), now = () => Date.now() } = {}) {
  const interactive = {
    name: "interactive_choice",
    description:
      "Ask the user to choose one option and wait for the answer. The question shows in the user's clients (pi-client, the web view, AHP clients); treat a timeout or cancellation as no selection, never infer an answer.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Question to show." },
        choices: { type: "array", items: CHOICE_SCHEMA, minItems: 2, maxItems: MAX_CHOICES },
        context: { type: "string", description: "Optional longer background shown under the question." },
        timeoutMs: { type: "integer", minimum: 0, description: "Advisory timeout in milliseconds; 0 or omitted waits." },
      },
      required: ["question", "choices"],
    },
    async execute(args, api, context) {
      let choices;
      try {
        choices = normalizeChoices(args.choices);
      } catch (error) {
        return { ...text(`interactive_choice: ${error.message}`), isError: true };
      }
      const recorded = await api.commit((tx) => recordQuestion(tx, api.taskId, { question: args.question, choices, context: questionContext(args.context, choices) }), context);
      const settled =
        recorded.status === "pending"
          ? await waitForAnswer(api, (change) => api.commit(change, context), api.taskId, context, { timeoutMs: Number(args.timeoutMs) || 0, signal: context?.abortSignal })
          : recorded;
      const result = choiceResult(choices, settled);
      return text(resultText(result), result);
    },
  };

  const askOne = async (tx, conversationId, item, identity) => {
    const choices = normalizeChoices(item.choices);
    const question = clip(item.question, MAX_TEXT);
    if (!question) throw new Error("a question needs text");
    const key = item.key ? clip(item.key, 120) : undefined;
    // Task-scoped documents are addressed by the task's (numeric) id; the records keep it as text.
    const taskId = await tx.createTask(asyncTask, { question, choices, ...(key ? { key } : {}), ...(identity ? { identity } : {}) }, { ownership: { kind: "conversation" }, conversationId, background: true });
    await recordQuestion(tx, taskId, { question, choices, context: questionContext(item.context, choices), blocking: false });
    const doc = await tx.doc(ASYNC_DOC);
    const id = String(taskId);
    doc.records[id] = { id, ...(key ? { key } : {}), question, choices: choices.map((choice) => choice.shown), status: "pending", askedAt: now() };
    return doc.records[id];
  };

  const pending = (doc) => Object.values(doc.records ?? {}).filter((record) => record.status === "pending");
  const lookup = (doc, ids) => {
    const records = Object.values(doc.records ?? {});
    if (!Array.isArray(ids) || ids.length === 0) return records;
    return ids.map((id) => records.find((record) => record.id === String(id)) ?? [...records].reverse().find((record) => record.key === String(id)) ?? { id: String(id), status: "unknown" });
  };
  const line = (record) =>
    `- ${record.id}${record.key ? ` [key=${record.key}]` : ""}: ${record.status}${record.result ? ` — ${resultText(record.result)}` : ""} — "${record.question ?? ""}"`;

  const post = {
    name: "async_choice",
    description:
      "Post one or more non-blocking multiple-choice questions to the user and keep working. Returns question IDs immediately; each answer arrives later as a steering message ([async_choice answer]). The user answers with /choices in pi-client, in the web view, or an AHP client.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Single question to ask (use with choices)." },
        choices: { type: "array", items: CHOICE_SCHEMA, minItems: 2, maxItems: MAX_CHOICES },
        context: { type: "string", description: "Optional longer background shown under the question." },
        key: { type: "string", description: "Optional correlation key echoed with the answer; also accepted by status and cancel." },
        questions: {
          type: "array",
          minItems: 1,
          maxItems: MAX_ASYNC_PER_CALL,
          description: "Several independent questions posted at once, answered in any order.",
          items: {
            type: "object",
            properties: { question: { type: "string" }, choices: { type: "array", items: CHOICE_SCHEMA, minItems: 2, maxItems: MAX_CHOICES }, context: { type: "string" }, key: { type: "string" } },
            required: ["question", "choices"],
          },
        },
      },
    },
    async execute(args, api, context) {
      const items = Array.isArray(args.questions) && args.questions.length > 0 ? args.questions.slice(0, MAX_ASYNC_PER_CALL) : args.question ? [args] : [];
      if (items.length === 0) return { ...text("async_choice: give question and choices, or questions"), isError: true };
      // The Cacophony identity this session's tools run with goes with each question (its bridge
      // files the question as a decision).
      const env = api.env?.env ?? {};
      const identity = env.CACO_AGENT_ID && env.CACO_PROJECT ? { agentId: String(env.CACO_AGENT_ID), project: String(env.CACO_PROJECT) } : undefined;
      try {
        const posted = await api.commit(async (tx) => {
          const doc = await tx.doc(ASYNC_DOC);
          if (pending(doc).length + items.length > MAX_ASYNC_PENDING) throw new Error(`at most ${MAX_ASYNC_PENDING} async questions may wait at once`);
          const created = [];
          for (const item of items) created.push({ ...(await askOne(tx, api.conversationId, item, identity)) });
          return { created, pendingCount: pending(doc).length };
        }, context);
        const lines = posted.created.map((record) => `- ${record.id}${record.key ? ` [key=${record.key}]` : ""}: ${record.question}`);
        return text(
          `Posted ${posted.created.length} async question${posted.created.length === 1 ? "" : "s"} (${posted.pendingCount} pending). Continue working; each answer arrives as a steering message.\n${lines.join("\n")}`,
          { status: "posted", ids: posted.created.map((record) => record.id), pendingCount: posted.pendingCount },
        );
      } catch (error) {
        return { ...text(`async_choice failed: ${error.message}`), isError: true };
      }
    },
  };

  const status = {
    name: "async_choice_status",
    description: "Report the status and any answers of async_choice questions by ID or key, or of all of this session's. Non-blocking.",
    parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, pendingOnly: { type: "boolean" } } },
    async execute(args, api, context) {
      const found = await api.commit(async (tx) => {
        const doc = await tx.doc(ASYNC_DOC);
        return JSON.parse(JSON.stringify(lookup(doc, args.ids).filter((record) => !(args.pendingOnly && record.status !== "pending"))));
      }, context);
      return text(found.length === 0 ? "No async questions." : found.map(line).join("\n"), { questions: found });
    },
  };

  const cancel = {
    name: "async_choice_cancel",
    description: "Withdraw pending async_choice questions that are no longer needed (by ID or key, or all). They leave the user's clients; no answer will arrive.",
    parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } }, all: { type: "boolean" }, reason: { type: "string" } } },
    async execute(args, api, context) {
      if (!args.all && !(Array.isArray(args.ids) && args.ids.length > 0)) return { ...text("async_choice_cancel: pass ids or all=true"), isError: true };
      const withdrawn = await api.commit(async (tx) => {
        const doc = await tx.doc(ASYNC_DOC);
        const targets = (args.all ? pending(doc) : lookup(doc, args.ids)).filter((record) => record.status === "pending");
        for (const record of targets) {
          record.status = "cancelled";
          record.settledAt = now();
          if (args.reason) record.reason = clip(args.reason, 500);
          // The question settles too: it leaves the clients, and its task ends without an answer.
          const question = await tx.doc(INPUT_DOC, Number(record.id));
          if (question.status === "pending") question.status = "cancelled";
        }
        return targets.map((record) => record.id);
      }, context);
      return text(withdrawn.length === 0 ? "No pending async questions to withdraw." : `Withdrew ${withdrawn.length}: ${withdrawn.join(", ")}`, { withdrawn });
    },
  };

  return [interactive, post, status, cancel];
}
