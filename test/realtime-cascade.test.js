import test from "node:test";
import assert from "node:assert/strict";

import { buildParticipantRoster, MODE_CASCADE, ORDER_FIXED } from "../extensions/lib/realtime-participants.js";
import {
  DEFAULT_HUMAN_LABEL,
  defaultCascadeSystem,
  buildCascadeTurnMessages,
  runCascadeRound,
} from "../extensions/lib/realtime-cascade.js";

// ---------------------------------------------------------------------------
// defaultCascadeSystem
// ---------------------------------------------------------------------------

test("defaultCascadeSystem names the participant and the other room members", () => {
  const roster = [{ name: "Harry-bot" }, { name: "Var" }, { name: "Cedar" }];
  const s = defaultCascadeSystem(roster[1], roster);
  assert.match(s, /You are Var,/);
  assert.match(s, /group chat with Harry-bot, Cedar/);
  assert.match(s, /spoken aloud/);
});

test("defaultCascadeSystem handles a lone participant (no others)", () => {
  const s = defaultCascadeSystem({ name: "Solo" }, [{ name: "Solo" }]);
  assert.match(s, /You are Solo,/);
  assert.doesNotMatch(s, /group chat with/);
});

// ---------------------------------------------------------------------------
// buildCascadeTurnMessages
// ---------------------------------------------------------------------------

test("buildCascadeTurnMessages labels the human and other speakers as user, self as assistant", () => {
  const roster = [{ name: "Var" }, { name: "Cedar" }];
  const conversation = [
    { speaker: "Human", text: "what's the weather like?" },
    { speaker: "Var", text: "sunny here" },
  ];
  const msgs = buildCascadeTurnMessages({ participant: roster[1], conversation, roster });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /You are Cedar,/);
  assert.deepEqual(msgs[1], { role: "user", content: "Human: what's the weather like?" });
  assert.deepEqual(msgs[2], { role: "user", content: "Var: sunny here" });
});

test("buildCascadeTurnMessages renders the participant's own prior turns as assistant", () => {
  const roster = [{ name: "Var" }, { name: "Cedar" }];
  const conversation = [
    { speaker: "Human", text: "hi all" },
    { speaker: "Cedar", text: "hello Human" },
    { speaker: "Var", text: "hey Cedar" },
  ];
  const msgs = buildCascadeTurnMessages({ participant: roster[1], conversation, roster });
  // Cedar's own line is assistant; Human + Var are labelled user
  assert.deepEqual(msgs.slice(1), [
    { role: "user", content: "Human: hi all" },
    { role: "assistant", content: "hello Human" },
    { role: "user", content: "Var: hey Cedar" },
  ]);
});

test("buildCascadeTurnMessages appends participant instructions and an optional systemPrefix, and skips empty entries", () => {
  const participant = { name: "Var", instructions: "Be witty." };
  const msgs = buildCascadeTurnMessages({
    participant,
    roster: [participant],
    conversation: [{ speaker: "Human", text: "" }, { speaker: "Human", text: "go" }],
    systemPrefix: "SYSTEM-PREFIX.",
  });
  assert.match(msgs[0].content, /^SYSTEM-PREFIX\. /);
  assert.match(msgs[0].content, /Be witty\.$/);
  // empty human entry skipped; only the "go" survives
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[1], { role: "user", content: "Human: go" });
});

// ---------------------------------------------------------------------------
// runCascadeRound
// ---------------------------------------------------------------------------

function cascadeRoster() {
  // main + 2 peers, fixed order for determinism
  return buildParticipantRoster({ mode: MODE_CASCADE, participants: "var,cedar", main: { name: "main" }, env: {} }).participants;
}

test("runCascadeRound runs one turn per participant in order and accumulates the conversation", async () => {
  const roster = cascadeRoster();
  const seen = [];
  const spoken = [];
  const replies = { main: "main reply", var: "var reply", cedar: "cedar reply" };
  const res = await runCascadeRound({
    participants: roster,
    humanText: "hello everyone",
    order: ORDER_FIXED,
    runTurn: (p, messages) => { seen.push({ name: p.name, messages }); return replies[p.id]; },
    speak: (p, text) => { spoken.push({ name: p.name, text }); },
  });
  assert.deepEqual(res.order, [0, 1, 2]);
  assert.deepEqual(res.turns.map((t) => t.name), ["main", "var", "cedar"]);
  assert.deepEqual(res.turns.map((t) => t.text), ["main reply", "var reply", "cedar reply"]);
  // conversation = human + 3 replies
  assert.deepEqual(res.conversation.map((c) => c.text), [
    "hello everyone", "main reply", "var reply", "cedar reply",
  ]);
  // speak called once per participant with the reply
  assert.deepEqual(spoken, [
    { name: "main", text: "main reply" },
    { name: "var", text: "var reply" },
    { name: "cedar", text: "cedar reply" },
  ]);
});

