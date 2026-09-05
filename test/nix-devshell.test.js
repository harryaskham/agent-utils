import test from "node:test";
import assert from "node:assert/strict";

import { DEVSHELL_FAILURE_HINT, devShellInstallable, flakeDeclaresDevShell, nixDevelopArgs, normalizeDevShellName, parseNullEnvironment, sanitizeDevShellEnvironment, shellQuote, wrapCommandForDevShell } from "../extensions/lib/nix-devshell.js";
import { createNixDevshellExtension } from "../extensions/lib/nix-devshell-extension.js";

test("devshell names and argv are strict and deterministic", () => {
  assert.equal(normalizeDevShellName(), null);
  assert.equal(normalizeDevShellName("default"), null);
  assert.equal(normalizeDevShellName("ci-tools"), "ci-tools");
  assert.throws(() => normalizeDevShellName("x --option"), /devshell name/);
  assert.equal(devShellInstallable("ci"), ".#ci");
  assert.deepEqual(nixDevelopArgs(null, ["true"]), ["develop", "--command", "true"]);
  assert.deepEqual(nixDevelopArgs("ci", ["bash", "-c", "echo ok"]), ["develop", ".#ci", "--command", "bash", "-c", "echo ok"]);
});

test("devshell declaration detection ignores comments and recognizes flake outputs", () => {
  assert.equal(flakeDeclaresDevShell("# devShells.default = fake"), false);
  assert.equal(flakeDeclaresDevShell("outputs = { self }: { devShells.x86_64-linux.default = value; };"), true);
  assert.equal(flakeDeclaresDevShell("devShell = pkgs.mkShell {};"), true);
});

test("captured Nix environments and one-off shell quoting are lossless", () => {
  assert.deepEqual(parseNullEnvironment("PATH=/nix/bin\0TOKEN=a=b\0\0"), { PATH: "/nix/bin", TOKEN: "a=b" });
  assert.deepEqual(sanitizeDevShellEnvironment({ PATH: "/nix/bin", PWD: "/temporary", TMPDIR: "/gone", KEEP: "yes" }), { PATH: "/nix/bin", KEEP: "yes" });
  assert.equal(shellQuote("echo 'hi'"), `'echo '"'"'hi'"'"''`);
  assert.equal(wrapCommandForDevShell("pwd && echo 'hi'", "ci"), `nix develop '.#ci' --command bash -c 'pwd && echo '"'"'hi'"'"''`);
});

function harness(run) {
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const notices = [];
  const statuses = [];
  let spawnHook;
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    on(name, handler) { handlers.set(name, handler); },
  };
  createNixDevshellExtension({
    run,
    localBashOperations: () => ({ exec: async () => ({}) }),
    createBashToolFactory: (_cwd, options) => {
      spawnHook = options.spawnHook;
      return { name: "bash", label: "Bash", parameters: {}, execute: async () => ({ content: [], details: {} }) };
    },
  })(pi);
  const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => `test-${Math.random()}` }, ui: { notify: (message, level) => notices.push({ message, level }), setStatus: (...args) => statuses.push(args) } };
  return { tools, commands, handlers, notices, statuses, ctx, getSpawnHook: () => spawnHook };
}

test("enable captures the environment once, routes later Bash through it, and disable restores it", async () => {
  const calls = [];
  const h = harness(async (options) => { calls.push(options); return { exitCode: 0, stdout: "PATH=/nix/ci/bin\0DEV_MARKER=ready\0", stderr: "", truncated: false }; });
  await h.handlers.get("session_start")({}, h.ctx);
  const enabled = await h.tools.get("nix_devshell_enable").execute("1", { devshell: "ci" }, undefined, undefined, h.ctx);
  assert.equal(enabled.isError, undefined);
  assert.deepEqual(calls[0].command, ["env", "-0"]);
  assert.equal(calls[0].cwd, "/repo");

  const hooked = h.getSpawnHook()({ command: "pwd", cwd: "/repo", env: { PATH: "/usr/bin", PI_SESSION_ID: "s" } });
  assert.equal(hooked.command, "pwd");
  assert.equal(hooked.cwd, "/repo");
  assert.equal(hooked.env.PATH, "/nix/ci/bin");
  assert.equal(hooked.env.DEV_MARKER, "ready");
  assert.equal(hooked.env.PI_SESSION_ID, "s");

  await h.tools.get("nix_devshell_disable").execute("2", {}, undefined, undefined, h.ctx);
  const original = { PATH: "/usr/bin" };
  assert.equal(h.getSpawnHook()({ command: "pwd", cwd: "/repo", env: original }).env, original);
});

test("bash_devshell is one-shot and does not enable global routing", async () => {
  const calls = [];
  const h = harness(async (options) => { calls.push(options); return { exitCode: 0, stdout: "ok\n", stderr: "", truncated: false }; });
  await h.handlers.get("session_start")({}, h.ctx);
  const result = await h.tools.get("bash_devshell").execute("1", { command: "echo ok", devshell: "lint", timeoutMs: 50 }, undefined, undefined, h.ctx);
  assert.equal(result.content[0].text, "ok\n");
  assert.deepEqual(calls[0].command, ["bash", "-c", "echo ok"]);
  assert.equal(calls[0].name, "lint");
  const original = { PATH: "/usr/bin" };
  assert.equal(h.getSpawnHook()({ command: "pwd", cwd: "/repo", env: original }).env, original);
});

test("the first failed Bash result gets one devshell hint when a flake declares one", async () => {
  const h = harness(async () => ({ exitCode: 0, stdout: "", stderr: "", truncated: false }));
  h.ctx.cwd = process.cwd();
  await h.handlers.get("session_start")({}, h.ctx);
  const first = h.handlers.get("tool_result")({ toolName: "bash", isError: true, content: [{ type: "text", text: "missing command" }] }, h.ctx);
  assert.equal(first.content.at(-1).text, DEVSHELL_FAILURE_HINT);
  const second = h.handlers.get("tool_result")({ toolName: "bash", isError: true, content: [] }, h.ctx);
  assert.equal(second, undefined);
});

test("/nix devshell reports initialization failure without enabling", async () => {
  const h = harness(async () => ({ exitCode: 1, stdout: "", stderr: "flake missing", truncated: false }));
  await h.handlers.get("session_start")({}, h.ctx);
  await h.commands.get("nix").handler("devshell", h.ctx);
  assert.match(h.notices.at(-1).message, /flake missing/);
  const original = { PATH: "/usr/bin" };
  assert.equal(h.getSpawnHook()({ command: "pwd", cwd: "/repo", env: original }).env, original);
});
