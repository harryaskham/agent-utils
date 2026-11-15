// A Durable watch listener's argument under Pi 1.4 and under Pi 1.5 (pi-daemon bd-80b027): the
// modules that follow a document read its value through watchedValue, so they run on either.
import test from "node:test";
import assert from "node:assert/strict";

import { INPUT_DOC, ASYNC_DOC, createAsyncChoiceTask, normalizeChoices } from "../extensions/lib/durable-choice.js";
import { watchedValue } from "../extensions/lib/durable-watch.js";

test("watchedValue reads Pi 1.4's value argument and Pi 1.5's call object", () => {
  const doc = { status: "answered", answer: "yes" };
  assert.equal(watchedValue(doc), doc, "Pi 1.4: the value itself");
  assert.equal(watchedValue({ kind: "value", value: doc, ops: [["s", ["status"], "answered"]], retired: false }), doc, "Pi 1.5: the call's value");
  assert.equal(watchedValue({ kind: "value", value: doc, ops: [], retired: true }), null, "a retired document reads as null, as before 1.5");
  assert.equal(watchedValue(null), null);
  assert.equal(watchedValue(undefined), undefined);
  // A document that happens to have fields named like a call's is still a document.
  const lookalike = { kind: "value", value: 1 };
  assert.equal(watchedValue(lookalike), lookalike);
});

for (const [host, argument] of [
  ["Pi 1.4", (value) => value],
  ["Pi 1.5", (value) => ({ kind: "value", value, ops: [["s", ["status"], value.status]], retired: false })],
]) {
  test(`a question answered while its task waits settles under ${host}`, async () => {
    const docs = new Map();
    const tx = {
      async doc(token, owner) {
        const key = `${token.definition.kind}:${owner ?? "session"}`;
        if (!docs.has(key)) docs.set(key, token.definition.initial());
        return docs.get(key);
      },
    };
    (await tx.doc(ASYNC_DOC)).records["12"] = { id: "12", status: "pending", question: "Ship it?" };
    const question = await tx.doc(INPUT_DOC, 12);
    Object.assign(question, { question: "Ship it?", choices: ["yes", "no"], blocking: false });
    let listener;
    const submitted = [];
    const runtime = {
      taskId: 12,
      conversationId: 1,
      signal: new AbortController().signal,
      // The question is still pending when the task starts watching it.
      watchDoc: async () => ({ value: { ...question }, start: (fn) => (listener = fn), stop: async () => undefined }),
      conversation: async () => ({ submit: async (submission) => submitted.push(submission) }),
      commit: async (change) => change(tx),
    };
    const task = createAsyncChoiceTask({ batchMs: 0 });
    const waiting = task.definition.phases.wait({ input: { question: "Ship it?", key: "ship", choices: normalizeChoices([{ label: "yes" }, { label: "no" }]) } }, runtime, {});
    while (listener === undefined) await new Promise((resolve) => setTimeout(resolve, 1));
    // The client answers: the host calls the listener in its own way.
    Object.assign(question, { status: "answered", answer: "yes" });
    await listener(argument({ ...question }), {});
    await waiting;
    assert.deepEqual(submitted.map((submission) => submission.content), ['[async_choice answer] ship: "Ship it?" → yes (id 12)']);
  });
}
