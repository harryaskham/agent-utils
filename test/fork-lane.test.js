// Fork lanes (bd-fd98a3): /clone and /git wt fork take focus= and mode=work|qa; the fork gets a
// fixed role note, the original a notice, the fork's chip shows the lane, and a qa fork refuses
// edits (TUI Pi: Pi's tool_call hook; pi-daemon: a session made without edit and write).
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  LANE_ENTRY,
  LANE_NOTICE_ENTRY,
  LANE_STATE_KEY,
  forkRoleNote,
  laneFromEntries,
  laneSummary,
  normalizeLane,
  originalNotice,
  qaBashRefusal,
  qaToolNames,
  qaToolRefusal,
  quoteWord,
  splitWords,
  takeLane,
} from "../extensions/lib/fork-lane.js";
import { CLONE_LANE_COMMAND, cloneArgsOf, cloneName, createForkLaneExtension, parseCloneArgs } from "../extensions/lib/fork-lane-extension.js";
import { SESSION_FORK_META, SESSION_PROFILE_META, applyLaneThere, createForkSession, forkSessionFor } from "../extensions/lib/fork-session.js";
import { createGitCommands, createGitRefresher } from "../extensions/lib/durable-git.js";
import gitClient from "../extensions/durable/git-client.js";
import { buildEditorChipRails, resolveEditorChipsConfig, stripAnsi } from "../extensions/lib/editor-chips.js";

const exec = promisify(execFile);

test("focus= and mode= are taken from a command's words, quotes kept together", () => {
  assert.deepEqual(splitWords(`wt fork x focus="harbour-qs Q&A" mode=qa`), ["wt", "fork", "x", "focus=harbour-qs Q&A", "mode=qa"]);
  assert.deepEqual(splitWords(`  a 'b c'  "" d`), ["a", "b c", "", "d"]);
  assert.deepEqual(takeLane(["x", "focus=harbour-qs Q&A", "mode=qa"]), { words: ["x"], lane: { mode: "qa", focus: "harbour-qs Q&A" } });
  assert.deepEqual(takeLane(["x", "focus=review"]), { words: ["x"], lane: { mode: "work", focus: "review" } }, "a focus alone is a work lane");
  assert.deepEqual(takeLane(["mode=QA"]), { words: [], lane: { mode: "qa" } });
  assert.deepEqual(takeLane(["x", "--rebase=main"]), { words: ["x", "--rebase=main"] }, "no lane: the words as they were");
  assert.match(takeLane(["mode=read"]).error, /mode= is work or qa/);
  assert.match(takeLane(["mode=qa", "mode=work"]).error, /given twice/);
  assert.match(takeLane(["focus="]).error, /focus= needs text/);
  assert.equal(takeLane([`focus=${"x".repeat(500)}`]).lane.focus.length, 200);
  assert.deepEqual(splitWords(`/git fork ${quoteWord("my name")} ${quoteWord('focus=a "b"')} ${quoteWord("plain")}`), ["/git", "fork", "my name", "focus=a 'b'", "plain"]);
  assert.deepEqual(normalizeLane({ mode: "qa", focus: " a\nb ", junk: 1, from: { title: "t", evil: 2 }, at: 5, shared: true }), { mode: "qa", focus: "a b", from: { title: "t" }, shared: true, at: 5 });
  assert.equal(normalizeLane({ mode: "edit" }), undefined);
  assert.equal(laneSummary({ mode: "qa", focus: "harbour-qs" }), "qa · harbour-qs");
  assert.equal(laneSummary({ mode: "work" }), "work");
});

