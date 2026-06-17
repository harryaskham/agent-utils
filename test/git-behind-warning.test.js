import assert from "node:assert/strict";
import test from "node:test";

import gitBehindWarningExtension, { __gitBehindTest } from "../extensions/git-behind-warning.js";
import {
  CUSTOM_TYPE,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_EVERY_TURNS,
  DEFAULT_FETCH_CACHE_MS,
  DEFAULT_THRESHOLD,
  createRuntimeState,
  decideFetch,
  decideTurnTrigger,
  decideWarn,
  extractGitBehindSettings,
  formatWarning,
  isGitCommand,
  makeGitRunner,
  parseBehindCount,
  parseBool,
  parsePositiveInt,
  resolveConfig,
  resolveDefaultBranch,
  runGitBehindCheck,
  stripRemotePrefix,
  summarizeResult,
} from "../extensions/lib/git-behind.js";

// ---- fake git runner --------------------------------------------------------

// Build a fake runGit that dispatches on the joined argv. `routes` maps a
// substring of the joined args to a { code, stdout, stderr } response (or a
// function). Records every call.
function makeFakeGit(routes = {}) {
  const calls = [];
  const runGit = async (args, opts) => {
    const key = args.join(" ");
    calls.push({ args, key, opts });
    for (const [match, response] of Object.entries(routes)) {
      if (key.includes(match)) {
        const r = typeof response === "function" ? response(args, opts) : response;
        return { code: 0, stdout: "", stderr: "", ...r };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  runGit.calls = calls;
  return runGit;
}

const REPO_OK = {
  "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
  "symbolic-ref --quiet HEAD": { code: 0, stdout: "refs/heads/feature\n" },
  "symbolic-ref --quiet refs/remotes/origin/HEAD": { code: 0, stdout: "refs/remotes/origin/main\n" },
};

// ---- pure helpers -----------------------------------------------------------

test("parseBool understands truthy/falsey words and falls back", () => {
  assert.equal(parseBool("true", false), true);
  assert.equal(parseBool("OFF", true), false);
  assert.equal(parseBool("no", true), false);
  assert.equal(parseBool("1", false), true);
  assert.equal(parseBool(undefined, true), true);
  assert.equal(parseBool("", true), true);
  assert.equal(parseBool("maybe", true), true);
  assert.equal(parseBool(false, true), false);
});

test("parsePositiveInt parses and guards minimum", () => {
  assert.equal(parsePositiveInt("30", 10), 30);
  assert.equal(parsePositiveInt("0", 10, 1), 10);
  assert.equal(parsePositiveInt("-5", 10, 1), 10);
  assert.equal(parsePositiveInt("abc", 10), 10);
  assert.equal(parsePositiveInt(undefined, 10), 10);
  assert.equal(parsePositiveInt("0", 10, 0), 0);
});

test("isGitCommand matches git at command positions, not substrings", () => {
  assert.equal(isGitCommand("git status"), true);
  assert.equal(isGitCommand("git"), true);
  assert.equal(isGitCommand("cd /x && git fetch origin"), true);
  assert.equal(isGitCommand("sudo git pull"), true);
  assert.equal(isGitCommand("ls && git log | head"), true);
  assert.equal(isGitCommand("(git rev-parse HEAD)"), true);
  assert.equal(isGitCommand("digit_count=3"), false);
  assert.equal(isGitCommand("legitimate work"), false);
  assert.equal(isGitCommand("echo nogit"), false);
  assert.equal(isGitCommand(""), false);
  assert.equal(isGitCommand(undefined), false);
});

test("stripRemotePrefix handles fully-qualified and abbreviated refs", () => {
  assert.equal(stripRemotePrefix("refs/remotes/origin/main", "origin"), "main");
  assert.equal(stripRemotePrefix("origin/develop", "origin"), "develop");
  assert.equal(stripRemotePrefix("upstream/trunk", "upstream"), "trunk");
  assert.equal(stripRemotePrefix("refs/heads/main", "origin"), undefined);
  assert.equal(stripRemotePrefix("", "origin"), undefined);
});

test("parseBehindCount only accepts clean integers", () => {
  assert.equal(parseBehindCount("42\n"), 42);
  assert.equal(parseBehindCount("0"), 0);
  assert.equal(parseBehindCount(" 7 "), 7);
  assert.equal(parseBehindCount("fatal: bad revision"), null);
  assert.equal(parseBehindCount(""), null);
});

test("throttle decisions respect cache and cooldown windows", () => {
  assert.equal(decideFetch(1000, null, 5000), true);
  assert.equal(decideFetch(1000, 0, 5000), false);
  assert.equal(decideFetch(6000, 0, 5000), true);
  assert.equal(decideWarn(1000, null, 5000), true);
  assert.equal(decideWarn(1000, 0, 5000), false);
  assert.equal(decideWarn(6000, 0, 5000), true);
  assert.equal(decideTurnTrigger(9, 10), false);
  assert.equal(decideTurnTrigger(10, 10), true);
  assert.equal(decideTurnTrigger(11, 10), true);
});

test("extractGitBehindSettings honors agentUtils.gitBehindWarning and alias", () => {
  assert.deepEqual(extractGitBehindSettings({ agentUtils: { gitBehindWarning: { threshold: 5 } } }), { threshold: 5 });
  assert.deepEqual(extractGitBehindSettings({ agentUtils: { gitBehind: { remote: "up" } } }), { remote: "up" });
  assert.deepEqual(extractGitBehindSettings({}), {});
});

// ---- config resolution ------------------------------------------------------

test("resolveConfig uses defaults when nothing configured", () => {
  const cfg = resolveConfig({ env: {}, settings: {} });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.threshold, DEFAULT_THRESHOLD);
  assert.equal(cfg.defaultBranch, undefined);
  assert.equal(cfg.remote, "origin");
  assert.equal(cfg.everyTurns, DEFAULT_EVERY_TURNS);
  assert.equal(cfg.cooldownMs, DEFAULT_COOLDOWN_MS);
  assert.equal(cfg.fetchCacheMs, DEFAULT_FETCH_CACHE_MS);
  assert.equal(cfg.nudge, true);
});

test("resolveConfig: env overrides settings overrides defaults", () => {
  const settings = { threshold: 5, remote: "upstream", branch: "trunk", enabled: false, nudge: false };
  const env = {
    AGENT_UTILS_GIT_BEHIND_THRESHOLD: "50",
    AGENT_UTILS_GIT_BEHIND_WARNING: "true",
  };
  const cfg = resolveConfig({ env, settings });
  assert.equal(cfg.threshold, 50, "env wins over settings");
  assert.equal(cfg.remote, "upstream", "settings wins over default");
  assert.equal(cfg.defaultBranch, "trunk");
  assert.equal(cfg.enabled, true, "env re-enables despite settings.enabled=false");
  assert.equal(cfg.nudge, false, "settings nudge=false respected when no env override");
});

test("resolveConfig disables via env", () => {
  assert.equal(resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_WARNING: "0" }, settings: {} }).enabled, false);
});

