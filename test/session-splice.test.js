// /splice (phase 1): core transforms, sources, the TUI extension and the pi-daemon module.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SPLICE_CUSTOM_TYPE,
  buildSplice,
  describeTurns,
  parseSpliceArgs,
  parseTurnsRange,
  renderTurnsText,
  resolveRange,
  segmentTurns,
  selectTurns,
  summaryRequest,
  transformVerbatim,
} from "../extensions/lib/session-splice.js";
import {
  listDaemonSessions,
  loadSource,
  matchSession,
  messagesOfEntries,
  parseSourceRef,
  readDaemonTranscript,
  readPiSessionFile,
  resolveDaemonHost,
} from "../extensions/lib/session-splice-sources.js";
import sessionSpliceExtension, { expandSplices, spliceContent } from "../extensions/session-splice.js";
import { createSpliceCommand, spliceEntry } from "../extensions/durable/splice.mjs";

const NOW = new Date("2026-11-09T12:00:00Z");
const user = (text, timestamp = 1) => ({ role: "user", content: [{ type: "text", text }], timestamp });
const assistant = (content, extra = {}) => ({ role: "assistant", content, api: "openai-responses", provider: "github-copilot", model: "gpt-6", usage: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, totalTokens: 18 }, stopReason: "stop", timestamp: 2, ...extra });
const call = (id, name = "bash", args = { command: "ls" }) => ({ type: "toolCall", id, name, arguments: args });
const result = (id, text, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }], isError: false, details: { big: "x".repeat(100) }, timestamp: 3, ...extra });

function sample() {
  return [
    user("first question"),
    assistant([{ type: "thinking", thinking: "private", thinkingSignature: "sig" }, { type: "text", text: "Looking.", textSignature: "item_1" }, call("call_a|fc_1")], { stopReason: "toolUse" }),
    result("call_a|fc_1", "file.txt"),
    assistant([{ type: "text", text: "Found file.txt." }]),
    user("second question"),
    assistant([{ type: "text", text: "Answer two." }]),
    user("third question"),
    assistant([call("orphan")], { stopReason: "toolUse" }),
  ];
}
const source = { host: "aurora", sessionId: "chord-1", title: "demo", cwd: "/work" };

test("parseSpliceArgs: defaults, actions, ranges, method-dependent defaults and errors", () => {
  assert.deepEqual(parseSpliceArgs("aurora/demo"), { action: "splice", src: "aurora/demo", range: { last: 1 }, method: "text", as: "one", tools: "collapse", thinking: "drop", guard: true, max: 80_000 });
  const verbatim = parseSpliceArgs("src=demo method=verbatim turns=2..");
  assert.equal(verbatim.as, "turns");
  assert.equal(verbatim.tools, "keep");
  assert.deepEqual(verbatim.range, { from: 2, to: -1 });
  assert.deepEqual(parseSpliceArgs("show demo").action, "show");
  assert.deepEqual(parseSpliceArgs("list host=helsinki"), { action: "list", host: "helsinki", range: { last: 1 }, method: "text", as: "one", tools: "collapse", thinking: "drop", guard: true, max: 80_000 });
  assert.deepEqual(parseSpliceArgs("demo from=-3").range, { from: -3, to: -1 });
  assert.equal(parseSpliceArgs('demo method=summary focus="the build failure"').focus, "the build failure");
  assert.equal(parseSpliceArgs("demo guard=off max=0").guard, false);
  assert.deepEqual(parseTurnsRange("7"), { from: 7, to: 7 });
  assert.deepEqual(parseTurnsRange("..4"), { from: 1, to: 4 });
  assert.deepEqual(parseTurnsRange("all"), { from: 1, to: -1 });
  for (const [args, message] of [
    ["demo as=turns", /as=turns needs method=verbatim/],
    ["demo method=verbatim as=one", /method=text tools=keep/],
    ["demo last=2 turns=1..2", /last= cannot be combined/],
    ["demo turns=1..2 from=1", /turns= cannot be combined/],
    ["demo method=poem", /method must be/],
    ["demo nope=1", /unknown argument nope=/],
    ["demo other", /unexpected arguments/],
    ["demo src=x", /source once/],
    ["demo last=0", /at least 1/],
    ["demo turns=a..b", /turns must look like/],
  ]) assert.throws(() => parseSpliceArgs(args), message, args);
});

