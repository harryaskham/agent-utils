// Cacophony visiting registration for pi-daemon sessions (extensions/durable/cacophony.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { MODULE, MODULE_STATE_DOC, createCacophonyModule, identitySection } from "../extensions/lib/durable-cacophony.js";

/** A fake `caco agent register --json`, recording its calls. */
function fakeCaco({ id = "visiting-abc", guidance = "Visiting agents coordinate through beads.", fail } = {}) {
  const calls = [];
  const execFileImpl = (command, args, _options, callback) => {
    calls.push([command, ...args]);
    const project = args[args.indexOf("--project") + 1];
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() =>
      fail
        ? callback(new Error("exit 1"), "", "caco: daemon unavailable\nmore")
        : callback(null, JSON.stringify({ data: { id, project, session_id: sessionId }, guidance: { text: guidance } }), ""),
    );
  };
  return { calls, execFileImpl };
}

/** A module command / observer context: module state and the session's variables. */
function sessionContext(sessionId = "s1", vars = {}) {
  const values = new Map();
  const env = { ...vars };
  const notices = [];
  return {
    notices,
    env,
    ctx: {
      sessionId,
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

test("/caco-agent-register registers the session, keeps its identity and sets its variables", async () => {
  const caco = fakeCaco();
  const module = createCacophonyModule({ env: { CACO_BIN: "/opt/caco", HOME: "/nonexistent" }, settings: {}, execFileImpl: caco.execFileImpl, now: () => 5 });
  const { ctx, notices, env } = sessionContext("pd-session-1");
  await module.commands["caco-agent-register"].run("project=agent-utils", ctx);
  assert.deepEqual(caco.calls, [["/opt/caco", "agent", "register", "--project", "agent-utils", "--session-id", "pd-session-1", "--json"]]);
  assert.equal(notices.at(-1), "Registered as Cacophony visiting agent visiting-abc in project agent-utils.");
  assert.deepEqual(env, { CACO_AGENT_ID: "visiting-abc", CACO_PROJECT: "agent-utils" });
  assert.deepEqual(await ctx.state.get("identity"), {
    agentId: "visiting-abc",
    project: "agent-utils",
    sessionId: "pd-session-1",
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
  assert.match(other.notices.at(-1), /^No project/);
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
  const info = { sessionId: ctx.sessionId, state: ctx.state, env: ctx.env };
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
