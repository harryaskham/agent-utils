// /fleet models (bd-1da117): patterns, arguments, config references, reading a fake fleet over
// injected /chord clients, switching (chord, caco, fallbacks, catalog checks), the TUI/pi-client
// extension and the pi-daemon module.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  cacophonyAgentOf,
  chunkText,
  compilePattern,
  fleetCompletions,
  fleetHosts,
  flagReferences,
  modelMatcher,
  modelReferences,
  parseFleetArgs,
  parseModelRef,
  parseSince,
  readFleet,
  runFleet,
  settingsDefaults,
  tokenize,
} from "../extensions/lib/fleet-models.js";
import fleetExtension, { createFleetHandler } from "../extensions/fleet.js";
import { MAX_NOTICES, commands, createFleetCommand, noticesOf } from "../extensions/durable/fleet.mjs";

const NOW = Date.parse("2026-11-23T10:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const m = (text) => parseModelRef(text);

// ---------------------------------------------------------------------------------------------
// A fake fleet: each URL a /chord whose sessions, profiles and catalogs a test sets.

const CATALOG = [
  { provider: "github-copilot", modelId: "gpt-6-astra", thinkingLevels: ["low", "medium", "high", "xhigh"] },
  { provider: "github-copilot", modelId: "gpt-6.2-astra", thinkingLevels: ["low", "medium", "high", "xhigh"] },
  { provider: "github-copilot", modelId: "claude-fable-5.2", thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] },
  { provider: "github-copilot", modelId: "claude-opus-5.5", thinkingLevels: ["low", "high", "xhigh"] },
  { provider: "astra", modelId: "bonsai-2", thinkingLevels: ["off"] },
];

function session(id, model, extra = {}) {
  return { id, title: id, profile: "personal", cwd: `/home/h/src/${id}`, activeAt: NOW - HOUR, liveWork: false, isArchived: false, model, thinkingLevel: "xhigh", ...extra };
}

