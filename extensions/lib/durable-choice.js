// Choices for pi-daemon sessions (bd-ac1906): agent-utils' interactive_choice and async_choice as
// a Durable profile module, on pi-daemon's questions. A question is pi-daemon's question document
// (`pi-daemon.input`, task scope) on the task that asks it:
// - interactive_choice records it on its own tool call and waits (blocking, as ask_user);
// - async_choice gives each question a background task of its own, marked blocking: false, and
//   returns at once; the task waits for the answer and steers the conversation with it.
// Clients see both through pi-daemon (pi-client's question and /choices, AHP input requests),
// and the answers survive restarts. async_choice_status and async_choice_cancel read and settle
// the session's record of async questions. Plain objects only: no pi-durable import.
//
// Cacophony: each async question is also filed as an operator decision (`caco decision`), as the
// TUI's async choices are, from its task in the worker, so it needs no client open. `caco` runs
// through the session's execution environment, with the session's Cacophony identity (a managed
// agent's, or a visiting registration's overrides). The first answer wins, from either side.
import { createCacophonyChoiceBridge } from "./cacophony-choice.js";
import { createCacophonyDecisionBridge } from "./cacophony-decision.js";

/** pi-daemon's question document (src/input.ts): any task may carry one. */
export const INPUT_DOC = {
  // checkpointWhen as pi-daemon's own (pi-durable 1.4 requires one; earlier versions ignore it).
  definition: { kind: "pi-daemon.input", version: 1, scope: "task", initial: () => ({ status: "pending", question: "" }), checkpointWhen: () => false },
};

