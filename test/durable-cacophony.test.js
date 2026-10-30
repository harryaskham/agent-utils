// Cacophony visiting registration for pi-daemon sessions (extensions/durable/cacophony.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { MODULE, MODULE_STATE_DOC, createCacophonyModule, identitySection } from "../extensions/lib/durable-cacophony.js";

/**
 * A fake `caco agent register --json`, recording its calls. `--preview` answers with
 * `preview` ({ project, source }); a `--project` listed in `conflicts` is refused as caco
 * refuses a project the checkout's remotes do not match.
 */
function fakeCaco({ id = "visiting-abc", guidance = "Visiting agents coordinate through beads.", fail, preview = { project: "derived", source: "derived path name" }, conflicts = {}, olderCaco = false } = {}) {
  const calls = [];
  const cwds = [];
  const execFileImpl = (command, args, options, callback) => {
    calls.push([command, ...args]);
    cwds.push(options?.cwd);
    const project = args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined;
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => {
      if (fail) return callback(new Error("exit 1"), "", "caco: daemon unavailable\nmore");
      if (olderCaco && args.includes("--ahp-host")) {
        return callback(new Error("exit 1"), "", "Error: bd-4c8fdd: `caco agent register` is a state-mutating command and received unrecognised flag(s): --ahp-host. Refusing to proceed");
      }
      if (args.includes("--preview")) {
        return callback(null, JSON.stringify({ ok: true, preview: true, project: preview.project, project_source: preview.source, session_id: sessionId }), "");
      }
      if (conflicts[project]) {
        return callback(new Error("exit 1"), "", `error: visiting project '${project}' conflicts with caller checkout git remotes; matching configured projects: ${conflicts[project].join(", ")}. Pass --project with one of these candidates`);
      }
      callback(null, JSON.stringify({ data: { id: typeof id === "function" ? id(sessionId) : id, project, session_id: sessionId }, guidance: { text: guidance } }), "");
    });
  };
  return { calls, cwds, execFileImpl };
}

/** A module command / observer context: module state and the session's variables. */
function sessionContext(sessionId = "s1", vars = {}, cwd = "/work/project", sessionName) {
  const values = new Map();
  const env = { ...vars };
  const notices = [];
  return {
    notices,
    env,
    setSessionName(name) { sessionName = name; },
    ctx: {
      sessionId,
      getSessionName: async () => sessionName,
      ...(cwd === null ? {} : { cwd }),
      notify: (text) => notices.push(text),
      state: { get: async (key) => values.get(key), set: async (key, value) => void values.set(key, value) },
      env: {
        get: async () => ({ ...env }),
        set: async (changes) => {
          for (const [key, value] of Object.entries(changes)) value === null ? delete env[key] : (env[key] = value);
        },
      },
    },
  };
}

test("without the session's directory (an older pi-daemon) registration is refused, not run elsewhere", async () => {
  const caco = fakeCaco();
  const module = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl });
  const { ctx, notices } = sessionContext("pd-session-9", {}, null);
  await module.commands["caco-agent-register"].run("project=agent-utils", ctx);
  assert.deepEqual(caco.calls, []);
  assert.match(notices.at(-1), /registration failed: the session's directory is unknown/);
});

test("a session migrated from TUI Pi keeps its visiting agent's identity from its variables (bd-737651)", async () => {
  const caco = fakeCaco();
  const module = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl, now: () => 9 });
  const { ctx, notices } = sessionContext("pd-migrated", { CACO_AGENT_ID: "visiting-tui", CACO_PROJECT: "pi-daemon" });
  await module.observe({ type: "agent_start" }, { sessionId: ctx.sessionId, state: ctx.state, env: ctx.env, cwd: ctx.cwd });
  assert.deepEqual(caco.calls, [], "no registration: it already is the agent");
  assert.deepEqual(await ctx.state.get("identity"), { agentId: "visiting-tui", project: "pi-daemon", sessionId: "pd-migrated", registeredAt: 9, guidance: "", inherited: true });
  await module.commands["caco-runtime"].run("", ctx);
  assert.equal(notices.at(-1), "visiting visiting-tui in pi-daemon (carried over by /migrate)");
  // A managed agent's identity in the environment is not taken as a visitor's.
  const managed = sessionContext("pd-managed-2", { CACO_AGENT_ID: "cluster-ctrl", CACO_PROJECT: "cacophony" });
  await module.observe({ type: "agent_start" }, { sessionId: "pd-managed-2", state: managed.ctx.state, env: managed.ctx.env });
  assert.equal(await managed.ctx.state.get("identity"), undefined);
});