function fakeFleet(endpoints) {
  const calls = [];
  const connect = async ({ url, token }) => {
    const endpoint = endpoints[url];
    if (!endpoint || endpoint.offline) throw new Error(`timed out connecting to ${url}`);
    assert.equal(token, "secret-token");
    return {
      async call(method, params = {}) {
        calls.push({ url, method, params });
        switch (method) {
          case "sessions.list": {
            const rows = endpoint.sessions.map((row) => (params.withModel || endpoint.bridge ? row : { ...row, model: undefined }));
            if (endpoint.bridge) return { items: rows };
            const start = params.after ? Number(params.after) : 0;
            const limit = params.limit ?? 1000;
            const items = rows.slice(start, start + limit);
            return { items, ...(start + limit < rows.length ? { next: String(start + limit) } : {}) };
          }
          case "profiles.list":
            return { items: endpoint.profiles ?? [] };
          case "session.models":
            if (endpoint.modelsError) throw new Error(endpoint.modelsError);
            return { items: endpoint.catalog ?? CATALOG };
          case "conversation.configure": {
            const row = endpoint.sessions.find((candidate) => candidate.id === params.sessionId);
            if (!row) throw new Error("not_found: no such session");
            if (params.model) row.model = `${params.model.provider}/${params.model.modelId}`;
            if (params.thinkingLevel) row.thinkingLevel = params.thinkingLevel;
            return null;
          }
          default:
            throw new Error(`method_not_found: ${method}`);
        }
      },
      close() {},
    };
  };
  return { connect, calls };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fleet-models-"));
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "secret-token\n");
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "github-copilot",
    defaultModel: "gpt-6-astra",
    enabledModels: ["github-copilot/claude-opus-5.5", "github-copilot/gpt-6.2-astra"],
    agentUtils: { narrate: { model: "github-copilot/gpt-6.1-terra" } },
    compaction: { modelOverrides: { "github-copilot/gpt-6-astra": { reserveTokens: 1 } } },
    client: { hosts: [{ name: "astra", url: "ws://astra:7463" }] },
  }));
  const env = { PI_DAEMON_NODE: "alpha", PI_DAEMON_TOKEN_FILE: tokenFile, PI_CODING_AGENT_DIR: agentDir, PI_DAEMON_URL: "ws://alpha-local:7463", PI_DAEMON_BRIDGE_URL: "ws://alpha-local:7464", CACO_BIN: "caco" };
  const settings = { hosts: [{ name: "alpha", url: "ws://alpha:7463", bridge: "ws://alpha:7464" }, { name: "beta", url: "ws://beta:7463", bridge: "ws://beta:7464" }, { name: "gamma", url: "ws://gamma:7463" }] };
  return { dir, env, settings, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function endpoints() {
  return {
    "ws://alpha-local:7463": {
      sessions: [
        session("chord-a1", "github-copilot/gpt-6-astra", { title: "notes", liveWork: true }),
        session("flow-1", "github-copilot/gpt-6-astra", { profile: "cacophony", cwd: "/home/h/.cacophony/agents/cacophony/flow-1/checkout", activeAt: NOW - 5 * DAY }),
        session("chord-a2", "github-copilot/claude-opus-5.5"),
        session("chord-old", "github-copilot/gpt-6-astra", { activeAt: NOW - 40 * DAY }),
        session("chord-in-checkout", "github-copilot/gpt-6-luna", { cwd: "/home/h/.cacophony/agents/cacophony/flow-1/checkout" }),
      ],
      profiles: [{ name: "personal", model: "github-copilot/claude-opus-5.5" }, { name: "cacophony", model: "github-copilot/gpt-6-astra" }],
    },
    "ws://alpha-local:7464": { bridge: true, sessions: [session("pi-tui-1", "github-copilot/gpt-6.2-astra", { profile: "tui", cwd: "/home/h/tui" }), session("pi-tui-2", "github-copilot/gpt-6-luna", { profile: "tui", cwd: "/home/h/.cacophony/agents/cacophony/pi-tui-2/checkout" })] },
    "ws://beta:7463": {
      sessions: [
        session("chord-b1", "github-copilot/gpt-6-astra"),
        session("chord-b2", "github-copilot/gpt-6-astra", { isArchived: true }),
        session("chord-b3", "astra/bonsai-2"),
      ],
      profiles: [{ name: "personal", model: "github-copilot/gpt-6-astra" }],
    },
    "ws://beta:7464": { bridge: true, sessions: [] },
    "ws://gamma:7463": { offline: true },
  };
}

function cacoExec({ config = {}, setModel = () => ({ data: { effective_model: "github-copilot/claude-fable-5.2", metadata_updated: true } }) } = {}) {
  const runs = [];
  const exec = async (file, args) => {
    runs.push([file, ...args]);
    if (args[0] === "config") return { code: 0, stdout: JSON.stringify(config), stderr: "" };
    if (args[0] === "agent" && args[1] === "set-model") return { code: 0, stdout: JSON.stringify(setModel(args[3], args[5])), stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { exec, runs };
}

// ---------------------------------------------------------------------------------------------
// Arguments and patterns

test("tokenize keeps quoted words whole", () => {
  assert.deepEqual(tokenize(`models '*astra*' "gpt 6" --switch=a/b x\\ y`), ["models", "*astra*", "gpt 6", "--switch=a/b", "x y"]);
  assert.deepEqual(tokenize("  "), []);
  assert.throws(() => tokenize("models '*astra"), /unclosed '/);
});

test("parseFleetArgs reads patterns and options, and refuses what makes no sense", () => {
  assert.equal(parseFleetArgs("").action, "help");
  assert.equal(parseFleetArgs("help").action, "help");
  const options = parseFleetArgs("models '*astra*' gpt-6-luna --switch github-copilot/claude-fable-5.2 --thinking high --since 7d --host ms-dev-* --host ms-mac,helsinki --profile cacophony --archived --dry-run --direct --json --no-config");
  assert.deepEqual(options.patterns, ["*astra*", "gpt-6-luna"]);
  assert.equal(options.switchTo, "github-copilot/claude-fable-5.2");
  assert.equal(options.thinking, "high");
  assert.equal(options.sinceMs, 7 * DAY);
  assert.deepEqual(options.hosts, ["ms-dev-*", "ms-mac", "helsinki"]);
  assert.deepEqual(options.profiles, ["cacophony"]);
  assert.equal(options.archived && options.dryRun && options.direct && options.json, true);
  assert.equal(options.config, false);
  assert.equal(parseFleetArgs("models").sinceMs, 30 * DAY);
  assert.equal(parseFleetArgs("models --since all").sinceMs, null);
  assert.throws(() => parseFleetArgs("sessions"), /unknown \/fleet command sessions/);
  assert.throws(() => parseFleetArgs("models --switch a/b"), /--switch needs a pattern/);
  assert.throws(() => parseFleetArgs("models x --dry-run"), /go with --switch/);
  assert.throws(() => parseFleetArgs("models x --switch"), /--switch needs a value/);
  assert.throws(() => parseFleetArgs("models x --bogus"), /unknown option --bogus/);
  assert.throws(() => parseFleetArgs("models x --switch a/b --thinking loud"), /--thinking is one of/);
});

test("parseSince takes durations and all", () => {
  assert.equal(parseSince("90m"), 90 * 60_000);
  assert.equal(parseSince("12h"), 12 * HOUR);
  assert.equal(parseSince("2w"), 14 * DAY);
  assert.equal(parseSince("all"), null);
  assert.throws(() => parseSince("soon"), /--since takes a duration/);
});

test("a pattern without / matches the model id; with / the provider too; /re/ is a regex", () => {
  const astra = compilePattern("*astra*");
  assert.equal(astra(m("github-copilot/gpt-6-astra")), true);
  assert.equal(astra(m("github-copilot/gpt-6.2-astra")), true);
  assert.equal(astra(m("astra/bonsai-2")), false, "the astra provider's own models are not Astra models");
  assert.equal(astra(undefined), false);
  assert.equal(compilePattern("astra/*")(m("astra/bonsai-2")), true);
  assert.equal(compilePattern("gpt-6-astra")(m("github-copilot/gpt-6-astra")), true);
  assert.equal(compilePattern("gpt-6-astra")(m("github-copilot/gpt-6.2-astra")), false, "a bare id is exact");
  assert.equal(compilePattern("GPT-6-ASTRA")(m("github-copilot/gpt-6-astra")), true, "case is ignored");
  assert.equal(compilePattern("github-copilot/*")(m("github-copilot/claude-opus-5.5")), true);
  assert.equal(compilePattern("github-copilot/*")({ modelId: "claude-opus-5.5" }), false);
  assert.equal(compilePattern("gpt-6.[12]-*")(m("github-copilot/gpt-6.2-sol")), true);
  assert.equal(compilePattern("gpt-6.[!12]-*")(m("github-copilot/gpt-6.2-sol")), false);
  assert.equal(compilePattern("/sol$/")(m("github-copilot/gpt-6.2-sol")), true);
  assert.throws(() => compilePattern("/(/"), /bad pattern/);
  assert.equal(modelMatcher([])(undefined), true, "no pattern: every session");
  assert.equal(modelMatcher(["*sol*", "*luna*"])(m("github-copilot/gpt-6-luna")), true);
});

test("cacophonyAgentOf reads a managed checkout's project and agent, only for the agent's own session", () => {
  assert.deepEqual(cacophonyAgentOf("/home/h/.cacophony/agents/health/health-slack/checkout", "health-slack"), { project: "health", agentId: "health-slack" });
  assert.equal(cacophonyAgentOf("/home/h/.cacophony/agents/health/health-slack/checkout", "chord-1234"), undefined, "a person's session in an agent's checkout is not the agent");
  assert.equal(cacophonyAgentOf("/home/h/src/x", "x"), undefined);
});

// ---------------------------------------------------------------------------------------------
// Config references

test("modelReferences finds model-named keys, lists, override keys, with their provider", () => {
  const refs = modelReferences({
    defaultProvider: "github-copilot",
    defaultModel: "gpt-6-astra",
    enabledModels: ["github-copilot/claude-opus-5.5"],
    tendril: { describeModel: "github-copilot/gpt-6.1-terra" },
    compaction: { modelOverrides: { "github-copilot/gpt-6-astra": { reserveTokens: 1 } }, summaryModel: "github-copilot/gpt-6-luna" },
    providers: { pi: { "github-copilot": { models: [{ name: "gpt-6.2-astra", logical_provider: "openai" }] } } },
    projects: [{ name: "health", agents: { persistent: { "health-slack": { provider: "github-copilot", model: "claude-fable-5.2" } } } }],
    title: "gpt-6-astra",
  });
  const byPath = Object.fromEntries(refs.map((ref) => [ref.path.join("."), ref.model]));
  assert.deepEqual(byPath.defaultModel, m("github-copilot/gpt-6-astra"));
  assert.deepEqual(byPath["enabledModels.[0]"], m("github-copilot/claude-opus-5.5"));
  assert.deepEqual(byPath["tendril.describeModel"], m("github-copilot/gpt-6.1-terra"));
  assert.deepEqual(byPath["compaction.modelOverrides.github-copilot/gpt-6-astra"], m("github-copilot/gpt-6-astra"));
  assert.deepEqual(byPath["compaction.summaryModel"], m("github-copilot/gpt-6-luna"));
  assert.deepEqual(byPath["providers.pi.github-copilot.models.[gpt-6.2-astra]"], { modelId: "gpt-6.2-astra" });
  assert.deepEqual(byPath["projects.[health].agents.persistent.health-slack.model"], m("github-copilot/claude-fable-5.2"));
  assert.equal(refs.some((ref) => ref.path.includes("title")), false, "only model-named keys");
});

test("flagReferences names each match by its path; settings.json's client section is left out", () => {
  const flags = flagReferences({ projects: [{ name: "health", agents: { persistent: { "health-slack": { provider: "github-copilot", model: "claude-fable-5.2" } } } }] }, modelMatcher(["claude-fable-*"]), { source: "cacophony config" });
  assert.deepEqual(flags, [{ source: "cacophony config", path: "projects[health].agents.persistent.health-slack.model", value: "claude-fable-5.2" }]);
  const { env, cleanup } = setup();
  try {
    const local = settingsDefaults(modelMatcher(["*astra*"]), { env });
    assert.deepEqual(local.flags.map((flag) => `${flag.path}=${flag.value}`), ["defaultModel=gpt-6-astra", "enabledModels[1]=github-copilot/gpt-6.2-astra", "compaction.modelOverrides.github-copilot/gpt-6-astra=github-copilot/gpt-6-astra"]);
    assert.match(local.flags[0].where, /settings\.json$/);
    assert.match(settingsDefaults(() => true, { env: { PI_CODING_AGENT_DIR: "/nonexistent" } }).error, /settings\.json/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Hosts and reading

test("fleetHosts reaches this machine over loopback and adds it when settings lack it", () => {
  const { env, settings, cleanup } = setup();
  try {
    const hosts = fleetHosts({ env, settings });
    assert.deepEqual(hosts.map((host) => [host.name, host.url, host.bridge ?? null, host.local]), [
      ["alpha", "ws://alpha-local:7463", "ws://alpha-local:7464", true],
      ["beta", "ws://beta:7463", "ws://beta:7464", false],
      ["gamma", "ws://gamma:7463", null, false],
    ]);
    const alone = fleetHosts({ env: { ...env, PI_DAEMON_NODE: "delta" }, settings });
    assert.equal(alone[0].name, "delta");
    assert.equal(alone[0].local, true);
    assert.equal(alone.length, 4);
    assert.equal(fleetHosts({ env: { PI_DAEMON_NODE: "x" }, settings: { hosts: [{ name: "y", url: "ws://y", tokenFile: "/own" }], tokenFile: "/shared" } })[1].tokenFile, "/own");
  } finally {
    cleanup();
  }
});

test("readFleet reads every daemon and bridge, keeps the window, and reports a down host quietly", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect, calls } = fakeFleet(endpoints());
    const fleet = await readFleet({ hosts: fleetHosts({ env, settings }), now: NOW, connect });
    const [alpha, beta, gamma] = fleet.nodes;
    assert.deepEqual(alpha.daemon.sessions.map((row) => row.id), ["chord-a1", "flow-1", "chord-a2", "chord-in-checkout"], "chord-old is outside 30d");
    assert.equal(alpha.daemon.sessions[3].caco, undefined, "a session in an agent's checkout is not the agent");
    assert.deepEqual(alpha.daemon.sessions[1].caco, { project: "cacophony", agentId: "flow-1" });
    assert.equal(alpha.daemon.sessions[0].working, true);
    assert.deepEqual(alpha.bridge.sessions.map((row) => [row.id, row.hostLabel, row.source]), [["pi-tui-1", "alpha-tui", "tui"], ["pi-tui-2", "alpha-tui", "tui"]]);
    assert.equal(alpha.bridge.sessions[1].caco, undefined, "TUI Pis are never switched through caco");
    assert.deepEqual(alpha.daemon.profiles.map((profile) => [profile.name, profile.model.modelId]), [["personal", "claude-opus-5.5"], ["cacophony", "gpt-6-astra"]]);
    assert.equal(beta.daemon.sessions.length, 3);
    assert.equal(gamma.daemon.state, "offline");
    assert.equal(gamma.bridge.state, "none");
    assert.ok(calls.filter((call) => call.method === "sessions.list" && !call.url.endsWith("7464")).every((call) => call.params.withModel === true && call.params.limit === 100));
  } finally {
    cleanup();
  }
});

test("readFleet pages through a large catalog", async () => {
  const { env, cleanup } = setup();
  try {
    const many = Array.from({ length: 250 }, (_, index) => session(`s${index}`, "github-copilot/claude-opus-5.5", { activeAt: NOW - index * 1000 }));
    const { connect, calls } = fakeFleet({ "ws://alpha-local:7463": { sessions: many } });
    const fleet = await readFleet({ hosts: fleetHosts({ env, settings: { hosts: [] } }).map((host) => ({ ...host, bridge: undefined })), now: NOW, connect });
    assert.equal(fleet.nodes[0].daemon.sessions.length, 250);
    assert.equal(calls.filter((call) => call.method === "sessions.list").length, 3);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// The report

test("/fleet models without a pattern counts sessions by model", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect } = fakeFleet(endpoints());
    const result = await runFleet("models", { env, settings, connect, now: () => NOW, exec: cacoExec().exec });
    assert.match(result.text, /^Models in use: 8 sessions, 2 of 3 hosts read \(active within 30d, archived left out\)/);
    assert.match(result.text, /github-copilot\/gpt-6-astra\s+3 · 1 working · alpha, beta/);
    assert.match(result.text, /github-copilot\/gpt-6\.2-astra\s+1 · alpha-tui/);
    assert.match(result.text, /astra\/bonsai-2\s+1 · beta/);
    assert.match(result.text, /Not read:\n {2}gamma: offline/);
    assert.equal(result.output, result.text);
  } finally {
    cleanup();
  }
});

test("/fleet models PATTERN lists the sessions and flags the config defaults naming it", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect } = fakeFleet(endpoints());
    const { exec, runs } = cacoExec({ config: { agents: { defaults: { provider: "github-copilot", model: "gpt-6.2-astra" } }, interactive_defaults: { codex: { model: "gpt-6-astra" } } } });
    const result = await runFleet("models '*astra*'", { env, settings, connect, now: () => NOW, exec });
    const text = result.text;
    assert.match(text, /^\*astra\*: 4 sessions on 3 hosts, 2 of 3 hosts read/);
    assert.match(text, /alpha \(2\)\n {2}github-copilot\/gpt-6-astra · 1h · working · notes · chord-a1 · ~\/src\/chord-a1 · personal\n {2}github-copilot\/gpt-6-astra · 5d · Cacophony cacophony\/flow-1/);
    assert.match(text, /alpha-tui \(1\)\n {2}github-copilot\/gpt-6\.2-astra · 1h · pi-tui-1 · ~\/tui · tui/);
    assert.match(text, /beta \(1\)\n {2}github-copilot\/gpt-6-astra · 1h · chord-b1/);
    assert.doesNotMatch(text, /chord-b2|bonsai|chord-old/, "archived, the astra provider and old sessions are left out");
    assert.match(text, /settings\.json: defaultModel = gpt-6-astra/);
    assert.match(text, /pi-daemon profile on alpha: cacophony = github-copilot\/gpt-6-astra/);
    assert.match(text, /pi-daemon profile on beta: personal = github-copilot\/gpt-6-astra/);
    assert.match(text, /cacophony config: agents\.defaults\.model = gpt-6\.2-astra/);
    assert.match(text, /cacophony config: interactive_defaults\.codex\.model = gpt-6-astra/);
    assert.match(text, /Move them: \/fleet models '\*astra\*' --switch provider\/model/);
    assert.deepEqual(runs, [["caco", "config", "show", "--json"]]);
    const json = (await runFleet("models '*astra*' --json --archived --since all", { env, settings, connect, now: () => NOW, exec })).json;
    assert.deepEqual(json.sessions.map((row) => row.id).sort(), ["chord-a1", "chord-b1", "chord-b2", "chord-old", "flow-1", "pi-tui-1"]);
    assert.deepEqual(json.sessions.find((row) => row.id === "flow-1").cacophony, { project: "cacophony", agentId: "flow-1" });
    assert.ok(json.configDefaults.length >= 4);
  } finally {
    cleanup();
  }
});

test("filters: --host, --profile and --no-config", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect } = fakeFleet(endpoints());
    const { exec, runs } = cacoExec();
    const result = await runFleet("models *astra* --host alpha-tui --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.match(result.text, /^\*astra\*: 1 session on 1 host/);
    assert.match(result.text, /pi-tui-1/);
    assert.doesNotMatch(result.text, /Config defaults|No config default/);
    assert.equal(runs.length, 0);
    const cacophony = await runFleet("models *astra* --profile cacophony --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.match(cacophony.text, /^\*astra\*: 1 session on 1 host/);
    await assert.rejects(runFleet("models x --host nowhere", { env, settings, connect, now: () => NOW, exec }), /no host matches nowhere/);
  } finally {
    cleanup();
  }
});

test("caco absent: the Cacophony config check says so instead of failing", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect } = fakeFleet(endpoints());
    const exec = async () => ({ code: 1, stdout: "", stderr: "", spawnError: "ENOENT" });
    const result = await runFleet("models gpt-6.2-astra", { env, settings, connect, now: () => NOW, exec });
    assert.match(result.text, /Cacophony config not checked: caco is not installed here/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Switching

test("--switch moves each session, Cacophony agents through caco, and reads the fleet again", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const fleet = endpoints();
    const { connect, calls } = fakeFleet(fleet);
    const { exec, runs } = cacoExec({
      setModel: (agentId) => {
        // caco switches the runtime itself: as Cacophony would, over its own route.
        fleet["ws://alpha-local:7463"].sessions.find((row) => row.id === agentId).model = "github-copilot/claude-fable-5.2";
        return { data: { agent_id: agentId, effective_model: "github-copilot/claude-fable-5.2", metadata_updated: true } };
      },
    });
    const result = await runFleet("models '*astra*' --switch github-copilot/claude-fable-5.2 --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.equal(result.failed, false);
    assert.match(result.text, /chord-a1 · ~\/src\/chord-a1 · personal {2}→ switched \(chord\)/);
    assert.match(result.text, /Cacophony cacophony\/flow-1 {2}→ switched \(caco\)/);
    assert.match(result.text, /pi-tui-1 · ~\/tui · tui {2}→ switched \(chord\)/);
    assert.match(result.text, /Switch to github-copilot\/claude-fable-5\.2: 4 switched\./);
    assert.match(result.text, /Read again: no session in the window is on \*astra\* now\./);
    assert.deepEqual(runs, [["caco", "agent", "set-model", "--id", "flow-1", "--model", "github-copilot/claude-fable-5.2", "--json"]]);
    const configured = calls.filter((call) => call.method === "conversation.configure");
    assert.deepEqual(configured.map((call) => [call.url, call.params.sessionId, call.params.model]).sort(), [
      ["ws://alpha-local:7463", "chord-a1", { provider: "github-copilot", modelId: "claude-fable-5.2" }],
      ["ws://alpha-local:7464", "pi-tui-1", { provider: "github-copilot", modelId: "claude-fable-5.2" }],
      ["ws://beta:7463", "chord-b1", { provider: "github-copilot", modelId: "claude-fable-5.2" }],
    ]);
    assert.equal(fleet["ws://beta:7463"].sessions[1].model, "github-copilot/gpt-6-astra", "the archived session is untouched");
    assert.equal(result.json.remaining.length, 0);
  } finally {
    cleanup();
  }
});

test("a finished Cacophony agent falls back to /chord; a refusal is reported with --direct as the way", async () => {
  const { env, settings, cleanup } = setup();
  try {
    let { connect, calls } = fakeFleet(endpoints());
    const notResident = cacoExec({ setModel: () => ({ error: { code: "model_runtime_not_resident", message: "agent runtime is not resident (state=completed)" } }) });
    let result = await runFleet("models gpt-6-astra --profile cacophony --switch github-copilot/claude-fable-5.2 --no-config", { env, settings, connect, now: () => NOW, exec: notResident.exec });
    assert.match(result.text, /flow-1 {2}→ switched \(chord\); Cacophony: model_runtime_not_resident: its Cacophony record still names the old model/);
    assert.equal(calls.filter((call) => call.method === "conversation.configure").length, 1);

    ({ connect, calls } = fakeFleet(endpoints()));
    const forbidden = cacoExec({ setModel: () => ({ error: { code: "agent_model_control_forbidden", message: "changing another agent's model requires authorization capability agent_model_control" } }) });
    result = await runFleet("models gpt-6-astra --profile cacophony --switch github-copilot/claude-fable-5.2 --no-config", { env, settings, connect, now: () => NOW, exec: forbidden.exec });
    assert.equal(result.failed, true);
    assert.match(result.text, /→ failed \(caco\): caco agent set-model: agent_model_control_forbidden: .*\(an agent's caco may switch only itself; --direct switches its runtime over \/chord instead\)/);
    assert.doesNotMatch(result.text, /Read again/, "nothing moved, so nothing is read again");
    assert.equal(calls.filter((call) => call.method === "conversation.configure").length, 0);

    ({ connect, calls } = fakeFleet(endpoints()));
    const direct = cacoExec();
    result = await runFleet("models gpt-6-astra --profile cacophony --switch github-copilot/claude-fable-5.2 --direct --no-config", { env, settings, connect, now: () => NOW, exec: direct.exec });
    assert.match(result.text, /flow-1 {2}→ switched \(chord\)/);
    assert.equal(direct.runs.length, 0, "--direct never calls caco");
  } finally {
    cleanup();
  }
});

test("sessions in an agent's checkout that are not the agent move over /chord, never through caco", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect, calls } = fakeFleet(endpoints());
    const { exec, runs } = cacoExec();
    const result = await runFleet("models gpt-6-luna --switch github-copilot/claude-fable-5.2 --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.match(result.text, /chord-in-checkout · ~\/\.cacophony\/agents\/cacophony\/flow-1\/checkout · personal {2}→ switched \(chord\)/);
    assert.match(result.text, /pi-tui-2 · .* {2}→ switched \(chord\)/);
    assert.equal(runs.length, 0, "flow-1 itself is not touched");
    assert.deepEqual(calls.filter((call) => call.method === "conversation.configure").map((call) => call.params.sessionId).sort(), ["chord-in-checkout", "pi-tui-2"]);
  } finally {
    cleanup();
  }
});

test("Cacophony's catalog lacking the target fails the agent with the way round it", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect } = fakeFleet(endpoints());
    const { exec } = cacoExec({ setModel: () => ({ error: { code: "model_not_available", message: "model is not present in the configured/discovered catalog: github-copilot/claude-fable-5.2" } }) });
    const result = await runFleet("models gpt-6-astra --profile cacophony --switch github-copilot/claude-fable-5.2 --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.match(result.text, /model_not_available: .*\(Cacophony's model catalog lacks it: add it in cacophony-config, or --direct switches the runtime only\)/);
  } finally {
    cleanup();
  }
});