// ---- default branch resolution ---------------------------------------------

test("resolveDefaultBranch: explicit override short-circuits", async () => {
  const runGit = makeFakeGit({});
  const info = await resolveDefaultBranch({ runGit, remote: "origin", override: "release" });
  assert.deepEqual(info, { branch: "release", source: "override" });
  assert.equal(runGit.calls.length, 0, "no git calls when overridden");
});

test("resolveDefaultBranch: symbolic-ref then abbrev then probe", async () => {
  const sym = makeFakeGit({ "symbolic-ref --quiet refs/remotes/origin/HEAD": { code: 0, stdout: "refs/remotes/origin/main\n" } });
  assert.deepEqual(await resolveDefaultBranch({ runGit: sym, remote: "origin" }), { branch: "main", source: "symbolic-ref" });

  const abbrev = makeFakeGit({
    "symbolic-ref --quiet refs/remotes/origin/HEAD": { code: 1 },
    "rev-parse --abbrev-ref origin/HEAD": { code: 0, stdout: "origin/develop\n" },
  });
  assert.deepEqual(await resolveDefaultBranch({ runGit: abbrev, remote: "origin" }), { branch: "develop", source: "abbrev-ref" });

  const probe = makeFakeGit({
    "symbolic-ref --quiet refs/remotes/origin/HEAD": { code: 1 },
    "rev-parse --abbrev-ref origin/HEAD": { code: 128 },
    "show-ref --verify --quiet refs/remotes/origin/main": { code: 1 },
    "show-ref --verify --quiet refs/remotes/origin/master": { code: 0 },
  });
  assert.deepEqual(await resolveDefaultBranch({ runGit: probe, remote: "origin" }), { branch: "master", source: "probe" });
});

