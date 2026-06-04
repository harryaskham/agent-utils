import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TENDRIL_COMMAND,
  tendrilBridgeConfig,
  buildTendrilCommand,
  resolveTendrilSubcommand,
  tendrilCommandSummary,
  tendrilSourceMachine,
} from "../extensions/tendril-command.js";

// bd-a4f693: native hooks for the Tendril --remote flag layer. These tests pin
// the command-building and source-machine resolution that downstream capture +
// inference attribution (bd-668a82) consumes.

test("tendrilBridgeConfig reads remote/wslTunnel from env and reports source", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev", AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" };
  assert.deepEqual(tendrilBridgeConfig(env, {}), {
    command: DEFAULT_TENDRIL_COMMAND,
    remote: "ms-dev",
    wslTunnel: true,
    remoteSource: "env",
    wslTunnelSource: "env",
  });
});

test("tendrilBridgeConfig per-call overrides win over env", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev", AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" };
  const overridden = tendrilBridgeConfig(env, { remote: "astra", wslTunnel: false });
  assert.equal(overridden.remote, "astra");
  assert.equal(overridden.wslTunnel, false);
  assert.equal(overridden.remoteSource, "override");
  assert.equal(overridden.wslTunnelSource, "override");

  // Empty-string remote override forces the local bridge even when env sets one.
  const local = tendrilBridgeConfig(env, { remote: "" });
  assert.equal(local.remote, "");
  assert.equal(local.remoteSource, "override");
});

test("buildTendrilCommand prefixes --remote and --wsl-tunnel native hooks", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev", AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" };
  const built = buildTendrilCommand(["list", "--json"], env, {});
  assert.deepEqual(built.args, ["--remote", "ms-dev", "--wsl-tunnel", "list", "--json"]);
  assert.equal(built.remote, "ms-dev");
  assert.equal(built.wslTunnel, true);

  // Local bridge: no remote/tunnel prefix is injected.
  const localBuilt = buildTendrilCommand(["capture"], {}, {});
  assert.deepEqual(localBuilt.args, ["capture"]);
  assert.equal(localBuilt.remote, null);
});

test("resolveTendrilSubcommand finds the subcommand independent of bridge-prefix flags (bd-5bc6e5)", () => {
  // Bare argv.
  assert.equal(resolveTendrilSubcommand(["list", "--json"]), "list");
  assert.equal(resolveTendrilSubcommand(["capture", "--window", "4"]), "capture");

  // The exact argv buildTendrilCommand produces with each bridge prefix must
  // still resolve to the real subcommand (args[0] checks would break here).
  assert.equal(
    resolveTendrilSubcommand(buildTendrilCommand(["list", "--json"], { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev" }, {}).args),
    "list",
  );
  assert.equal(
    resolveTendrilSubcommand(buildTendrilCommand(["capture"], { AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" }, {}).args),
    "capture",
  );
  assert.equal(
    resolveTendrilSubcommand(
      buildTendrilCommand(["capture", "--window", "4"], { AGENT_UTILS_TENDRIL_REMOTE: "astra", AGENT_UTILS_TENDRIL_WSL_TUNNEL: "1" }, {}).args,
    ),
    "capture",
  );

  // --remote consumes its host value, so a host literally named like a
  // subcommand must not be mistaken for the subcommand.
  assert.equal(resolveTendrilSubcommand(["--remote", "capture", "list", "--json"]), "list");

  // Empty / prefix-only argv yields no subcommand.
  assert.equal(resolveTendrilSubcommand([]), undefined);
  assert.equal(resolveTendrilSubcommand(["--remote", "ms-dev", "--wsl-tunnel"]), undefined);
});

test("tendrilCommandSummary surfaces the resolved bridge prefix", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "astra" };
  const summary = tendrilCommandSummary(env, {});
  assert.equal(summary.remote, "astra");
  assert.deepEqual(summary.argsPrefix, ["--remote", "astra"]);
});

test("tendrilSourceMachine resolves remote source identity from env", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev" };
  assert.deepEqual(tendrilSourceMachine(env, {}), {
    machine: "ms-dev",
    remote: "ms-dev",
    isRemote: true,
    wslTunnel: false,
    source: "env",
  });
});

test("tendrilSourceMachine override wins and reports override source", () => {
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev" };
  assert.deepEqual(tendrilSourceMachine(env, { remote: "astra", wslTunnel: true }), {
    machine: "astra",
    remote: "astra",
    isRemote: true,
    wslTunnel: true,
    source: "override",
  });
});

test("tendrilSourceMachine reports local when no remote bridge is configured", () => {
  // No env remote -> local.
  assert.deepEqual(tendrilSourceMachine({}, {}), {
    machine: "local",
    remote: null,
    isRemote: false,
    wslTunnel: false,
    source: "env",
  });

  // Empty-string override forces local even when env sets a remote.
  const env = { AGENT_UTILS_TENDRIL_REMOTE: "ms-dev" };
  assert.deepEqual(tendrilSourceMachine(env, { remote: "" }), {
    machine: "local",
    remote: null,
    isRemote: false,
    wslTunnel: false,
    source: "override",
  });
});