test("--switch checks the target against each host's catalog and the thinking level against the model", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const fleet = endpoints();
    fleet["ws://beta:7463"].catalog = CATALOG.filter((entry) => entry.modelId !== "claude-fable-5.2");
    fleet["ws://alpha-local:7464"].modelsError = "timeout: the TUI Pi session did not answer";
    const { connect, calls } = fakeFleet(fleet);
    let result = await runFleet("models gpt-6-astra gpt-6.2-astra --switch github-copilot/claude-fable-5.2 --direct --no-config", { env, settings, connect, now: () => NOW, exec: cacoExec().exec });
    assert.equal(result.failed, true);
    assert.match(result.text, /chord-b1 · ~\/src\/chord-b1 · personal {2}→ failed: github-copilot\/claude-fable-5\.2 is not in beta's personal model list/);
    assert.match(result.text, /pi-tui-1 · ~\/tui · tui {2}→ failed: cannot read its model list: timeout/);
    assert.match(result.text, /Switch to github-copilot\/claude-fable-5\.2: 2 switched, 2 failed\./);
    assert.match(result.text, /Still on gpt-6-astra gpt-6\.2-astra after the switch: 2 \(alpha-tui\/pi-tui-1, beta\/chord-b1\)\./);
    assert.ok(!calls.some((call) => call.method === "conversation.configure" && ["chord-b1", "pi-tui-1"].includes(call.params.sessionId)));

    result = await runFleet("models gpt-6-astra --host alpha --switch github-copilot/claude-opus-5.5 --thinking max --direct --no-config", { env, settings, connect: fakeFleet(endpoints()).connect, now: () => NOW, exec: cacoExec().exec });
    assert.match(result.text, /→ failed: github-copilot\/claude-opus-5\.5 has no thinking level max/);
  } finally {
    cleanup();
  }
});