test("resolveDefaultBranch: returns null when undetectable", async () => {
  const runGit = makeFakeGit({
    "symbolic-ref": { code: 1 },
    "rev-parse --abbrev-ref": { code: 128 },
    "show-ref": { code: 1 },
  });
  assert.equal(await resolveDefaultBranch({ runGit, remote: "origin" }), null);
});

// ---- full check -------------------------------------------------------------

test("runGitBehindCheck: disabled is a no-op", async () => {
  const runGit = makeFakeGit({});
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_WARNING: "0" } }), state: createRuntimeState() });
  assert.equal(result.status, "disabled");
  assert.equal(runGit.calls.length, 0);
});

test("runGitBehindCheck: graceful no-op when not a git repo", async () => {
  const runGit = makeFakeGit({ "rev-parse --is-inside-work-tree": { code: 128, stderr: "not a git repository" } });
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({}), state: createRuntimeState() });
  assert.equal(result.status, "not-a-git-repo");
});

test("runGitBehindCheck: graceful no-op on detached HEAD", async () => {
  const runGit = makeFakeGit({
    "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
    "symbolic-ref --quiet HEAD": { code: 1 },
  });
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({}), state: createRuntimeState() });
  assert.equal(result.status, "detached-head");
});

test("runGitBehindCheck: no-default-branch when origin/HEAD undetectable", async () => {
  const runGit = makeFakeGit({
    "rev-parse --is-inside-work-tree": { code: 0, stdout: "true\n" },
    "symbolic-ref --quiet HEAD": { code: 0, stdout: "refs/heads/x\n" },
    "symbolic-ref --quiet refs/remotes/origin/HEAD": { code: 1 },
    "rev-parse --abbrev-ref origin/HEAD": { code: 128 },
    "show-ref": { code: 1 },
  });
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({}), state: createRuntimeState() });
  assert.equal(result.status, "no-default-branch");
});

test("runGitBehindCheck: no-upstream when rev-list cannot count", async () => {
  const runGit = makeFakeGit({
    ...REPO_OK,
    "rev-list --count HEAD..origin/main": { code: 128, stdout: "", stderr: "unknown revision" },
  });
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({}), state: createRuntimeState() });
  assert.equal(result.status, "no-upstream");
  assert.equal(result.branch, "main");
});

test("runGitBehindCheck: below threshold does not warn", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "3\n" } });
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_THRESHOLD: "25" } }), state: createRuntimeState() });
  assert.equal(result.status, "ok");
  assert.equal(result.behind, 3);
  assert.equal(result.overThreshold, false);
  assert.equal(result.warn, false);
});

test("runGitBehindCheck: at/over threshold warns and records cooldown", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const state = createRuntimeState();
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_THRESHOLD: "25" } });
  const result = await runGitBehindCheck({ runGit, config, state, now: 1_000 });
  assert.equal(result.overThreshold, true);
  assert.equal(result.warn, true);
  assert.equal(state.lastWarnAt, 1_000);
  assert.equal(state.lastBehind, 40);
  assert.equal(state.lastBranch, "main");
});

test("runGitBehindCheck: fetch is cached across back-to-back checks", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const state = createRuntimeState();
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_FETCH_CACHE_MS: "5000" } });

  await runGitBehindCheck({ runGit, config, state, now: 0 });
  const fetchesAfterFirst = runGit.calls.filter((c) => c.key.startsWith("fetch")).length;
  assert.equal(fetchesAfterFirst, 1, "first check fetches");

  await runGitBehindCheck({ runGit, config, state, now: 1_000 }); // within cache window
  const fetchesAfterSecond = runGit.calls.filter((c) => c.key.startsWith("fetch")).length;
  assert.equal(fetchesAfterSecond, 1, "second check within cache window does not re-fetch");

  await runGitBehindCheck({ runGit, config, state, now: 10_000 }); // past cache window
  const fetchesAfterThird = runGit.calls.filter((c) => c.key.startsWith("fetch")).length;
  assert.equal(fetchesAfterThird, 2, "third check past cache window fetches again");
});