test("/caco-agent-register registers the session, keeps its identity and sets its variables", async () => {
  const caco = fakeCaco();
  const module = createCacophonyModule({ env: { CACO_BIN: "/opt/caco", HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl, now: () => 5 });
  const { ctx, notices, env } = sessionContext("pd-session-1");
  await module.commands["caco-agent-register"].run("project=agent-utils", ctx);
  // From the session's directory, which is the visitor's checkout (bd-8c8f5f).
  assert.deepEqual(caco.calls, [["/opt/caco", "agent", "register", "--project", "agent-utils", "--session-id", "pd-session-1", "--checkout-root", "/work/project", "--ahp-host", "pi-daemon", "--json"]]);
  assert.deepEqual(caco.cwds, ["/work/project"]);
  assert.equal(notices.at(-1), "Registered as Cacophony visiting agent visiting-abc in project agent-utils.");
  assert.deepEqual(env, { CACO_AGENT_ID: "visiting-abc", CACO_PROJECT: "agent-utils" });
  assert.deepEqual(await ctx.state.get("identity"), {
    agentId: "visiting-abc",
    project: "agent-utils",
    sessionId: "pd-session-1",
    ahpHost: "pi-daemon",
    registeredAt: 5,
    guidance: "Visiting agents coordinate through beads.",
  });
  await module.commands["caco-runtime"].run("", ctx);
  assert.match(notices.at(-1), /^visiting visiting-abc in agent-utils/);

  // Usage, no project, a failing caco, and the off switch.
  await module.commands["caco-agent-register"].run("agent-utils", ctx);
  assert.match(notices.at(-1), /^Usage:/);
  await module.commands["caco-agent-register"].run("", sessionContext().ctx);
  const other = sessionContext("s2");
  await module.commands["caco-agent-register"].run("", other.ctx);
  assert.match(other.notices.at(-1), /registration failed: no configured Cacophony project matches the git remotes of \/work\/project/,
    "a directory whose remotes match no project is never registered under its path name");
  const failing = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: fakeCaco({ fail: true }).execFileImpl });
  const failed = sessionContext("s3");
  await failing.commands["caco-agent-register"].run("project=p", failed.ctx);
  assert.equal(failed.notices.at(-1), "Cacophony visiting-agent registration failed: caco: daemon unavailable");
  assert.deepEqual(failed.env, {});
  const off = createCacophonyModule({ env: { DISABLE_PI_CACO: "1", HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl });
  const disabled = sessionContext("s4");
  await off.commands["caco-agent-register"].run("project=p", disabled.ctx);
  assert.match(disabled.notices.at(-1), /disabled/);
});

test("/caco-agent-register infers the project from the checkout, and replaces a refused one with the sole match", async () => {
  // No project named or configured: caco's preview names it from the checkout's remotes.
  const inferring = fakeCaco({ preview: { project: "android-utils", source: "cwd git remote" } });
  const module = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: inferring.execFileImpl });
  const session = sessionContext("pd-infer", {}, "/work/android-utils");
  await module.commands["caco-agent-register"].run("", session.ctx);
  assert.deepEqual(inferring.calls[0], ["caco", "agent", "register", "--preview", "--checkout-root", "/work/android-utils", "--session-id", "pd-infer", "--json"]);
  assert.deepEqual(inferring.calls[1].slice(0, 5), ["caco", "agent", "register", "--project", "android-utils"]);
  assert.equal(session.notices.at(-1), "Registered as Cacophony visiting agent visiting-abc in project android-utils (inferred from this checkout's git remotes).");
  assert.equal(session.env.CACO_PROJECT, "android-utils");

  // A named project the checkout cannot be: the only project its remotes match is used.
  const refusing = fakeCaco({ conflicts: { tools: ["android-utils"] } });
  const retrying = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: refusing.execFileImpl });
  const named = sessionContext("pd-conflict", {}, "/work/android-utils");
  await retrying.commands["caco-agent-register"].run("project=tools", named.ctx);
  assert.deepEqual(refusing.calls.map((call) => call[call.indexOf("--project") + 1]), ["tools", "android-utils"]);
  assert.equal(named.notices.at(-1), "Registered as Cacophony visiting agent visiting-abc in project android-utils (tools does not match this checkout's git remotes; android-utils is the only configured project they match).");

  // Several candidates stay a refusal naming them: the operator chooses.
  const ambiguous = fakeCaco({ conflicts: { tools: ["mono", "health"] } });
  const strict = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: ambiguous.execFileImpl });
  const several = sessionContext("pd-several", {}, "/work/mono");
  await strict.commands["caco-agent-register"].run("project=tools", several.ctx);
  assert.equal(ambiguous.calls.length, 1);
  assert.match(several.notices.at(-1), /registration failed: error: visiting project 'tools' conflicts .*mono, health/);
  assert.deepEqual(several.env, {});
});