test("--dry-run says how each would move and changes nothing; a bare target resolves when one provider has it", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect, calls } = fakeFleet(endpoints());
    const { exec, runs } = cacoExec();
    const result = await runFleet("models gpt-6-astra --switch claude-fable-5.2 --dry-run --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.match(result.text, /chord-a1 .* → would switch \(chord\)/);
    assert.match(result.text, /flow-1 {2}→ would switch \(caco\)/);
    assert.match(result.text, /Dry run to github-copilot\/claude-fable-5\.2: 3 would switch\./);
    assert.equal(calls.filter((call) => call.method === "conversation.configure").length, 0);
    assert.equal(runs.length, 0);
    await assert.rejects(runFleet("models gpt-6-astra --switch nosuch --no-config", { env, settings, connect, now: () => NOW, exec }), /no provider on alpha has that model/);
  } finally {
    cleanup();
  }
});

test("--thinking with a Cacophony agent sets the level over /chord after caco moves the model", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const fleet = endpoints();
    const { connect, calls } = fakeFleet(fleet);
    const { exec } = cacoExec();
    await runFleet("models gpt-6-astra --profile cacophony --switch github-copilot/claude-fable-5.2 --thinking high --no-config", { env, settings, connect, now: () => NOW, exec });
    assert.deepEqual(calls.filter((call) => call.method === "conversation.configure").map((call) => call.params), [{ sessionId: "flow-1", thinkingLevel: "high" }]);
  } finally {
    cleanup();
  }
});