test("runGitBehindCheck: warn cooldown suppresses repeat warnings", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const state = createRuntimeState();
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_THRESHOLD: "10", AGENT_UTILS_GIT_BEHIND_COOLDOWN_MS: "60000", AGENT_UTILS_GIT_BEHIND_FETCH_CACHE_MS: "0" } });

  const first = await runGitBehindCheck({ runGit, config, state, now: 0 });
  assert.equal(first.warn, true);
  const second = await runGitBehindCheck({ runGit, config, state, now: 30_000 });
  assert.equal(second.overThreshold, true);
  assert.equal(second.warn, false, "still in cooldown");
  const third = await runGitBehindCheck({ runGit, config, state, now: 70_000 });
  assert.equal(third.warn, true, "cooldown elapsed");
});

test("runGitBehindCheck: continues with cached ref when fetch fails", async () => {
  const runGit = makeFakeGit({
    ...REPO_OK,
    "fetch --quiet origin main": { code: 1, stderr: "network down" },
    "rev-list --count HEAD..origin/main": { code: 0, stdout: "30\n" },
  });
  const result = await runGitBehindCheck({ runGit, config: resolveConfig({}), state: createRuntimeState() });
  assert.equal(result.status, "ok");
  assert.equal(result.behind, 30);
  assert.equal(result.fetchFailed, true);
  assert.equal(result.fetched, false);
});

// ---- formatting -------------------------------------------------------------

test("formatWarning is advisory and includes a rebase nudge", () => {
  const msg = formatWarning({ behind: 12, remote: "origin", branch: "main", threshold: 5 });
  assert.match(msg, /12 commits behind origin\/main/);
  assert.match(msg, /git fetch origin && git rebase origin\/main/);
  assert.match(msg, /caco agent rebase/);
  assert.match(msg, /advisory/);
  // singular
  assert.match(formatWarning({ behind: 1, remote: "origin", branch: "main", threshold: 1 }), /1 commit behind/);
});

test("summarizeResult covers each status", () => {
  assert.match(summarizeResult(null), /no check/);
  assert.equal(summarizeResult({ status: "disabled" }), "disabled");
  assert.match(summarizeResult({ status: "not-a-git-repo" }), /not a git repository/);
  assert.match(summarizeResult({ status: "detached-head" }), /detached HEAD/);
  assert.match(summarizeResult({ status: "no-default-branch", remote: "origin" }), /default branch/);
  assert.match(summarizeResult({ status: "no-upstream", remote: "origin", branch: "main" }), /tracking ref/);
  assert.match(summarizeResult({ status: "ok", behind: 40, remote: "origin", branch: "main", overThreshold: true }), />= threshold/);
  assert.match(summarizeResult({ status: "ok", behind: 1, remote: "origin", branch: "main", overThreshold: false }), /up to date enough/);
});

// ---- real runner ------------------------------------------------------------

test("makeGitRunner maps success and ENOENT without throwing", async () => {
  const ok = makeGitRunner({
    execImpl: (cmd, args, opts, cb) => cb(null, "true\n", ""),
  });
  assert.deepEqual(await ok(["rev-parse"]), { code: 0, stdout: "true\n", stderr: "" });

  const enoent = makeGitRunner({
    execImpl: (cmd, args, opts, cb) => cb(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "", ""),
  });
  const r = await enoent(["status"]);
  assert.equal(r.code, 127, "string errno maps to 127");

  const failed = makeGitRunner({
    execImpl: (cmd, args, opts, cb) => cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "boom"),
  });
  assert.deepEqual(await failed(["fetch"]), { code: 1, stdout: "", stderr: "boom" });
});

// ---- extension wiring -------------------------------------------------------

function makeHarness({ runGit, config } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const sent = [];
  const statuses = [];
  const notifications = [];
  const pi = {
    on(event, handler) { handlers.set(event, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message, options) { sent.push({ message, options }); },
  };
  const ctx = {
    cwd: process.cwd(),
    ui: {
      notify(message, level) { notifications.push({ message, level }); },
      setStatus(key, text) { statuses.push({ key, text }); },
    },
  };
  gitBehindWarningExtension(pi, { runGit, config });
  return { handlers, commands, sent, statuses, notifications, ctx };
}

test("extension registers tool_call, turn_end, session, and command surfaces", () => {
  const { handlers, commands } = makeHarness();
  assert.equal(typeof handlers.get("tool_call"), "function");
  assert.equal(typeof handlers.get("turn_end"), "function");
  assert.equal(typeof handlers.get("session_start"), "function");
  assert.equal(typeof handlers.get("session_shutdown"), "function");
  assert.ok(commands.has("git-behind"));
});

test("tool_call on a git command triggers a throttled check and surfaces a warning", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_THRESHOLD: "10" } });
  const h = makeHarness({ runGit, config });

  await h.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, h.ctx);
  // fire-and-forget: let the microtask chain settle
  await new Promise((r) => setTimeout(r, 10));

  assert.ok(h.notifications.some((n) => /behind origin\/main/.test(n.message) && n.level === "warning"));
  assert.ok(h.statuses.some((s) => s.key === "git-behind" && /⚠ 40 behind/.test(s.text)));
  assert.equal(h.sent.length, 1, "nudge message injected once");
  assert.equal(h.sent[0].message.customType, CUSTOM_TYPE);
  assert.equal(h.sent[0].options.deliverAs, "followUp");
});

