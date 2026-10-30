// The agent chip (extensions/lib/agent-chip.js): a Cacophony agent's `project▌name` in place of
// the directory chip, in TUI Pi (its own identity) and pi-client (each pane's session's, from
// agent-utils' cacophony module state); the module records a native agent's identity for it.
import test from "node:test";
import assert from "node:assert/strict";

import { CACOPHONY_STATE_ADDRESS, agentFromVariables, runtimeAgentChip, stateAgentChip } from "../extensions/lib/agent-chip.js";
import { clearCacophonyRuntimeIdentity, setCacophonyRuntimeIdentity } from "../extensions/lib/cacophony-runtime.js";
import { createCacophonyModule } from "../extensions/lib/durable-cacophony.js";
import { createEditorChipsExtension } from "../extensions/lib/editor-chips-extension.js";
import { buildEditorChipRails, resolveEditorChipsConfig, stripAnsi } from "../extensions/lib/editor-chips.js";

const theme = { getFgAnsi: () => "\x1b[38;2;236;239;244m" };
const values = (overrides = {}) => ({
  provider: "github-copilot",
  model: "gpt-5.6-sol",
  effort: "low",
  mcpCount: 2,
  cost: 1,
  contextPct: 12,
  contextMax: 1_000_000,
  directory: "~/src/pi-daemon",
  branch: "main",
  inGitRepo: true,
  additions: 1,
  deletions: 0,
  ...overrides,
});
const config = (chips = {}) => resolveEditorChipsConfig({ agentUtils: { editorChips: { enabled: true, ...chips } } }, {});

test("a Cacophony agent's chip stands in for the directory: project▌name, the name alone when narrow", () => {
  const agent = { project: "cacophony", name: "router" };
  const bottom = stripAnsi(buildEditorChipRails({ width: 160, config: config(), values: values({ agent }), theme }).bottom);
  assert.match(bottom, /cacophony▌router/);
  assert.doesNotMatch(bottom, /pi-daemon/, "no directory");
  // Without an agent: the directory, as before.
  assert.match(stripAnsi(buildEditorChipRails({ width: 160, config: config(), values: values(), theme }).bottom), /~\/src\/pi-daemon/);
  // Placed itself ("caco" is its alias): the directory stays and the agent chip is where placed.
  const placed = stripAnsi(buildEditorChipRails({ width: 160, config: config({ bottomCenter: ["caco"] }), values: values({ agent }), theme }).bottom);
  assert.match(placed, /~\/src\/pi-daemon/);
  assert.match(placed, /cacophony▌router/);
  // Narrow: the project goes before anything else shrinks.
  const narrow = stripAnsi(buildEditorChipRails({ width: 52, config: config(), values: values({ agent: { project: "cacophony", name: "ms-mac-cacophony-router" } }), theme }).bottom);
  assert.match(narrow, / ms-mac-cacophony-router /);
  assert.doesNotMatch(narrow, /cacophony▌/);
});

test("TUI Pi's identity: the declared name (CACOPHONY_AGENT_NAME) before the full id; visiting; disabled", () => {
  const env = { CACO_AGENT_ID: "ms-mac-cacophony-router", CACOPHONY_AGENT: "ms-mac-cacophony-router", CACO_PROJECT: "cacophony" };
  assert.deepEqual(runtimeAgentChip({ ...env, CACOPHONY_AGENT_NAME: "router" }), { project: "cacophony", name: "router" });
  assert.deepEqual(runtimeAgentChip(env), { project: "cacophony", name: "ms-mac-cacophony-router" });
  assert.deepEqual(runtimeAgentChip({ CACOPHONY_AGENT: "pidm-dev-msd-0", CACOPHONY_PROJECT: "pi-daemon" }), { project: "pi-daemon", name: "pidm-dev-msd-0" });
  assert.deepEqual(runtimeAgentChip({ CACO_AGENT_ID: "lonely" }), { project: "", name: "lonely" }, "an id without a project");
  assert.equal(runtimeAgentChip({ ...env, DISABLE_PI_CACO: "1" }), undefined);
  assert.equal(runtimeAgentChip({}, "s1"), undefined);
  // A visiting registration (/caco-agent-register) of this session.
  setCacophonyRuntimeIdentity({ agentId: "visiting-abcdef", project: "pi-daemon", visiting: true }, "s1");
  try {
    assert.deepEqual(runtimeAgentChip({}, "s1"), { project: "pi-daemon", name: "visiting-abcdef" });
    assert.equal(runtimeAgentChip({}, "s2"), undefined, "another session's is not this one's");
  } finally {
    clearCacophonyRuntimeIdentity();
  }
});

test("a pi-daemon session's identity: its visiting registration, else the native agent its module recorded", () => {
  assert.deepEqual(stateAgentChip({ values: { identity: { agentId: "visiting-abcdef", project: "pi-daemon", sessionId: "s1" } } }, "s1"), { project: "pi-daemon", name: "visiting-abcdef" });
  assert.equal(stateAgentChip({ values: { identity: { agentId: "visiting-abcdef", project: "pi-daemon", sessionId: "s1" } } }, "clone"), undefined, "a clone's copied registration");
  assert.deepEqual(stateAgentChip({ values: { agent: { agentId: "ms-mac-cacophony-router", project: "cacophony", name: "router" } } }, "s1"), { project: "cacophony", name: "router" });
  assert.equal(stateAgentChip(undefined, "s1"), undefined);
  assert.deepEqual(agentFromVariables({ CACOPHONY_AGENT: "a", CACOPHONY_PROJECT: "p", CACOPHONY_AGENT_NAME: " " }), { agentId: "a", project: "p" });
});