test("segmentTurns numbers user-led turns; resolveRange and describeTurns", () => {
  const turns = segmentTurns([assistant([{ type: "text", text: "summary first" }]), ...sample()]);
  assert.deepEqual(turns.map((turn) => turn.index), [0, 1, 2, 3]);
  assert.equal(turns[1].prompt, "first question");
  assert.equal(turns[1].tools, 1);
  assert.deepEqual(resolveRange({ last: 2 }, 3), { from: 2, to: 3 });
  assert.deepEqual(resolveRange({ last: 9 }, 3), { from: 1, to: 3 });
  assert.deepEqual(resolveRange({ from: -2, to: -1 }, 3), { from: 2, to: 3 });
  assert.throws(() => resolveRange({ from: 3, to: 2 }, 3), /not within 1..3/);
  assert.throws(() => resolveRange({ last: 1 }, 0), /no turns/);
  assert.deepEqual(selectTurns(turns, { from: 2, to: 3 }).map((turn) => turn.index), [2, 3]);
  assert.match(describeTurns(turns), /^ {3}1 .*first question/m);
  assert.doesNotMatch(describeTurns(turns), /summary first/);
});

test("renderTurnsText: thinking dropped by default, tools collapsed, kept or dropped", () => {
  const turns = segmentTurns(sample()).slice(0, 1);
  const text = renderTurnsText(turns);
  assert.match(text, /\*\*User \(turn 1\):\*\*\nfirst question/);
  assert.match(text, /→ `bash` \{"command":"ls"\}\n← `bash`: file.txt/);
  assert.doesNotMatch(text, /private/);
  assert.match(renderTurnsText(turns, { thinking: "keep" }), /\(thinking\) private/);
  assert.doesNotMatch(renderTurnsText(turns, { tools: "drop" }), /bash/);
});

test("transformVerbatim renames tool IDs, drops orphans, signatures, thinking and usage", () => {
  const out = transformVerbatim(segmentTurns(sample()), { idPrefix: "sp" });
  const [firstAssistant, firstResult] = [out[1], out[2]];
  assert.deepEqual(firstAssistant.content, [{ type: "text", text: "Looking." }, { type: "toolCall", id: "sp-1", name: "bash", arguments: { command: "ls" } }]);
  assert.equal(firstAssistant.stopReason, "toolUse");
  assert.equal(firstAssistant.usage.totalTokens, 0, "copies never count as this session's spending");
  assert.equal(firstAssistant.provider, "github-copilot");
  assert.deepEqual(firstResult, { role: "toolResult", toolCallId: "sp-1", toolName: "bash", content: [{ type: "text", text: "file.txt" }], isError: false, timestamp: 3 });
  // The orphaned call becomes text and the turn stops cleanly.
  const last = out.at(-1);
  assert.equal(last.stopReason, "stop");
  assert.match(last.content[0].text, /no result in the spliced range/);
  assert.equal(JSON.stringify(out).includes("fc_1"), false, "no provider item IDs survive");
  assert.equal(JSON.stringify(out).includes("textSignature"), false);
  assert.deepEqual(transformVerbatim(segmentTurns(sample()), { thinking: "keep" })[1].content[0], { type: "thinking", thinking: "private" });
});

test("transformVerbatim with tools collapsed or dropped merges a turn's assistant messages", () => {
  const collapsed = transformVerbatim(segmentTurns(sample()).slice(0, 1), { tools: "collapse" });
  assert.deepEqual(collapsed.map((message) => message.role), ["user", "assistant"]);
  assert.match(collapsed[1].content.map((block) => block.text).join("\n"), /Looking\.\n→ `bash`.*\n← `bash`: file.txt\nFound file.txt\./s);
  const dropped = transformVerbatim(segmentTurns(sample()).slice(0, 1), { tools: "drop" });
  assert.deepEqual(dropped[1].content, [{ type: "text", text: "Looking." }, { type: "text", text: "Found file.txt." }]);
});