test("runCascadeRound makes each agent hear the human and everyone who already spoke", async () => {
  const roster = cascadeRoster();
  const seen = {};
  await runCascadeRound({
    participants: roster,
    humanText: "kick off",
    order: ORDER_FIXED,
    runTurn: (p, messages) => { seen[p.name] = messages; return `${p.name} says hi`; },
  });
  // the FIRST speaker (main) hears only the human
  const mainUser = seen.main.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(mainUser, ["Human: kick off"]);
  // the SECOND speaker (var) hears the human + main's reply (speaker-labelled)
  const varUser = seen.var.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(varUser, ["Human: kick off", "main: main says hi"]);
  // the THIRD speaker (cedar) hears the human + main + var
  const cedarUser = seen.cedar.filter((m) => m.role === "user").map((m) => m.content);
  assert.deepEqual(cedarUser, ["Human: kick off", "main: main says hi", "var: var says hi"]);
});

test("runCascadeRound skips speaking and recording an empty reply", async () => {
  const roster = cascadeRoster();
  const spoken = [];
  const res = await runCascadeRound({
    participants: roster,
    humanText: "hi",
    order: ORDER_FIXED,
    runTurn: (p) => (p.id === "var" ? "   " : `${p.name} ok`),
    speak: (p, text) => spoken.push({ name: p.name, text }),
  });
  // var produced empty -> not spoken, not in conversation
  assert.deepEqual(spoken.map((s) => s.name), ["main", "cedar"]);
  assert.ok(!res.conversation.some((c) => c.speaker === "var"));
  // cedar (after the empty var) heard human + main only
  assert.equal(res.turns.find((t) => t.name === "var").text, "");
});

test("runCascadeRound carries a prior conversation across rounds", async () => {
  const roster = cascadeRoster();
  const prior = [{ speaker: "Human", text: "round one" }, { speaker: "main", text: "earlier reply" }];
  const seen = {};
  const res = await runCascadeRound({
    participants: roster,
    humanText: "round two",
    order: ORDER_FIXED,
    conversation: prior,
    runTurn: (p, messages) => { seen[p.name] = messages; return `${p.name} r2`; },
  });
  // main sees its earlier reply as assistant, plus both human turns
  const mainRoles = seen.main.slice(1).map((m) => `${m.role}:${m.content}`);
  assert.deepEqual(mainRoles, ["user:Human: round one", "assistant:earlier reply", "user:Human: round two"]);
  assert.equal(res.conversation[0].text, "round one");
});

test("runCascadeRound throws without a runTurn dep", async () => {
  await assert.rejects(runCascadeRound({ participants: cascadeRoster(), humanText: "x" }), /requires a runTurn/);
});

test("DEFAULT_HUMAN_LABEL is used when no humanLabel is given", async () => {
  assert.equal(DEFAULT_HUMAN_LABEL, "Human");
});

import { sanitizeForSpeech } from "../extensions/lib/realtime-cascade.js";

test("sanitizeForSpeech strips markdown emphasis, code, links, and collapses whitespace", () => {
  assert.equal(sanitizeForSpeech("Hello **Var** and *Cedar*"), "Hello Var and Cedar");
  assert.equal(sanitizeForSpeech("run `npm test` now"), "run npm test now");
  assert.equal(sanitizeForSpeech("```\ncode block\n```done"), "done");
  assert.equal(sanitizeForSpeech("see [the docs](https://example.com/x) please"), "see the docs please");
  assert.equal(sanitizeForSpeech("bare https://example.com/y link"), "bare link");
  assert.equal(sanitizeForSpeech("a\n\n  b   c"), "a b c");
});

test("sanitizeForSpeech strips headings, list markers, and emoji", () => {
  assert.equal(sanitizeForSpeech("# Title\n- one\n- two"), "Title one two");
  assert.equal(sanitizeForSpeech("1. first\n2. second"), "first second");
  assert.equal(sanitizeForSpeech("Hi there 👋 great ✅"), "Hi there great");
  assert.equal(sanitizeForSpeech("> quoted line"), "quoted line");
});

test("sanitizeForSpeech leaves clean prose untouched and handles empties", () => {
  assert.equal(sanitizeForSpeech("Hi Main and Cedar, I'm Var."), "Hi Main and Cedar, I'm Var.");
  assert.equal(sanitizeForSpeech(""), "");
  assert.equal(sanitizeForSpeech(null), "");
});

import { formatCascadeTranscript } from "../extensions/lib/realtime-cascade.js";