test("tool_call ignores non-git bash and non-bash tools", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const h = makeHarness({ runGit, config: resolveConfig({}) });

  await h.handlers.get("tool_call")({ toolName: "bash", input: { command: "echo hello" } }, h.ctx);
  await h.handlers.get("tool_call")({ toolName: "read", input: { path: "git.txt" } }, h.ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runGit.calls.length, 0, "no checks for non-git bash or non-bash tool");
});

test("turn_end fires only every N turns", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "1\n" } });
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_EVERY_TURNS: "3" } });
  const h = makeHarness({ runGit, config });
  const turnEnd = h.handlers.get("turn_end");

  await turnEnd({}, h.ctx);
  await turnEnd({}, h.ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runGit.calls.length, 0, "no check before reaching cadence");

  await turnEnd({}, h.ctx); // 3rd turn -> fires
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(runGit.calls.length > 0, "check fires on the Nth turn");
});

test("disabled config makes tool_call and turn_end no-ops", async () => {
  const runGit = makeFakeGit({ ...REPO_OK });
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_WARNING: "0" } });
  const h = makeHarness({ runGit, config });
  await h.handlers.get("tool_call")({ toolName: "bash", input: { command: "git fetch" } }, h.ctx);
  await h.handlers.get("turn_end")({}, h.ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runGit.calls.length, 0);
});

test("nudge=false surfaces a notify but injects no message", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_THRESHOLD: "10", AGENT_UTILS_GIT_BEHIND_NUDGE: "0" } });
  const h = makeHarness({ runGit, config });
  await h.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, h.ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(h.notifications.some((n) => n.level === "warning"));
  assert.equal(h.sent.length, 0, "no message injected when nudge disabled");
});

test("/git-behind command: status, check, on/off toggle", async () => {
  const runGit = makeFakeGit({ ...REPO_OK, "rev-list --count HEAD..origin/main": { code: 0, stdout: "40\n" } });
  const config = resolveConfig({ env: { AGENT_UTILS_GIT_BEHIND_THRESHOLD: "10" } });
  const h = makeHarness({ runGit, config });
  const cmd = h.commands.get("git-behind").handler;

  await cmd("status", h.ctx);
  assert.ok(h.notifications.some((n) => /threshold=10/.test(n.message)));

  await cmd("check", h.ctx);
  assert.ok(h.notifications.some((n) => /behind/.test(n.message) && n.level === "warning"));

  await cmd("off", h.ctx);
  assert.ok(h.notifications.some((n) => /disabled/.test(n.message)));
  const callsBefore = runGit.calls.length;
  await h.handlers.get("tool_call")({ toolName: "bash", input: { command: "git status" } }, h.ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(runGit.calls.length, callsBefore, "disabled at runtime → no check");

  await cmd("on", h.ctx);
  assert.ok(h.notifications.some((n) => /enabled/.test(n.message)));
});

test("formatConfig and settings loader are exported for inspection", () => {
  assert.equal(typeof __gitBehindTest.formatConfig, "function");
  assert.equal(typeof __gitBehindTest.loadSettingsSlice, "function");
  assert.equal(typeof __gitBehindTest.resolveEffectiveConfig, "function");
  assert.match(__gitBehindTest.formatConfig(resolveConfig({})), /enabled=true threshold=25/);
});

test("package advertises the git-behind-warning extension", async () => {
  const pkg = await import("../package.json", { with: { type: "json" } });
  assert.ok(pkg.default.pi.extensions.includes("./extensions/git-behind-warning.js"));
});