test("manual registration reads live /name once and does not rename a visitor on retry or reload", async () => {
  const caco = fakeCaco();
  const options = { env: { HOME: "/nonexistent", PI_SESSION_NAME: "server-name" }, settings: {}, execFileImpl: caco.execFileImpl };
  const module = createCacophonyModule(options);
  const session = sessionContext("pd-named", {}, "/work/named", "Old name");
  session.setSessionName("  Parser / café; $(not-a-shell)  ");
  await Promise.all([
    module.commands["caco-agent-register"].run("project=p", session.ctx),
    module.commands["caco-agent-register"].run("project=p", session.ctx),
  ]);
  assert.deepEqual(caco.calls, [["caco", "agent", "register", "--project", "p", "--session-id", "pd-named", "--checkout-root", "/work/named", "--session-name", "Parser / café; $(not-a-shell)", "--ahp-host", "pi-daemon", "--json"]]);
  assert.deepEqual(caco.cwds, ["/work/named"]);
  const receipt = await session.ctx.state.get("identity");
  session.setSessionName("Renamed after registration");
  await module.commands["caco-agent-register"].run("project=p", session.ctx);
  // Even if environment overrides need restoring, the session's receipt wins.
  delete session.env.CACO_AGENT_ID;
  delete session.env.CACO_PROJECT;
  await createCacophonyModule(options).commands["caco-agent-register"].run("project=p", session.ctx);
  assert.equal(caco.calls.length, 1);
  assert.deepEqual(await session.ctx.state.get("identity"), receipt);
  assert.equal(session.env.CACO_AGENT_ID, receipt.agentId);
});

test("Durable unnamed and older hosts never borrow a display name from environment or IDs", async () => {
  for (const getSessionName of [undefined, async () => undefined, async () => "", async () => " \t ", async () => null, async () => 42, async () => { throw new Error("unavailable"); }]) {
    const caco = fakeCaco();
    const env = { HOME: "/nonexistent", PI_SESSION_NAME: "server name", PI_SESSION_TITLE: "server title", PI_SESSION_ID: "parent", PI_CACO_RUNTIME_AGENT_ID: "pd-external" };
    const module = createCacophonyModule({ env, settings: {}, execFileImpl: caco.execFileImpl });
    const { ctx } = sessionContext("37e41c34-558f-4bb5-b31c-e1bd4d3956c5", { PI_SESSION_NAME: "parent name" });
    ctx.getSessionName = getSessionName;
    ctx.title = "Not explicit name metadata";
    await module.commands["caco-agent-register"].run("project=p", ctx);
    assert.deepEqual(caco.calls, [["caco", "agent", "register", "--project", "p", "--session-id", ctx.sessionId, "--checkout-root", ctx.cwd, "--runtime-agent-id", "pd-external", "--ahp-host", "pi-daemon", "--json"]]);
  }
});