/** The session's async questions, for status and cancel (tools cannot inspect tasks). */
export const ASYNC_DOC = {
  // checkpointWhen: pi-durable 1.4 requires a base policy (earlier versions ignore it); changes stay deltas.
  definition: { kind: "agent-utils.async-choices", version: 1, scope: "session", initial: () => ({ records: {} }), checkpointWhen: () => false },
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

/** Node's `execFile`, through a Durable execution environment: the command runs with the session's environment. */
export function execFileVia(execEnv, context) {
  return (command, args, options, callback) => {
    let stdout = "";
    let stderr = "";
    const onOutput = (text, _context, info) => {
      if (info?.stream === "stderr") stderr += text;
      else stdout += text;
    };
    void Promise.resolve(execEnv.exec([command, ...args], { timeout: options?.timeout ?? 30_000, onOutput }, context)).then(
      (result) => {
        if (!result?.ok) return callback(new Error(String(result?.error?.message ?? result?.error ?? "exec failed")), stdout, stderr);
        if (result.value.exitCode !== 0) return callback(Object.assign(new Error(stderr.trim() || `${command} exited ${result.value.exitCode}`), { code: result.value.exitCode }), stdout, stderr);
        callback(null, stdout, stderr);
      },
      (error) => callback(error, stdout, stderr),
    );
  };
}

/**
 * The session's Cacophony identity as its tools see it (and the caco its environment names, if
 * any); undefined without one, or with Cacophony off for the session.
 */
export async function sessionIdentity(execEnv, context) {
  const script = 'printf "%s\\n%s\\n%s\\n%s\\n%s" "${CACO_AGENT_ID:-${CACOPHONY_AGENT_ID:-}}" "${CACO_PROJECT:-${CACOPHONY_PROJECT:-}}" "${DISABLE_PI_CACO:-}" "${PI_INCOGNITO:-}" "${CACO_BIN:-}"';
  const output = await new Promise((resolve) => execFileVia(execEnv, context)("sh", ["-c", script], { timeout: 10_000 }, (error, stdout) => resolve(error ? "" : stdout)));
  const [agentId = "", project = "", disabled = "", incognito = "", bin = ""] = String(output).split("\n");
  if (!agentId.trim() || !project.trim() || /^(1|true|yes|on)$/i.test(disabled.trim()) || /^(1|true|yes|on)$/i.test(incognito.trim())) return undefined;
  return { agentId: agentId.trim(), project: project.trim(), ...(bin.trim() ? { bin: bin.trim() } : {}) };
}

/** The bridge's environment: the session's identity and caco, and only the choice settings of the worker's. */
function bridgeEnv(identity) {
  const tuning = Object.fromEntries(Object.entries(process.env).filter(([name]) => /^PI_(ASYNC_)?CHOICE_/.test(name)));
  return { ...tuning, CACO_AGENT_ID: identity.agentId, CACO_PROJECT: identity.project, ...(identity.bin ? { CACO_BIN: identity.bin } : {}) };
}

/**
 * Mirror an async question to Cacophony's decision queue from its task: file it (or re-attach
 * after a restart), and settle the question with a Cacophony answer. Undefined without a
 * Cacophony identity.
 */
async function mirrorToCacophony(runtime, task, context) {
  const execEnv = await Promise.resolve(runtime.env?.(context)).catch(() => undefined);
  if (execEnv === undefined) return undefined;
  const identity = await sessionIdentity(execEnv, context);
  if (identity === undefined) return undefined;
  // The session's caco (its PATH, or its CACO_BIN): never the worker's, which may name another.
  const bridge = createCacophonyDecisionBridge({ env: bridgeEnv(identity), execFileImpl: execFileVia(execEnv, context) });
  const choices = task.input.choices.map((choice, index) => ({ index, label: choice.label, headline: choice.shown, ...(choice.summary ? { summary: choice.summary } : {}) }));
  // A Cacophony answer settles the question; the task goes on as with any answer.
  const onResolution = (outcome) =>
    void runtime
      .commit(async (tx) => {
        const doc = await tx.doc(INPUT_DOC, runtime.taskId);
        if (doc.status !== "pending") return undefined;
        if (outcome.status === "selected" && task.input.choices[outcome.index]) Object.assign(doc, { status: "answered", answer: task.input.choices[outcome.index].shown });
        else if (outcome.status === "freeform") Object.assign(doc, { status: "answered", answer: String(outcome.text) });
        else doc.status = "cancelled";
        return undefined;
      }, context)
      .catch(() => undefined);
  const known = await runtime.memo?.("cacophonyDecision", context).catch?.(() => undefined);
  const started = known
    ? bridge.attach({ decisionId: known, choices, onResolution })
    : bridge.start({
        asyncId: String(runtime.taskId),
        question: task.input.question,
        context: task.input.context ?? "",
        choices,
        onDecisionId: (id) => void runtime.memo?.("cacophonyDecision", id, context)?.catch?.(() => undefined),
        onResolution,
      });
  if (!started) {
    bridge.dispose();
    return undefined;
  }
  return {
    // A local answer resolves the Cacophony decision too; after a Cacophony answer the bridge has
    // already stopped, and this does nothing.
    settle: (result) => Promise.resolve(started.settleLocal(result)).catch(() => undefined),
    dispose: () => bridge.dispose(),
  };
}

/**
 * Mirror an interactive choice to Cacophony's choices surface from its tool call, through the
 * call's execution environment; a Cacophony answer settles the question. Undefined without a
 * Cacophony identity. (After a restart mid-question a new Cacophony choice is filed.)
 */
async function mirrorChoice(api, choices, question, context) {
  const execEnv = api.env;
  if (execEnv === undefined) return undefined;
  const identity = await sessionIdentity(execEnv, context);
  if (identity === undefined) return undefined;
  const bridge = createCacophonyChoiceBridge({ env: bridgeEnv(identity), execFileImpl: execFileVia(execEnv, context) });
  return bridge.start({
    question,
    choices: choices.map((choice, index) => ({ index, label: choice.label, headline: choice.shown, ...(choice.summary ? { summary: choice.summary } : {}) })),
    onResolution: (outcome) =>
      void api
        .commit(async (tx) => {
          const doc = await tx.doc(INPUT_DOC, api.taskId);
          if (doc.status !== "pending") return undefined;
          if (outcome.status === "selected" && choices[outcome.index]) Object.assign(doc, { status: "answered", answer: choices[outcome.index].shown });
          else if (outcome.status === "freeform") Object.assign(doc, { status: "answered", answer: String(outcome.text) });
          else doc.status = "cancelled";
          return undefined;
        }, context)
        .catch(() => undefined),
  }) ?? undefined;
}

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
          const mirror = await mirrorToCacophony(runtime, task, context).catch(() => undefined);
          let settled;
          try {
            settled = await waitForAnswer(runtime, (change) => runtime.commit(change, context), runtime.taskId, context, { signal: runtime.signal });
          } catch (error) {
            mirror?.dispose();
            throw error;
          }
          const result = choiceResult(choices, settled);
          if (mirror) {
            // Settle the Cacophony decision to match (bounded): resolved with the answer, or discarded.
            await Promise.race([mirror.settle(result.status === "timeout" ? { status: "cancelled" } : result), new Promise((resolve) => setTimeout(resolve, 15_000))]);
            mirror.dispose();
          }
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

// `output` for pi-durable 1.2 and later (it renamed `content`), `content` for earlier hosts.
const text = (value, details) => {
  const output = [{ type: "text", text: value }];
  return { output, content: output, ...(details === undefined ? {} : { details }) };
};

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
      if (recorded.status !== "pending") {
        const result = choiceResult(choices, recorded);
        return text(resultText(result), result);
      }
      // Cacophony's choices surface mirrors it (from the worker: no client needed); first answer wins.
      const mirror = await mirrorChoice(api, choices, args.question, context).catch(() => undefined);
      let settled;
      try {
        settled = await waitForAnswer(api, (change) => api.commit(change, context), api.taskId, context, { timeoutMs: Number(args.timeoutMs) || 0, signal: context?.abortSignal });
      } finally {
        if (mirror && settled === undefined) mirror.stop({ discard: true });
      }
      const result = choiceResult(choices, settled);
      if (mirror) {
        await Promise.race([Promise.resolve(mirror.settleLocal(result.status === "timeout" ? { status: "cancelled" } : result)).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 15_000))]);
        mirror.stop();
      }
      return text(resultText(result), result);
    },
  };

  const askOne = async (tx, conversationId, item) => {
    const choices = normalizeChoices(item.choices);
    const question = clip(item.question, MAX_TEXT);
    if (!question) throw new Error("a question needs text");
    const key = item.key ? clip(item.key, 120) : undefined;
    // Task-scoped documents are addressed by the task's (numeric) id; the records keep it as text.
    const background = clip(item.context, MAX_TEXT);
    const taskId = await tx.createTask(asyncTask, { question, choices, ...(key ? { key } : {}), ...(background ? { context: background } : {}) }, { ownership: { kind: "conversation" }, conversationId, background: true });
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
      try {
        const posted = await api.commit(async (tx) => {
          const doc = await tx.doc(ASYNC_DOC);
          if (pending(doc).length + items.length > MAX_ASYNC_PENDING) throw new Error(`at most ${MAX_ASYNC_PENDING} async questions may wait at once`);
          const created = [];
          for (const item of items) created.push({ ...(await askOne(tx, api.conversationId, item)) });
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