test("a session already on the target is left as it is", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect, calls } = fakeFleet(endpoints());
    const result = await runFleet("models 'claude-*' --host alpha --switch github-copilot/claude-opus-5.5 --no-config", { env, settings, connect, now: () => NOW, exec: cacoExec().exec });
    assert.match(result.text, /chord-a2 .* → already on it/);
    assert.match(result.text, /: 1 already on it\./);
    assert.equal(calls.filter((call) => call.method === "conversation.configure").length, 0);
  } finally {
    cleanup();
  }
});

test("no session matches: --switch says there was nothing to do", async () => {
  const { env, settings, cleanup } = setup();
  try {
    const { connect } = fakeFleet(endpoints());
    const result = await runFleet("models gpt-9 --switch github-copilot/claude-fable-5.2 --no-config", { env, settings, connect, now: () => NOW, exec: cacoExec().exec });
    assert.match(result.text, /^gpt-9: 0 sessions on 0 hosts/);
    assert.match(result.text, /Switch to github-copilot\/claude-fable-5\.2: nothing to do\./);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Surfaces

test("the TUI/pi-client extension registers /fleet and notifies the report", async () => {
  const registered = {};
  const pi = { registerCommand: (name, options) => (registered[name] = options) };
  fleetExtension(pi, { env: { PI_CODING_AGENT_DIR: "/nonexistent" }, runFleet: async () => ({ output: "report", failed: false }) });
  assert.match(registered.fleet.description, /fleet/);
  assert.deepEqual(registered.fleet.getArgumentCompletions("mo").map((item) => item.value), ["models"]);
  const notes = [];
  const statuses = [];
  const ctx = { ui: { notify: (text, level) => notes.push([text, level]), setStatus: (key, text) => statuses.push([key, text]) } };
  await registered.fleet.handler("models", ctx);
  assert.deepEqual(notes, [["report", "info"]]);
  assert.deepEqual(statuses.at(-1), ["agent-utils-fleet", undefined]);
  const failing = createFleetHandler({ runFleet: async () => { throw new Error("bad pattern /(/"); } });
  await failing("models /(/", ctx);
  assert.match(notes.at(-1)[0], /^\/fleet: bad pattern[\s\S]*\/fleet models \[PATTERN…\]/);
  assert.equal(notes.at(-1)[1], "error");
  const warned = createFleetHandler({ runFleet: async (_args, deps) => { deps.progress("Reading 3 hosts…"); return { output: "x", failed: true }; } });
  await warned("models x --switch a/b", ctx);
  assert.deepEqual(notes.at(-1), ["x", "warning"]);
  assert.ok(statuses.some(([, text]) => text === "⇄ Reading 3 hosts…"));
});

test("the pi-daemon module runs /fleet and splits a long report into notices", async () => {
  assert.equal(typeof commands.fleet.run, "function");
  const notes = [];
  const command = createFleetCommand({ env: {}, runFleet: async () => ({ output: Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"), failed: false }) });
  await command.run("models", { notify: (text) => notes.push(text) });
  assert.ok(notes.length > 1 && notes.length <= MAX_NOTICES);
  assert.ok(notes.every((note) => note.length <= 16 * 1024 && note.startsWith("```text\n") && note.endsWith("\n```")), "plain-text blocks within pi-daemon's notice size");
  assert.equal(notes.map((note) => note.slice(8, -4)).join("\n").split("\n").length, 3000);
  assert.deepEqual(noticesOf("*astra*\n```x"), ["```text\n*astra*\n\u200b```x\n```"], "a fence inside the report cannot close the block");
  const huge = noticesOf(Array.from({ length: 40_000 }, (_, i) => `line ${i} ${"y".repeat(20)}`).join("\n"));
  assert.equal(huge.length, MAX_NOTICES);
  assert.match(huge.at(-1), /more lines did not fit in this session's notices/);
  const errors = [];
  await createFleetCommand({ env: {}, runFleet: async () => { throw new Error("unknown option --x"); } }).run("models --x", { notify: (text) => errors.push(text) });
  assert.match(errors[0], /^\/fleet: unknown option --x/);
});

test("completions offer the subcommand, options, and enabled models after --switch", () => {
  const models = ["github-copilot/claude-fable-5.2", "github-copilot/claude-opus-5.5"];
  assert.deepEqual(fleetCompletions("", { models }).map((item) => item.label), ["models", "help"]);
  assert.deepEqual(fleetCompletions("models *astra* --switch github-copilot/claude-f", { models }).map((item) => item.value), ["models *astra* --switch github-copilot/claude-fable-5.2"]);
  assert.deepEqual(fleetCompletions("models --sin", { models }).map((item) => item.label), ["--since"]);
  assert.deepEqual(fleetCompletions("models x --since ", { models }).map((item) => item.label), ["7d", "30d", "90d", "all"]);
  assert.equal(fleetCompletions("models zzz", { models }), null);
});

test("chunkText keeps lines whole within the limit", () => {
  assert.deepEqual(chunkText("a\nb\nc", 3), ["a\nb", "c"]);
  assert.deepEqual(chunkText(""), [""]);
  assert.equal(chunkText("x".repeat(10), 5)[0], "xxxx…");
});