test("concurrent Durable sessions use their own names, while forks in one session retain its visitor", async () => {
  const caco = fakeCaco({ id: (id) => `visiting-${id}` });
  const env = { HOME: "/nonexistent", CACO_PROJECT: "p", PI_CACO_AUTO_REGISTER: "1", PI_SESSION_NAME: "server name" };
  const module = createCacophonyModule({ env, settings: {}, execFileImpl: caco.execFileImpl });
  const names = ["Same name", "Same name", "Child task", undefined];
  const sessions = names.map((name, i) => sessionContext(`s${i}`, {}, "/same-checkout", name));
  const resolveName = [];
  for (const { ctx } of sessions) ctx.getSessionName = () => new Promise(resolve => resolveName.push(resolve));
  const flights = sessions.map(({ ctx }) => module.observe({ type: "agent_start" }, ctx));
  // Metadata is asynchronous and completions may interleave across sessions.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolveName.length, 4);
  for (let i = 3; i >= 0; i--) resolveName[i](names[i]);
  await Promise.all(flights);
  assert.equal(caco.calls.length, 4);
  for (let i = 0; i < 4; i++) {
    const { ctx, env: vars } = sessions[i];
    const args = caco.calls.find(call => call[call.indexOf("--session-id") + 1] === ctx.sessionId);
    if (names[i]) assert.equal(args[args.indexOf("--session-name") + 1], names[i]);
    else assert.equal(args.includes("--session-name"), false);
    assert.equal(vars.CACO_AGENT_ID, `visiting-s${i}`);
    assert.equal((await ctx.state.get("identity")).sessionId, ctx.sessionId);
    // /fork is a child conversation of the same Durable session, not a new identity.
    await module.observe({ type: "agent_start" }, { ...ctx, conversationId: `fork-${i}` });
  }
  assert.equal(caco.calls.length, 4);
  assert.equal(env.CACO_AGENT_ID, undefined, "worker environment is unchanged");

  // A new logical session (/clone), even with a copied receipt, is not its parent.
  const clone = sessionContext("clone", {}, "/same-checkout", "Clone's own name");
  await clone.ctx.state.set("identity", await sessions[0].ctx.state.get("identity"));
  await module.observe({ type: "agent_start" }, clone.ctx);
  assert.equal(caco.calls.length, 5);
  assert.equal(caco.calls[4][caco.calls[4].indexOf("--session-name") + 1], "Clone's own name");
  assert.equal(clone.env.CACO_AGENT_ID, "visiting-clone");
  assert.equal(sessions[0].env.CACO_AGENT_ID, "visiting-s0");
});

test("named Durable sessions preserve managed and disable precedence for manual and automatic registration", async () => {
  for (const [env, vars] of [
    [{ DISABLE_PI_CACO: "1" }, {}],
    [{}, { CACO_AGENT_ID: "managed", CACO_PROJECT: "p" }],
    [{ CACO_AGENT_ID: "managed", CACO_PROJECT: "p" }, {}],
    [{}, { CACO_AGENT_ID: "visiting-migrated", CACO_PROJECT: "p" }],
  ]) {
    const caco = fakeCaco();
    const module = createCacophonyModule({ env: { HOME: "/nonexistent", PI_CACO_AUTO_REGISTER: "1", CACO_PROJECT: "p", ...env }, settings: {}, execFileImpl: caco.execFileImpl });
    const { ctx } = sessionContext("preserved", vars);
    let nameReads = 0;
    ctx.getSessionName = async () => { nameReads++; return "Human name"; };
    await module.commands["caco-agent-register"].run("project=p", ctx);
    await module.observe({ type: "agent_start" }, ctx);
    assert.equal(nameReads, 0);
    assert.deepEqual(caco.calls, []);
  }
});

test("the cacophony section names the registered agent and carries the guidance", async () => {
  const section = identitySection();
  assert.equal(section.key, "cacophony");
  const read = (doc) => ({ read: { snapshot: async (token, key) => (token === MODULE_STATE_DOC && key === MODULE ? doc : undefined) } });
  assert.equal(await section.render(read(undefined), {}), undefined);
  const text = await section.render(read({ values: { identity: { agentId: "visiting-abc", project: "agent-utils", guidance: "Use beads." } } }), {});
  assert.match(text, /^This session is the Cacophony visiting agent visiting-abc in project agent-utils\./);
  assert.match(text, /CACO_AGENT_ID and CACO_PROJECT/);
  assert.match(text, /\n\nUse beads\.$/);
});