test("transformVerbatim replaces images given by reference", () => {
  const out = transformVerbatim(segmentTurns([{ role: "user", content: [{ type: "image", uri: "x", mimeType: "image/png" }, { type: "image", data: "AA==", mimeType: "image/png" }] }]));
  assert.deepEqual(out[0].content, [{ type: "text", text: "[image omitted]" }, { type: "image", data: "AA==", mimeType: "image/png" }]);
});

test("buildSplice: one guarded message, verbatim turns with markers, summary, guard=off and the size cap", () => {
  const turns = segmentTurns(sample());
  const text = buildSplice({ source, turns: turns.slice(0, 2), range: { from: 1, to: 2 }, turnCount: 3, options: parseSpliceArgs("demo turns=1..2"), now: NOW });
  assert.equal(text.messages.length, 1);
  const body = text.messages[0].content[0].text;
  assert.match(body, /^<spliced-context source="aurora\/chord-1" title="demo" cwd="\/work" turns="1..2 of 3" method="text" spliced="2026-11-09T12:00:00.000Z">/);
  assert.match(body, /not a new request/);
  assert.match(body, /<\/spliced-context>$/);
  assert.equal(text.label, "aurora · demo · turns 1..2 of 3 · text");
  assert.deepEqual(text.provenance, { host: "aurora", session: "chord-1", title: "demo", cwd: "/work", turns: "1..2", of: 3, method: "text", as: "one", tools: "collapse", thinking: "drop", at: "2026-11-09T12:00:00.000Z" });

  const verbatim = buildSplice({ source, turns: turns.slice(0, 1), range: { from: 1, to: 1 }, turnCount: 3, options: parseSpliceArgs("demo method=verbatim turns=1"), now: NOW });
  assert.deepEqual(verbatim.messages.map((message) => message.role), ["user", "user", "assistant", "toolResult", "assistant", "user"]);
  assert.match(verbatim.messages[0].content[0].text, /The 4 messages that follow are copied verbatim/);
  assert.match(verbatim.messages.at(-1).content[0].text, /^<\/spliced-context>/);
  const bare = buildSplice({ source, turns: turns.slice(0, 1), range: { from: 1, to: 1 }, turnCount: 3, options: parseSpliceArgs("demo method=verbatim guard=off"), now: NOW });
  assert.equal(bare.messages.length, 4);

  const summary = buildSplice({ source, turns, range: { from: 1, to: 3 }, turnCount: 3, options: parseSpliceArgs("demo method=summary"), summaryText: " - decided X ", now: NOW });
  assert.match(summary.messages[0].content[0].text, /method="summary".*\n\n- decided X\n<\/spliced-context>/s);
  assert.throws(() => buildSplice({ source, turns, range: { from: 1, to: 3 }, turnCount: 3, options: parseSpliceArgs("demo method=summary"), summaryText: "" }), /summary is empty/);
  assert.throws(() => buildSplice({ source, turns, range: { from: 1, to: 3 }, turnCount: 3, options: parseSpliceArgs("demo max=50") }), /over max=50/);
});

test("summaryRequest asks for a focused summary of the rendered excerpt", () => {
  const request = summaryRequest(segmentTurns(sample()).slice(0, 1), { focus: "files" });
  assert.match(request.systemPrompt, /summarise excerpts of coding-agent sessions/);
  assert.match(request.messages[0].content[0].text, /Focus on: files\n\n<excerpt>\n\*\*User \(turn 1\)/);
});