test("formatCascadeTranscript renders the last N entries as compact name: text lines", () => {
  const entries = [
    { name: "you", text: "hello everyone" },
    { name: "main", text: "Hi var and cedar" },
    { name: "var", text: "Hey  main\nand cedar" },
  ];
  assert.deepEqual(formatCascadeTranscript(entries), [
    "  you: hello everyone",
    "  main: Hi var and cedar",
    "  var: Hey main and cedar",
  ]);
});

test("formatCascadeTranscript caps to max entries and truncates long text", () => {
  const entries = Array.from({ length: 10 }, (_, i) => ({ name: `p${i}`, text: `line ${i}` }));
  const lines = formatCascadeTranscript(entries, { max: 3 });
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "  p7: line 7");
  const long = formatCascadeTranscript([{ name: "x", text: "a".repeat(100) }], { width: 10 });
  assert.equal(long[0].length, "  x: ".length + 10);
  assert.ok(long[0].endsWith("…"));
});

test("formatCascadeTranscript handles empties", () => {
  assert.deepEqual(formatCascadeTranscript([]), []);
  assert.deepEqual(formatCascadeTranscript(null), []);
});

// --- Pipelined mode (concurrent synth, ordered play) -----------------------

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("pipelined runCascadeRound plays in turn order and returns the same result as sequential", async () => {
  const roster = buildParticipantRoster({ mode: MODE_CASCADE, participants: "var,cedar", main: { name: "main" }, env: {} }).participants;
  const playOrder = [];
  const res = await runCascadeRound({
    participants: roster,
    humanText: "go",
    order: ORDER_FIXED,
    runTurn: (p) => Promise.resolve(`${p.name} hi`),
    synth: (p, text) => Buffer.from(`${p.name}:${text}`),
    play: (p, pcm) => { playOrder.push({ name: p.name, pcm: pcm.toString() }); },
  });
  assert.deepEqual(res.turns.map((t) => t.name), ["main", "var", "cedar"]);
  assert.deepEqual(playOrder.map((p) => p.name), ["main", "var", "cedar"]);
  assert.equal(playOrder[1].pcm, "var:var hi");
  assert.deepEqual(res.conversation.map((c) => c.text), ["go", "main hi", "var hi", "cedar hi"]);
});

test("pipelined synthesis is kicked off concurrently while playback waits in order", async () => {
  const roster = buildParticipantRoster({ mode: MODE_CASCADE, participants: "var,cedar", main: { name: "main" }, env: {} }).participants;
  const synthCalls = [];
  const playOrder = [];
  const gate = deferred();
  const round = runCascadeRound({
    participants: roster,
    humanText: "go",
    order: ORDER_FIXED,
    runTurn: (p) => Promise.resolve(`${p.name} hi`),
    synth: (p) => { synthCalls.push(p.name); return Buffer.from(p.name); },
    play: async (p) => { playOrder.push(p.name); if (p.name === "main") await gate.promise; },
  });
  // let the (sequential-LLM) loop run + synths kick off; play0 enters then blocks on the gate
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(synthCalls, ["main", "var", "cedar"], "all synths kicked off while play0 is blocked");
  assert.deepEqual(playOrder, ["main"], "only the first play has started (ordered)");
  gate.resolve();
  await round;
  assert.deepEqual(playOrder, ["main", "var", "cedar"], "remaining plays ran in order");
});

test("pipelined mode fires onSpeak at play time and onTurn at text time", async () => {
  const roster = buildParticipantRoster({ mode: MODE_CASCADE, n: 2, main: { name: "main" }, env: {} }).participants;
  const turnEvents = [];
  const speakEvents = [];
  await runCascadeRound({
    participants: roster,
    humanText: "go",
    order: ORDER_FIXED,
    runTurn: (p) => `${p.name} hi`,
    synth: (p) => Buffer.from(p.name),
    play: () => {},
    onTurn: ({ participant }) => turnEvents.push(participant.name),
    onSpeak: ({ participant }) => speakEvents.push(participant.name),
  });
  assert.deepEqual(turnEvents, ["main", roster[1].name]);
  assert.deepEqual(speakEvents, ["main", roster[1].name]);
});

test("pipelined mode surfaces a synth/play error", async () => {
  const roster = buildParticipantRoster({ mode: MODE_CASCADE, participants: "var", main: { name: "main" }, env: {} }).participants;
  await assert.rejects(
    runCascadeRound({
      participants: roster,
      humanText: "go",
      order: ORDER_FIXED,
      runTurn: (p) => `${p.name} hi`,
      synth: (p) => { if (p.name === "var") throw new Error("synth boom"); return Buffer.from(p.name); },
      play: () => {},
    }),
    /synth boom/,
  );
});