test("the fork's role note and the original's notice are fixed texts with the lane in them", () => {
  const qa = normalizeLane({ mode: "qa", focus: "harbour-qs Q&A", from: { title: "investigation", cwd: "/w" }, cwd: "/w", shared: true, restricted: true });
  const note = forkRoleNote(qa);
  assert.match(note, /^\[Fork lane: mode=qa · focus: harbour-qs Q&A\]\n/);
  assert.match(note, /fork of the session "investigation"/);
  assert.match(note, /The original session carries on with its own task; do not continue that task here\./);
  assert.match(note, /Your lane: harbour-qs Q&A\./);
  assert.match(note, /read-only \(mode=qa\): do not edit, write, move or delete files/);
  assert.match(note, /You share the working directory \/w with the original session/);
  assert.match(note, /The edit and write tools are not available in this session\./);
  assert.match(forkRoleNote({ ...qa, restricted: undefined }), /Edits are refused in this session\./);
  assert.match(forkRoleNote({ mode: "qa" }), /Your lane: answer the user's questions\./);

  const work = normalizeLane({ mode: "work", from: { title: "inv", cwd: "/w" }, cwd: "/wt/x", branch: "x" });
  assert.match(forkRoleNote(work), /Your lane: what the user asks of you here, not the original's task\./);
  assert.match(forkRoleNote(work), /You may edit files \(mode=work\)\. You work in \/wt\/x on branch x; the original stays in \/w\./);
  assert.match(forkRoleNote({ mode: "work", focus: "docs", shared: true, cwd: "/w" }), /commit only your own\./);

  assert.equal(
    originalNotice(qa, { title: "harbour-qs" }),
    '[Forked: a copy of this conversation continues as session "harbour-qs" in this same directory, in its own lane: mode=qa (read-only, for questions) · focus: harbour-qs Q&A. The fork takes only that lane; carry on with your own task here.]',
  );
  assert.match(originalNotice(work, { title: "x", cwd: "/wt/x", host: "helsinki" }), /continues as session "x" in \/wt\/x on helsinki, in its own lane: mode=work \(it may edit\)\./);
  assert.match(originalNotice({ mode: "work", shared: true }, {}), /leave its lane's changes to it\.$/);
});

test("a qa fork refuses edit and write, and bash that plainly changes files or git state", () => {
  for (const command of ["cargo test", "git status && git log -3", "ls 2>/dev/null", "cmd 2>&1 | tee /tmp/x", "git stash list", "rm -rf /tmp/x", "mkdir -p /tmp/y", "grep -r foo . | head", "echo \"a > b\"", "git diff HEAD~1", "git branch -a", "cat <<EOF\n> not a redirect\nEOF", "python3 - <<'EOF'\nprint(1 > 0)\nEOF"]) {
    assert.equal(qaBashRefusal(command), undefined, command);
  }
  const refused = {
    "echo hi > out.txt": /writes to out.txt/,
    "cat > notes.md <<EOF\nx\nEOF": /writes to notes.md/,
    "printf x >> log": /writes to log/,
    "sed -i s/a/b/ f": /sed -i/,
    "perl -pi -e s/a/b/ f": /perl -i/,
    "git commit -m x": /git commit/,
    "git -C /x checkout main": /git checkout/,
    "git stash": /git stash/,
    "git branch -D old": /git branch/,
    "cd x && git push": /git push/,
    "rm foo": /rm changes files/,
    "FOO=1 mv a b": /mv changes files/,
    "echo x | tee README.md": /tee writes to README.md/,
    "sudo touch f": /touch changes files/,
  };
  for (const [command, why] of Object.entries(refused)) assert.match(qaBashRefusal(command) ?? "", why, command);
  const lane = { mode: "qa", from: { title: "inv" } };
  assert.match(qaToolRefusal("edit", {}, lane), /^Refused: edit edits files\. This is a qa fork.*the original session \(inv\)/);
  assert.match(qaToolRefusal("write", {}, lane), /^Refused: write/);
  assert.match(qaToolRefusal("bash", { command: "git commit -am x" }, lane), /^Refused: git commit/);
  assert.equal(qaToolRefusal("bash", { command: "rg foo" }, lane), undefined);
  assert.equal(qaToolRefusal("read", { path: "x" }, lane), undefined);

  const tool = (name) => ({ name });
  const agent = { extensions: [{ name: "builtin-tools", tools: ["read", "write", "edit", "bash"].map(tool) }, { name: "codemode", tools: [tool("codemode")] }, { name: "pi-git", tools: [tool("git_track")] }] };
  assert.deepEqual(qaToolNames(agent), ["read", "bash", "codemode"]);
  assert.deepEqual(qaToolNames({ extensions: [{ name: "builtin-tools", tools: [tool("read")] }] }), ["read"]);
  assert.equal(qaToolNames({}), undefined, "unknown: the profile's tools");

  const entries = [
    { type: "message" },
    { type: "custom_message", customType: LANE_ENTRY, details: { mode: "qa", focus: "a" } },
    { type: "custom_message", customType: LANE_NOTICE_ENTRY, details: { lane: { mode: "work" } } },
  ];
  assert.deepEqual(laneFromEntries(entries), { mode: "qa", focus: "a" }, "the original's notice is not a lane");
  assert.deepEqual(laneFromEntries([...entries, { type: "custom_message", customType: LANE_ENTRY, details: { mode: "work" } }]), { mode: "work" }, "the latest wins");
  assert.equal(laneFromEntries([]), undefined);
});

/** A TUI Pi for the extension: its handlers and commands, a session branch, and ctx.fork. */
function tuiPi({ branch = [], leafId = "leaf-1", file = "/s/original.jsonl", name = "investigation" } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const userMessages = [];
  const pi = { on: (type, handler) => handlers.set(type, handler), registerCommand: (command, options) => commands.set(command, options), sendUserMessage: (text, options) => userMessages.push({ text, options }) };
  const forks = [];
  const sent = [];
  const infos = [];
  const notes = [];
  const next = {
    sessionManager: { appendSessionInfo: (text) => infos.push(text), getSessionId: () => "fork-id", getSessionFile: () => "/s/fork.jsonl" },
    sendMessage: async (message, options) => sent.push({ message, options }),
    ui: { notify: (text, level) => notes.push({ text, level }) },
  };
  const ctx = {
    cwd: "/w",
    waitForIdle: async () => {},
    sessionManager: { getLeafId: () => leafId, getSessionFile: () => file, getSessionName: () => name, getBranch: () => branch },
    ui: { notify: (text, level) => notes.push({ text, level }) },
    fork: async (entryId, options) => {
      forks.push({ entryId, position: options.position });
      await options.withSession(next);
      return { cancelled: false };
    },
  };
  return { pi, handlers, commands, ctx, forks, sent, infos, notes, userMessages };
}

function fakeSessionManager() {
  const appended = [];
  return { appended, SessionManager: { open: (path) => ({ appendCustomMessageEntry: (...args) => appended.push({ path, args }) }) } };
}

test("TUI Pi: /clone with a lane duplicates the session, gives the fork its role note and the original a notice", async () => {
  const { appended, SessionManager } = fakeSessionManager();
  const t = tuiPi();
  createForkLaneExtension({ SessionManager })(t.pi);
  assert.equal(t.commands.has("clone"), false, "Pi's own name: a command named so is reported as a conflict at every start");
  // `/clone ARGS` reaches Pi's input event (its /clone takes none): handed to /clone-lane, as a command.
  assert.deepEqual(t.handlers.get("input")({ text: `/clone focus="harbour-qs Q&A" mode=qa`, source: "interactive" }), { action: "handled" });
  assert.equal(t.handlers.get("input")({ text: "/clone", source: "interactive" }), undefined, "/clone alone is Pi's");
  assert.equal(t.handlers.get("input")({ text: "/cloned x", source: "interactive" }), undefined);
  assert.equal(t.handlers.get("input")({ text: "/clone x", source: "extension" }), undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(t.userMessages, [{ text: `/clone-lane focus="harbour-qs Q&A" mode=qa`, options: { expandPromptTemplates: true } }]);
  assert.equal(cloneArgsOf("  /clone  a b "), "a b");
  const clone = t.commands.get(CLONE_LANE_COMMAND);
  await clone.handler(`focus="harbour-qs Q&A" mode=qa`, t.ctx);
  assert.deepEqual(t.forks, [{ entryId: "leaf-1", position: "at" }], "Pi's own clone: the active path through the leaf");
  assert.deepEqual(t.infos, ["harbour-qs Q&A"], "named by its focus");
  assert.equal(t.sent.length, 1);
  const { message, options } = t.sent[0];
  assert.equal(message.customType, LANE_ENTRY);
  assert.equal(message.display, true);
  assert.deepEqual(options, { triggerTurn: false }, "no turn: the user asks next");
  assert.deepEqual({ ...message.details, at: 0 }, { mode: "qa", focus: "harbour-qs Q&A", from: { title: "investigation", cwd: "/w" }, cwd: "/w", shared: true, at: 0 });
  assert.equal(message.content, forkRoleNote(message.details));
  assert.equal(appended.length, 1, "the original's file takes the notice once the fork exists");
  const [customType, text, display, details] = appended[0].args;
  assert.equal(appended[0].path, "/s/original.jsonl");
  assert.equal(customType, LANE_NOTICE_ENTRY);
  assert.equal(display, true);
  assert.match(text, /continues as session "harbour-qs Q&A" in this same directory, in its own lane: mode=qa/);
  assert.equal(details.fork.sessionId, "fork-id");
  assert.match(t.notes.at(-1).text, /^Cloned into harbour-qs Q&A · lane qa · harbour-qs Q&A \(edits refused\); the original has a notice of it$/);

  // A NAME alone: Pi's clone, named; no notes.
  const plain = tuiPi();
  const quiet = fakeSessionManager();
  createForkLaneExtension({ SessionManager: quiet.SessionManager })(plain.pi);
  await plain.commands.get(CLONE_LANE_COMMAND).handler("experiment", plain.ctx);
  assert.deepEqual(plain.infos, ["experiment"]);
  assert.deepEqual(plain.sent, []);
  assert.deepEqual(quiet.appended, []);

  // Errors before anything is forked.
  const bad = tuiPi();
  createForkLaneExtension({ SessionManager })(bad.pi);
  await bad.commands.get(CLONE_LANE_COMMAND).handler("mode=edit", bad.ctx);
  await bad.commands.get(CLONE_LANE_COMMAND).handler("@helsinki", bad.ctx);
  assert.deepEqual(bad.forks, []);
  assert.match(bad.notes[0].text, /mode= is work or qa/);
  assert.match(bad.notes[1].text, /\/session-fork --remote HOST/);
  const empty = tuiPi({ leafId: null });
  createForkLaneExtension({ SessionManager })(empty.pi);
  await empty.commands.get(CLONE_LANE_COMMAND).handler("mode=qa", empty.ctx);
  assert.deepEqual(empty.forks, []);
  assert.equal(empty.notes[0].text, "Nothing to clone yet");

  assert.deepEqual(parseCloneArgs("my fork focus=x"), { name: "my fork", lane: { mode: "work", focus: "x" } });
  assert.equal(cloneName({ name: "", lane: { mode: "qa" } }, "inv"), "inv (qa)");
  assert.equal(cloneName({ name: "", lane: undefined }, "inv"), undefined, "Pi's own name then");
});

test("TUI Pi: a qa lane on the branch refuses edits; a work lane and no lane refuse nothing", async () => {
  const branch = [];
  const t = tuiPi({ branch });
  createForkLaneExtension(fakeSessionManager())(t.pi);
  const call = (toolName, input) => t.handlers.get("tool_call")({ toolName, input }, t.ctx);
  assert.equal(call("edit", { path: "x" }), undefined, "no lane");
  branch.push({ type: "custom_message", customType: LANE_ENTRY, details: { mode: "qa", from: { title: "inv" } } });
  assert.equal(call("edit", { path: "x" }).block, true);
  assert.match(call("write", { path: "x" }).reason, /qa fork/);
  assert.equal(call("bash", { command: "git commit -am x" }).block, true);
  assert.equal(call("bash", { command: "rg needle" }), undefined);
  assert.equal(call("read", { path: "x" }), undefined);
  branch.push({ type: "custom_message", customType: LANE_ENTRY, details: { mode: "work" } });
  assert.equal(call("edit", { path: "x" }), undefined, "a later work lane lifts it");

  // pi-client's facade: its sessions are pi-daemon's, and its /clone is its own.
  const client = tuiPi();
  client.pi.registerSidebarSegment = () => {};
  createForkLaneExtension(fakeSessionManager())(client.pi);
  assert.equal(client.commands.size, 0);
  assert.equal(client.handlers.size, 0);
});

/** Fake /chord hosts by name, as git-fork-session.test.js's. */
function fakeHosts(byHost) {
  const calls = [];
  const connect = async (host) => ({
    async call(method, params, options) {
      calls.push({ host: host.name, method, params, ...(options ? { options } : {}) });
      const handler = byHost[host.name]?.[method];
      if (!handler) throw Object.assign(new Error(`method_not_found: ${method}`), { code: "method_not_found" });
      return handler(params, options);
    },
    close() {},
  });
  return { calls, connect };
}
const settings = { hosts: [{ name: "helsinki", url: "ws://helsinki:7463" }], tokenFile: "~/t" };
const env = { PI_DAEMON_NODE: "aurora", PI_DAEMON_URL: "http://127.0.0.1:7463" };
const gitCommands = { items: [{ name: "git", kind: "extension" }, { name: "clone", kind: "builtin" }] };

test("pi-daemon: a qa fork here is made without edit and write, and pi-git's /git lane apply runs in it", async () => {
  const lane = { mode: "qa", focus: "harbour-qs", from: { title: "inv", cwd: "/w" }, cwd: "/w", shared: true, at: 7 };
  const { calls, connect } = fakeHosts({
    aurora: {
      "host.info": () => ({ _meta: { [SESSION_FORK_META]: true, [SESSION_PROFILE_META]: { version: 1, config: ["env", "tools"] } } }),
      "sessions.create": (params) => ({ id: "chord-fork", cwd: params.cwd }),
      "session.commands": () => gitCommands,
      "conversation.submit": () => ({ command: "git", status: "done" }),
    },
  });
  const made = await createForkSession({ sessionId: "src", conversationId: 1, fromCwd: "/w", path: "/w", title: "harbour-qs", at: 7, lane, tools: ["read", "bash"] }, { env, settings, connect });
  assert.deepEqual(made, { id: "chord-fork", title: "harbour-qs", cwd: "/w", lane: { restricted: true, applied: "applied" } });
  assert.deepEqual(calls.find((call) => call.method === "sessions.create").params.tools, ["read", "bash"]);
  const submit = calls.find((call) => call.method === "conversation.submit");
  assert.equal(submit.params.sessionId, "chord-fork");
  assert.equal(submit.params.whenBusy, "reject");
  assert.equal(submit.params.wait, true);
  const [, json] = /^\/git lane apply (\{.*\})$/.exec(submit.params.content);
  assert.deepEqual(JSON.parse(json), { ...lane, restricted: true });

  // A host that takes no session tools: made with its profile's, and the note says edits are refused.
  const old = fakeHosts({
    aurora: {
      "host.info": () => ({ _meta: { [SESSION_FORK_META]: true } }),
      "sessions.create": (params) => ({ id: "chord-fork", cwd: params.cwd }),
      "session.commands": () => gitCommands,
      "conversation.submit": () => ({ command: "git" }),
    },
  });
  const older = await createForkSession({ sessionId: "src", path: "/w", title: "t", at: 7, lane, tools: ["read"] }, { env, settings, connect: old.connect });
  assert.deepEqual(older.lane, { restricted: false, applied: "applied" });
  assert.equal(old.calls.find((call) => call.method === "sessions.create").params.tools, undefined);

  // A session without pi-git: nothing is submitted (the text would be a prompt there).
  const bare = fakeHosts({ aurora: { "session.commands": () => ({ items: [{ name: "clone", kind: "builtin" }] }) } });
  const client = await bare.connect({ name: "aurora" });
  assert.equal(await applyLaneThere(client, "s", lane, { requestId: "r" }), "no-module");
  assert.equal(bare.calls.some((call) => call.method === "conversation.submit"), false);
});

test("pi-daemon: a qa fork on another node carries its role note in the import; tools that node lacks are left out", async () => {
  const imported = [];
  const lane = { mode: "qa", from: { title: "inv", cwd: "/w" }, cwd: "/h/wt/x", branch: "x", host: "helsinki", at: 9 };
  const { calls, connect } = fakeHosts({
    aurora: { "conversation.context": () => ({ messages: [{ role: "user", content: "one" }] }), "sessions.list": () => ({ items: [] }) },
    helsinki: {
      "profiles.list": () => ({ items: [] }),
      "sessions.create": (params) => {
        if (params.tools?.includes("codemode")) throw Object.assign(new Error('tools: "codemode" is not a built-in tool of profile cacophony'), { code: "invalid_argument" });
        return { id: "chord-there", cwd: "/h/wt/x" };
      },
      "conversation.import": (params) => (imported.push(params), null),
      "session.commands": () => gitCommands,
      "conversation.submit": () => ({ command: "git" }),
    },
  });
  const made = await createForkSession({ sessionId: "src", fromCwd: "/w", path: "/h/wt/x", title: "x", node: "helsinki", at: 9, lane, tools: ["read", "bash", "codemode"] }, { env, settings, connect });
  assert.deepEqual(made.lane, { restricted: true, applied: "applied" });
  assert.deepEqual(calls.filter((call) => call.method === "sessions.create").map((call) => call.params.tools), [["read", "bash", "codemode"], ["read", "bash"]]);
  const messages = imported[0].messages;
  assert.match(messages.at(-2).content[0].text, /^\[Copied from host aurora/);
  assert.equal(messages.at(-1).content[0].text, forkRoleNote({ ...lane, restricted: true }), "the role note ends the imported context");
  const submit = calls.find((call) => call.method === "conversation.submit");
  assert.equal(JSON.parse(/\{.*\}$/.exec(submit.params.content)[0]).noted, true, "the import carried the note: only the lane is kept there");

  // The module's call: a qa lane asks for this session's built-in tools less edit and write.
  const forks = [];
  const local = async () => ({
    call: async (method, params) => (method === "host.info" ? { _meta: { [SESSION_FORK_META]: true, [SESSION_PROFILE_META]: { config: ["tools"] } } } : method === "sessions.create" ? (forks.push(params), { id: "n" }) : method === "session.commands" ? gitCommands : { command: "git" }),
    close() {},
  });
  const agent = { extensions: [{ name: "builtin-tools", tools: ["read", "edit", "write", "bash"].map((name) => ({ name })) }] };
  const ctx = { sessionId: "s", conversationId: 1, cwd: "/w", harness: { conversation: async () => ({ agent: async () => agent }) }, env: { all: async () => ({}) } };
  const result = await forkSessionFor(ctx, { path: "/w", title: "q", at: 1, lane: { mode: "qa" } }, { settings: { hosts: [] }, connect: local, env: { PI_DAEMON_URL: "http://127.0.0.1:7999" } });
  assert.deepEqual(forks[0].tools, ["read", "bash"]);
  assert.deepEqual(result.lane, { restricted: true, applied: "applied" });
  await forkSessionFor(ctx, { path: "/w", title: "w", at: 2, lane: { mode: "work" } }, { settings: { hosts: [] }, connect: local, env: { PI_DAEMON_URL: "http://127.0.0.1:7999" } });
  assert.equal(forks[1].tools, undefined, "a work fork keeps its tools");
});

function memoryState() {
  const values = new Map();
  return { values, get: async (key) => values.get(key), set: async (key, value) => void (value === undefined ? values.delete(key) : values.set(key, value)) };
}

/** A module command's ctx whose conversation takes written entries (pi-daemon's harness). */
function commandCtx(cwd) {
  const writes = [];
  const notices = [];
  const ctx = {
    sessionId: "s",
    conversationId: 1,
    context: {},
    cwd,
    state: memoryState(),
    env: { get: async () => ({}) },
    getSessionMetadata: async () => ({ name: undefined, title: "investigation" }),
    notify: (text) => notices.push(text),
    harness: { conversation: async () => ({ submit: async (draft) => (writes.push(draft), { status: async () => ({ status: "done" }) }) }) },
  };
  return { ctx, writes, notices };
}

async function gitRepo(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-git-lane-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "project");
  const git = (...args) => exec("git", args, { cwd: root });
  await exec("git", ["init", "-q", "-b", "main", root]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await writeFile(join(root, "a.txt"), "a\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "first");
  return { dir, root };
}

test("/git wt fork NAME focus= mode=: the fork's session gets the lane, this conversation a notice written after the copy", async (t) => {
  const { dir, root } = await gitRepo(t);
  const asked = [];
  const forkSession = async (_ctx, fork) => (asked.push(fork), { id: "chord-made", title: fork.title, cwd: fork.path, lane: { restricted: true, applied: "applied" } });
  const { ctx, writes, notices } = commandCtx(root);
  const { git } = createGitCommands(createGitRefresher(), { root: join(dir, "worktrees"), forkSession });

  await git.run(`wt fork qs focus="harbour-qs Q&A" mode=qa`, ctx);
  const path = join(dir, "worktrees", "project", "qs");
  assert.equal(asked.length, 1);
  assert.deepEqual({ ...asked[0].lane, at: 0 }, { mode: "qa", focus: "harbour-qs Q&A", from: { sessionId: "s", title: "investigation", cwd: root }, cwd: path, branch: "qs", at: 0 });
  assert.equal(writes.length, 1, "one notice in this conversation, no turn");
  assert.equal(writes[0].type, "write");
  assert.equal(writes[0].entry.kind, "pi.user");
  assert.match(writes[0].entry.model[0].content[0].text, /^\[Forked: a copy of this conversation continues as session "qs" in .*\/qs, in its own lane: mode=qa \(read-only, for questions\) · focus: harbour-qs Q&A\./);
  assert.equal(writes[0].entry.data.piGit.forkNotice.session, "chord-made");
  assert.equal(ctx.state.values.get("forked").lane.mode, "qa");
  assert.match(notices.at(-1), /Session "qs" there has this conversation; every client lists it\. Lane qa · harbour-qs Q&A \(read-only, without edit and write tools\): it has its role note; this session has a notice of it\.$/);

  // No lane: as before, and nothing written here.
  await git.run("wt fork plain", ctx);
  assert.equal(asked[1].lane, undefined);
  assert.equal(writes.length, 1);
  assert.equal(ctx.state.values.get("forked").lane, undefined);

  // Refused before anything is made.
  await git.run("wt fork bad mode=edit", ctx);
  assert.match(notices.at(-1), /mode= is work or qa/);
  await git.run("wt fork bare mode=qa --no-session", ctx);
  assert.match(notices.at(-1), /drop --no-session/);
  await git.run("status mode=qa", ctx);
  assert.match(notices.at(-1), /focus= and mode= are for \/git wt fork NAME and \/git fork/);
  assert.equal(asked.length, 2);
});

test("/git fork: a session in this directory with a lane; /git lane apply in it, and /git lane", async (t) => {
  const { root } = await gitRepo(t);
  const asked = [];
  const forkSession = async (_ctx, fork) => (asked.push(fork), { id: "chord-here", title: fork.title, cwd: fork.path, lane: { restricted: true, applied: "applied" } });
  const { ctx, writes, notices } = commandCtx(root);
  const { git } = createGitCommands(createGitRefresher(), { forkSession });

  await git.run(`fork mode=qa focus="harbour-qs"`, ctx);
  assert.deepEqual([asked[0].path, asked[0].title, asked[0].lane.shared, asked[0].lane.cwd], [root, "harbour-qs", true, root]);
  assert.match(writes[0].entry.model[0].content[0].text, /continues as session "harbour-qs" in this same directory/);
  const forked = ctx.state.values.get("forked");
  assert.deepEqual([forked.path, forked.title, forked.here, forked.session.id], [root, "harbour-qs", true, "chord-here"]);
  assert.match(notices.at(-1), /^Session "harbour-qs" has this conversation, in this directory; every client lists it\. Lane qa · harbour-qs/);
  await git.run("fork", ctx);
  assert.equal(asked[1].title, "investigation (fork)");
  assert.equal(asked[1].lane, undefined);
  await git.run("fork @helsinki mode=qa", ctx);
  assert.match(notices.at(-1), /\/git wt fork NAME @node/);

  // In the fork: /git lane apply writes the role note and keeps the lane for the chips.
  const fork = commandCtx(root);
  const lane = { mode: "qa", focus: "harbour-qs", from: { title: "investigation", cwd: root }, cwd: root, shared: true, restricted: true, at: 3 };
  await git.run(`lane apply ${JSON.stringify(lane)}`, fork.ctx);
  assert.equal(fork.writes.length, 1);
  assert.equal(fork.writes[0].entry.model[0].content[0].text, forkRoleNote(lane));
  assert.deepEqual(fork.writes[0].entry.data.piGit.lane, lane);
  assert.deepEqual(fork.ctx.state.values.get(LANE_STATE_KEY), lane);
  assert.equal(fork.notices.at(-1), "Lane qa · harbour-qs (read-only).");
  await git.run("lane", fork.ctx);
  assert.equal(fork.notices.at(-1), "Lane qa · harbour-qs (read-only), forked from investigation.");
  // Carried by an import: the lane only.
  const carried = commandCtx(root);
  await git.run(`lane apply ${JSON.stringify({ ...lane, noted: true })}`, carried.ctx);
  assert.equal(carried.writes.length, 0);
  assert.equal(carried.ctx.state.values.get(LANE_STATE_KEY).mode, "qa");
  await git.run("lane apply {\"mode\":\"edit\"}", carried.ctx);
  assert.match(carried.notices.at(-1), /not a lane/);
  await git.run("lane", ctx);
  assert.match(notices.at(-1), /^This session has no fork lane/);
});

test("pi-client: the client part opens /git fork's session and says its lane; the sidebar's lane segment; /clone where pi-client lets it", async () => {
  const handlers = new Map();
  const commands = new Map();
  const segments = new Map();
  const watches = [];
  const opened = [];
  const created = [];
  const notices = [];
  const submitted = [];
  const ctx = {
    sessionManager: { getSessionId: () => "a" },
    chord: { async watchDocument(_address, onValue) { watches.push(onValue); return () => {}; }, call: async (method, params) => (submitted.push({ method, params }), { command: "git" }) },
    sessions: { create: async (options) => created.push(options), open: async (session) => opened.push(session), list: () => [{ id: "a", title: "investigation" }] },
    ui: { notify: (text) => notices.push(text), requestRender() {} },
  };
  gitClient({
    on: (type, handler) => handlers.set(type, handler),
    events: { on() {}, emit() {} },
    registerCommand: (name, options) => commands.set(name, options),
    registerSidebarSegment: (name, segment) => segments.set(name, segment),
    replaceableCommands: ["choices", "clone"],
  });
  await handlers.get("session_start")({}, ctx);
  await Promise.resolve();
  watches[0]({ values: { lane: { mode: "qa", focus: "harbour-qs" } } });
  assert.equal(segments.get("lane")({ id: "a" }), "⑂ qa");
  assert.equal(segments.get("lane")({ id: "b" }), undefined);
  handlers.get("input")({ text: "/git fork mode=qa" }, ctx);
  watches[0]({ values: { forked: { path: "/w", title: "harbour-qs", here: true, at: Date.now(), lane: { mode: "qa", focus: "harbour-qs" }, session: { id: "chord-here", title: "harbour-qs" } } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [{ id: "chord-here" }]);
  assert.equal(notices.at(-1), "Opened the fork harbour-qs · lane qa · harbour-qs (read-only); the original has a notice of it.");

  // /clone: with a lane, /git fork in this session; without, pi-client's own copy.
  await commands.get("clone").handler(`"qs buddy" focus="harbour-qs Q&A" mode=qa`, ctx);
  assert.equal(submitted.at(-1).method, "conversation.submit");
  assert.deepEqual(splitWords(submitted.at(-1).params.content), ["/git", "fork", "qs buddy", "mode=qa", "focus=harbour-qs Q&A"]);
  assert.equal(submitted.at(-1).params.wait, true);
  await commands.get("clone").handler("", ctx);
  await commands.get("clone").handler("@helsinki there", ctx);
  assert.deepEqual(created, [{ title: "investigation (clone)", carry: true, kind: "copy" }, { host: "helsinki", title: "there", carry: true, kind: "copy" }]);
  await commands.get("clone").handler("@helsinki mode=qa", ctx);
  assert.match(notices.at(-1), /\/git wt fork NAME @host/);

  // A pi-client that keeps /clone its own: none registered (it would only be refused).
  const older = new Map();
  gitClient({ on() {}, events: { on() {}, emit() {} }, registerCommand: (name, options) => older.set(name, options) });
  assert.deepEqual([...older.keys()], ["repo"]);
});

test("the lane chip: its mode (qa in the warning colour), then its focus, shed first when the row is full", () => {
  const config = resolveEditorChipsConfig({ editorChips: { enabled: true } }, {});
  assert.deepEqual(config.topLeft, ["working", "lane"]);
  const theme = { fg: (_token, text) => text, getFgAnsi: () => "" };
  const base = { provider: "github-copilot", model: "claude", effort: "high", directory: "~/w", contextPct: 10, contextMax: 200000, cost: 0 };
  const top = (width, lane) => stripAnsi(buildEditorChipRails({ width, config, values: { ...base, lane }, theme }).top);
  assert.match(top(160, { mode: "qa", focus: "harbour-qs Q&A" }), /⑂ qa▌harbour-qs Q&A/);
  assert.match(top(160, { mode: "work" }), /⑂ work /);
  assert.doesNotMatch(top(160, undefined), /⑂/);
  assert.match(top(160, { mode: "qa", focus: "x".repeat(60) }), /⑂ qa▌x{27}…/);
  const narrow = top(48, { mode: "qa", focus: "harbour-qs Q&A" });
  assert.match(narrow, /⑂ qa/);
  assert.doesNotMatch(narrow, /harbour/);
});