test("sources: references, hosts, session matching and Durable entries", () => {
  assert.deepEqual(parseSourceRef("helsinki/abc"), { kind: "daemon", host: "helsinki", ref: "abc" });
  assert.deepEqual(parseSourceRef("abc"), { kind: "daemon", host: "", ref: "abc" });
  assert.deepEqual(parseSourceRef("pi:0199"), { kind: "pi", ref: "0199" });
  assert.deepEqual(parseSourceRef("~/s/x.jsonl"), { kind: "file", path: "~/s/x.jsonl" });
  assert.throws(() => parseSourceRef(""), /no source session/);
  const settings = { hosts: [{ name: "helsinki", url: "ws://helsinki:7463" }], tokenFile: "~/t" };
  const env = { PI_DAEMON_NODE: "aurora", PI_DAEMON_URL: "http://127.0.0.1:7463" };
  assert.deepEqual(resolveDaemonHost("", { settings, env }), { name: "aurora", url: "http://127.0.0.1:7463", tokenFile: "~/t", local: true });
  assert.deepEqual(resolveDaemonHost("aurora", { settings, env }).local, true);
  assert.deepEqual(resolveDaemonHost("helsinki", { settings, env }), { name: "helsinki", url: "ws://helsinki:7463", tokenFile: "~/t", local: false });
  assert.throws(() => resolveDaemonHost("nope", { settings, env }), /unknown host nope; settings.json client.hosts has helsinki/);
  const sessions = [{ id: "chord-aa1", title: "Alpha" }, { id: "chord-bb2", name: "beta", title: "Beta work" }, { id: "chord-bb3", title: "Beta two" }];
  assert.equal(matchSession(sessions, "beta").id, "chord-bb2");
  assert.equal(matchSession(sessions, "chord-aa").id, "chord-aa1");
  assert.equal(matchSession(sessions, "alpha").id, "chord-aa1");
  assert.throws(() => matchSession(sessions, "Beta "), /2 sessions match Beta/);
  assert.throws(() => matchSession(sessions, "zeta"), /no session matches zeta/);
  assert.deepEqual(messagesOfEntries([
    { kind: "pi.system", model: [{ role: "system" }] },
    { kind: "pi.user", model: [user("q")] },
    { kind: "pi.compaction", model: [user("summary")] },
    { kind: "pi.assistant", model: [assistant([{ type: "text", text: "a" }])] },
    { kind: "custom.thing", model: [user("no")] },
  ]).map((message) => message.role), ["user", "assistant"]);
});

test("readDaemonTranscript pages conversation.history back, oldest first; listDaemonSessions sorts", async () => {
  const calls = [];
  const pages = {
    undefined: { entries: [{ kind: "pi.user", model: [user("new")] }], before: 5 },
    5: { entries: [{ kind: "pi.user", model: [user("old")] }, { kind: "pi.assistant", model: [assistant([{ type: "text", text: "old answer" }])] }] },
  };
  const client = {
    async call(method, params) {
      calls.push([method, params]);
      if (method === "sessions.list") return { items: [{ id: "s1", title: "one", activeAt: 1 }, { id: "s2", title: "two", activeAt: 5 }] };
      return pages[params.before];
    },
  };
  const messages = await readDaemonTranscript(client, "s1", { conversation: 2 });
  assert.deepEqual(messages.map((message) => message.content[0].text), ["old", "old answer", "new"]);
  assert.deepEqual(calls.map(([, params]) => params), [{ sessionId: "s1", turns: 64, conversationId: 2 }, { sessionId: "s1", turns: 64, conversationId: 2, before: 5 }]);
  assert.deepEqual((await listDaemonSessions(client)).map((session) => session.id), ["s2", "s1"]);
});