test("with auto-registration, a session's first run registers it once; managed sessions are left alone", async () => {
  const caco = fakeCaco({ id: "visiting-auto" });
  const module = createCacophonyModule({ env: { PI_CACO_AUTO_REGISTER: "1", CACO_PROJECT: "home", HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl });
  const { ctx, env } = sessionContext("pd-auto");
  const info = { sessionId: ctx.sessionId, state: ctx.state, env: ctx.env, cwd: ctx.cwd };
  await Promise.all([module.observe({ type: "agent_start" }, info), module.observe({ type: "agent_start" }, info)]);
  await module.observe({ type: "agent_start" }, info);
  assert.equal(caco.calls.length, 1, "registered once");
  assert.deepEqual(env, { CACO_AGENT_ID: "visiting-auto", CACO_PROJECT: "home" });
  await module.observe({ type: "message_end" }, info);
  assert.equal(caco.calls.length, 1);

  const managed = sessionContext("pd-managed", { CACO_AGENT_ID: "cluster-ctrl", CACO_PROJECT: "cacophony" });
  await module.observe({ type: "agent_start" }, { sessionId: "pd-managed", state: managed.ctx.state, env: managed.ctx.env });
  assert.equal(caco.calls.length, 1, "a managed session is not registered");
  await module.commands["caco-runtime"].run("", managed.ctx);
  assert.equal(managed.notices.at(-1), "managed cluster-ctrl in cacophony (environment)");

  // Without auto-registration nothing happens on a run.
  const manual = createCacophonyModule({ env: { CACO_PROJECT: "home", HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl });
  const quiet = sessionContext("pd-quiet");
  await manual.observe({ type: "agent_start" }, { sessionId: "pd-quiet", state: quiet.ctx.state, env: quiet.ctx.env });
  assert.equal(caco.calls.length, 1);
  await manual.commands["caco-runtime"].run("", quiet.ctx);
  assert.equal(quiet.notices.at(-1), "not registered; /caco-agent-register");
});

test("a pi-daemon session registers on the node's pi-daemon host, so caco delivers into it (cacophony bd-6cf22b)", async () => {
  const caco = fakeCaco({ id: "visiting-host" });
  const module = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: { project: "p", autoRegister: true }, execFileImpl: caco.execFileImpl, now: () => 5 });
  const { ctx } = sessionContext("pd-host", {}, "/work/host");
  await module.observe({ type: "agent_start" }, { sessionId: ctx.sessionId, state: ctx.state, env: ctx.env, cwd: ctx.cwd });
  assert.deepEqual(caco.calls.at(-1).slice(-3), ["--ahp-host", "pi-daemon", "--json"]);
  assert.equal((await ctx.state.get("identity")).ahpHost, "pi-daemon");

  // An older caco refuses the flag: the session registers as before, without a host.
  const older = fakeCaco({ id: "visiting-older", olderCaco: true });
  const legacy = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: { project: "p", autoRegister: true }, execFileImpl: older.execFileImpl, now: () => 5 });
  const second = sessionContext("pd-older", {}, "/work/older");
  await legacy.observe({ type: "agent_start" }, { sessionId: second.ctx.sessionId, state: second.ctx.state, env: second.ctx.env, cwd: second.ctx.cwd });
  assert.equal(older.calls.length, 2);
  assert.ok(!older.calls[1].includes("--ahp-host"));
  const identity = await second.ctx.state.get("identity");
  assert.equal(identity.agentId, "visiting-older");
  assert.equal(identity.ahpHost, undefined);
});

test("a visitor registered before host routing gets its host bound once (cacophony bd-6cf22b)", async () => {
  const caco = fakeCaco({ id: "visiting-old" });
  const module = createCacophonyModule({ env: { HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl, now: () => 7 });
  const { ctx } = sessionContext("pd-old", {}, "/work/old");
  await ctx.state.set("identity", { agentId: "visiting-old", project: "p", sessionId: "pd-old", registeredAt: 1, guidance: "" });
  const info = { sessionId: ctx.sessionId, state: ctx.state, env: ctx.env, cwd: ctx.cwd };
  await module.observe({ type: "agent_start" }, info);
  await module.observe({ type: "agent_start" }, info);
  assert.equal(caco.calls.length, 1, "bound once");
  assert.deepEqual(caco.calls[0].slice(0, 8), ["caco", "agent", "register", "--project", "p", "--session-id", "pd-old", "--checkout-root"]);
  assert.equal((await ctx.state.get("identity")).ahpHost, "pi-daemon");
  // A migrated session's inherited identity keeps its terminal route.
  const migrated = sessionContext("pd-migrated-bind", { CACO_AGENT_ID: "visiting-tui", CACO_PROJECT: "p" }, "/work/migrated");
  await module.observe({ type: "agent_start" }, { sessionId: migrated.ctx.sessionId, state: migrated.ctx.state, env: migrated.ctx.env, cwd: migrated.ctx.cwd });
  await module.observe({ type: "agent_start" }, { sessionId: migrated.ctx.sessionId, state: migrated.ctx.state, env: migrated.ctx.env, cwd: migrated.ctx.cwd });
  assert.equal(caco.calls.length, 1);
});