/** The editor chips over a fake Pi: draw `session`'s pane and return its bottom rail. */
async function chips({ env = {}, chord } = {}) {
  const handlers = new Map();
  let editorFactory;
  let drawing = "s1";
  const ctx = {
    mode: "tui",
    cwd: "/home/u/src/pi-daemon",
    model: { provider: "openai", id: "gpt", contextWindow: 100_000 },
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }),
    sessionManager: { getEntries: () => [], getSessionId: () => drawing },
    ...(chord === undefined ? {} : { chord }),
    ui: {
      getEditorComponent: () => () => ({ render: () => ["top", "editor", "bottom"], handleInput() {}, invalidate() {} }),
      setEditorComponent: (factory) => { editorFactory = factory; },
    },
  };
  const pi = {
    registerCommand() {},
    on(name, handler) { handlers.set(name, [...(handlers.get(name) || []), handler]); },
    getThinkingLevel: () => "off",
    exec: async () => ({ code: 1, stdout: "" }),
  };
  await createEditorChipsExtension({ settings: { agentUtils: { editorChips: { enabled: true } } }, env: { HOME: "/home/u", ...env }, host: { CustomEditor: class {} } })(pi);
  await handlers.get("session_start")[0]({}, ctx);
  const renders = [];
  const editor = editorFactory({ requestRender: () => renders.push(1) }, { fg: (_c, t) => t, bg: (_c, t) => t, bold: (t) => t }, {});
  const draw = (session) => {
    drawing = session;
    return stripAnsi(editor.render(160).join("\n"));
  };
  return { draw, renders, shutdown: () => handlers.get("session_shutdown")?.[0]?.() };
}

test("TUI Pi draws its own agent in place of the directory", async () => {
  const tui = await chips({ env: { CACO_AGENT_ID: "ms-mac-cacophony-router", CACO_PROJECT: "cacophony", CACOPHONY_AGENT_NAME: "router" } });
  const drawn = tui.draw("s1");
  assert.match(drawn, /cacophony▌router/);
  assert.doesNotMatch(drawn, /~\/src\/pi-daemon/);
  tui.shutdown();
  const plain = await chips();
  assert.match(plain.draw("s1"), /~\/src\/pi-daemon/);
  plain.shutdown();
});

test("pi-client draws each pane's session's agent, from its cacophony module's state", async () => {
  const watched = [];
  const callbacks = new Map();
  let drawingSession;
  const chord = {
    watchDocument(address, onValue) {
      watched.push({ address, session: drawingSession });
      callbacks.set(drawingSession, onValue);
      return Promise.resolve(() => watched.push({ stopped: drawingSession }));
    },
  };
  // pi-client's own environment is not the sessions' identity.
  const client = await chips({ env: { CACO_AGENT_ID: "the-client-shells-agent", CACO_PROJECT: "elsewhere" }, chord });
  const draw = (session) => {
    drawingSession = session;
    return client.draw(session);
  };
  assert.match(draw("s1"), /~\/src\/pi-daemon/, "nothing known yet: the directory");
  assert.doesNotMatch(draw("s1"), /the-client-shells-agent/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(watched, [{ address: { ...CACOPHONY_STATE_ADDRESS }, session: "s1" }], "one watch, of the drawn session");
  callbacks.get("s1")({ values: { identity: { agentId: "visiting-abcdef", project: "pi-daemon", sessionId: "s1" } } });
  assert.ok(client.renders.length > 0, "a change redraws");
  assert.match(draw("s1"), /pi-daemon▌visiting-abcdef/);
  draw("s2");
  callbacks.get("s2")({ values: { agent: { agentId: "pidm-dev-msd-0", project: "pi-daemon" } } });
  assert.match(draw("s2"), /pi-daemon▌pidm-dev-msd-0/);
  assert.match(draw("s1"), /pi-daemon▌visiting-abcdef/, "each pane its own");
  client.shutdown();
  // A watch still starting when the session ends is stopped as it starts.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(watched.filter((entry) => entry.stopped).map((entry) => entry.stopped).length, 2, "watches end with the session");
});

test("the cacophony module records a native agent's identity from the session's variables, for clients", async () => {
  const module = createCacophonyModule({ env: {}, settings: {} });
  const state = new Map();
  let vars = { CACO_AGENT_ID: "ms-mac-cacophony-router", CACO_PROJECT: "cacophony", CACOPHONY_AGENT_NAME: "router", OTHER: "x" };
  const info = {
    sessionId: "s1",
    env: { all: async () => vars, get: async () => ({}), set: async () => {} },
    state: { get: async (key) => state.get(key), set: async (key, value) => (value === undefined ? state.delete(key) : state.set(key, value)) },
  };
  await module.observe({ type: "agent_start" }, info);
  assert.deepEqual(state.get("agent"), { agentId: "ms-mac-cacophony-router", project: "cacophony", name: "router" }, "only the identity, no other variable");
  // A visiting agent is its registration's (identity), not this.
  vars = { CACO_AGENT_ID: "visiting-abcdef", CACO_PROJECT: "pi-daemon" };
  await module.observe({ type: "agent_start" }, info);
  assert.equal(state.has("agent"), false);
  // Hosts before env.all(): nothing recorded.
  vars = { CACO_AGENT_ID: "ms-mac-cacophony-router", CACO_PROJECT: "cacophony" };
  await module.observe({ type: "agent_start" }, { ...info, env: { get: async () => ({}), set: async () => {} } });
  assert.equal(state.has("agent"), false);
});