test("readPiSessionFile follows the branch that ends at the last entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "splice-pi-"));
  try {
    const path = join(dir, "s.jsonl");
    const lines = [
      { type: "session", version: 3, id: "sess-1", cwd: "/w" },
      { type: "session_info", id: "i", parentId: null, name: "named" },
      { type: "message", id: "a", parentId: "i", message: user("root") },
      { type: "message", id: "b", parentId: "a", message: assistant([{ type: "text", text: "abandoned" }]) },
      { type: "message", id: "c", parentId: "a", message: assistant([{ type: "text", text: "kept" }]) },
      { type: "message", id: "d", parentId: "c", message: { role: "bashExecution", command: "ls", output: "x", timestamp: 4 } },
      { type: "custom_message", id: "e", parentId: "d", customType: "note", content: "ignored" },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`);
    const file = readPiSessionFile(path);
    assert.equal(file.id, "sess-1");
    assert.equal(file.name, "named");
    assert.equal(file.cwd, "/w");
    assert.deepEqual(file.messages.map((message) => message.content[0].text), ["root", "kept", "[ran `ls`]\nx"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSource reads TUI Pi sessions by pi: id prefix from the agent directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "splice-agent-"));
  try {
    mkdirSync(join(dir, "sessions", "--w--"), { recursive: true });
    writeFileSync(join(dir, "sessions", "--w--", "x.jsonl"), [
      JSON.stringify({ type: "session", id: "0199abc", cwd: "/w/proj" }),
      JSON.stringify({ type: "message", id: "a", parentId: null, message: user("hello") }),
    ].join("\n"));
    const loaded = await loadSource("pi:0199", { env: { PI_DAEMON_NODE: "aurora" }, agentDir: dir, settings: { hosts: [] } });
    assert.deepEqual({ ...loaded, messages: loaded.messages.length }, { host: "aurora·pi", sessionId: "0199abc", title: "proj", cwd: "/w/proj", messages: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeTui() {
  const commands = new Map();
  const handlers = new Map();
  const sent = [];
  const notes = [];
  const pi = {
    registerCommand: (name, command) => commands.set(name, command),
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message, options) => sent.push({ message, options }),
  };
  const ctx = { hasUI: false, ui: { notify: (text, level) => notes.push({ text, level }) } };
  return { pi, commands, handlers, sent, notes, ctx };
}

test("TUI /splice stores a guarded custom message and verbatim turns expand in context", async () => {
  const { pi, commands, handlers, sent, notes, ctx } = fakeTui();
  sessionSpliceExtension(pi, { loadSource: async () => ({ ...source, messages: sample() }), listSources: async () => ({ host: "aurora", sources: [], errors: [] }), env: {} });
  await commands.get("splice").handler("demo last=2", ctx);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, SPLICE_CUSTOM_TYPE);
  assert.deepEqual(sent[0].options, { triggerTurn: false });
  assert.match(sent[0].message.content, /^<spliced-context .*turns="2..3 of 3"/);
  assert.equal(sent[0].message.details.messages, undefined);
  assert.match(notes.at(-1).text, /^Spliced aurora · demo · turns 2..3 of 3 · text: 1 message/);

  await commands.get("splice").handler("demo turns=1 method=verbatim", ctx);
  const stored = sent[1].message;
  assert.equal(stored.details.messages.length, 6);
  assert.match(stored.content, /The 4 messages that follow are copied verbatim[\s\S]*→ `bash`[\s\S]*<\/spliced-context>/);
  const context = [user("mine"), { role: "custom", customType: SPLICE_CUSTOM_TYPE, content: stored.content, details: stored.details }, { role: "custom", customType: "other", content: "x" }];
  const expanded = handlers.get("context")({ messages: context });
  assert.deepEqual(expanded.messages.map((message) => message.role), ["user", "user", "user", "assistant", "toolResult", "assistant", "user", "custom"]);
  assert.equal(handlers.get("context")({ messages: [user("only")] }), undefined);
  assert.equal(expandSplices([{ role: "custom", customType: SPLICE_CUSTOM_TYPE, content: "t", details: {} }]), undefined);
  assert.match(spliceContent({ messages: [user("a")] }, { method: "text", guard: true }), /^a$/);
});

test("TUI /splice reports bad arguments, show, list, and needs a source without a UI", async () => {
  const { pi, commands, sent, notes, ctx } = fakeTui();
  sessionSpliceExtension(pi, {
    loadSource: async () => ({ ...source, messages: sample() }),
    listSources: async () => ({ host: "aurora", sources: [{ src: "aurora/chord-1", label: "aurora · demo" }], errors: [] }),
    env: {},
  });
  const handler = commands.get("splice").handler;
  await handler("demo method=poem", ctx);
  assert.match(notes.at(-1).text, /method must be/);
  await handler("show demo", ctx);
  assert.match(notes.at(-1).text, /aurora\/chord-1 \(demo\): 3 turns\n.*first question/);
  await handler("list", ctx);
  assert.match(notes.at(-1).text, /Sessions on aurora:\naurora\/chord-1\n {4}aurora · demo/);
  await handler("", ctx);
  assert.match(notes.at(-1).text, /give a source session/);
  await handler("demo turns=9", ctx);
  assert.match(notes.at(-1).text, /not within 1..3/);
  assert.equal(sent.length, 0);
  assert.deepEqual(commands.get("splice").getArgumentCompletions("demo meth").map((item) => item.value), ["demo method=text", "demo method=summary", "demo method=verbatim"]);
});

test("TUI /splice interactive: pick source, turns and method, confirm, then insert; summary uses the model", async () => {
  const { pi, commands, sent, ctx } = fakeTui();
  const answers = ["aurora · demo", "2 · second question", "3 · third question", "summary: one model-written summary"];
  const asked = [];
  ctx.hasUI = true;
  ctx.ui.select = async (title, options) => { asked.push([title, options]); return answers.shift(); };
  ctx.ui.input = async () => "decisions";
  ctx.ui.confirm = async () => true;
  let request;
  sessionSpliceExtension(pi, {
    loadSource: async () => ({ ...source, messages: sample() }),
    listSources: async () => ({ host: "aurora", sources: [{ src: "aurora/chord-1", label: "aurora · demo" }], errors: [] }),
    hosts: () => [],
    summarize: async (_ctx, req) => { request = req; return "the summary"; },
    env: {},
  });
  await commands.get("splice").handler("", ctx);
  assert.deepEqual(asked.map(([title]) => title), ["Splice from which session?", "From which turn?", "To which turn?", "Splice as"]);
  assert.deepEqual(asked[2][1], ["2 · second question", "3 · third question"]);
  assert.match(request.messages[0].content[0].text, /Focus on: decisions/);
  assert.match(sent[0].message.content, /turns="2..3 of 3" method="summary"[\s\S]*the summary/);
});

test("pi-daemon /splice writes pi-daemon entries with provenance through the conversation", async () => {
  const submitted = [];
  const notes = [];
  const conversation = {
    async submit(draft) {
      submitted.push(draft);
      return { status: async () => ({ status: submitted.length === 1 ? "done" : "queued" }) };
    },
    async agent() { return { model: { provider: "p", modelId: "m" } }; },
  };
  const ctx = { conversationId: 1, context: {}, harness: { conversation: async () => conversation }, notify: (text) => notes.push(text) };
  const command = createSpliceCommand({ load: async () => ({ ...source, messages: sample() }), list: async () => ({ host: "aurora", sources: [], errors: [] }), env: {} });
  await command.run("demo turns=1 method=verbatim", ctx);
  assert.deepEqual(submitted.map((draft) => draft.entry.kind), ["pi.user", "pi.user", "pi.assistant", "pi.tool-result", "pi.assistant", "pi.user"]);
  assert.ok(submitted.every((draft) => draft.type === "write" && draft.requestId.startsWith("agent-utils.splice:aurora/chord-1:1..1:")));
  assert.deepEqual(new Set(submitted.map((draft) => draft.requestId)).size, 6);
  assert.equal(submitted[3].entry.data.diagnostics.length, 0);
  assert.equal(submitted[2].entry.data.splice.session, "chord-1");
  assert.match(notes.at(-1), /^Spliced aurora · demo · turns 1..1 of 3 · verbatim: 6 message\(s\).* They land when the current turn ends\./);

  submitted.length = 0;
  const summarized = createSpliceCommand({ load: async () => ({ ...source, messages: sample() }), summarize: async (_ctx, conv, request) => { assert.equal(conv, conversation); assert.match(request.systemPrompt, /summarise/); return "short"; }, env: {} });
  await summarized.run("demo method=summary", ctx);
  assert.deepEqual(submitted.map((draft) => draft.entry.kind), ["pi.user"]);
  assert.match(submitted[0].entry.model[0].content[0].text, /method="summary"[\s\S]*short/);
});

test("pi-daemon /splice lists sources without a source and explains a missing harness", async () => {
  const notes = [];
  const command = createSpliceCommand({ load: async () => ({ ...source, messages: sample() }), list: async () => ({ host: "aurora", sources: [{ src: "aurora/chord-1", label: "aurora · demo" }], errors: ["ms-dev: down"] }), env: {} });
  await command.run("", { notify: (text) => notes.push(text) });
  assert.match(notes.at(-1), /give a source session[\s\S]*Sessions on aurora:\naurora\/chord-1\n {4}aurora · demo\nms-dev: down/);
  await command.run("demo", { notify: (text) => notes.push(text) });
  assert.match(notes.at(-1), /needs a pi-daemon that gives module commands its harness/);
  await command.run("demo turns=x", { notify: (text) => notes.push(text) });
  assert.match(notes.at(-1), /turns must look like/);
  assert.deepEqual(spliceEntry(user("x"), { a: 1 }), { kind: "pi.user", model: [user("x")], data: { splice: { a: 1 } } });
});
