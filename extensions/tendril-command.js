export const DEFAULT_TENDRIL_COMMAND = "tendril";

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

// Per-call overrides let a single Pi session target Tendril bridges on
// different machines transparently, without mutating the global env. An
// override field is only applied when it is explicitly provided (not
// undefined); pass `remote: ""`/`remote: null` to force the local bridge even
// when AGENT_UTILS_TENDRIL_REMOTE is set, and `wslTunnel: true|false` to force
// the tunnel hop on or off for this call.
function normalizeOverrides(overrides = {}) {
  if (!overrides || typeof overrides !== "object") return {};
  const normalized = {};
  if (Object.prototype.hasOwnProperty.call(overrides, "remote")) {
    const value = overrides.remote;
    normalized.remote = value == null ? "" : String(value).trim();
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "wslTunnel")) {
    normalized.wslTunnel = typeof overrides.wslTunnel === "string"
      ? envFlag(overrides.wslTunnel)
      : Boolean(overrides.wslTunnel);
  }
  return normalized;
}

export function tendrilBridgeConfig(env = process.env, overrides = {}) {
  const normalized = normalizeOverrides(overrides);
  const remote = Object.prototype.hasOwnProperty.call(normalized, "remote")
    ? normalized.remote
    : env.AGENT_UTILS_TENDRIL_REMOTE || env.TENDRIL_REMOTE || "";
  const wslTunnel = Object.prototype.hasOwnProperty.call(normalized, "wslTunnel")
    ? normalized.wslTunnel
    : envFlag(env.AGENT_UTILS_TENDRIL_WSL_TUNNEL || env.TENDRIL_WSL_TUNNEL);
  return {
    command: env.AGENT_UTILS_TENDRIL_COMMAND || env.TENDRIL_COMMAND || DEFAULT_TENDRIL_COMMAND,
    remote: remote || "",
    wslTunnel,
    remoteSource: Object.prototype.hasOwnProperty.call(normalized, "remote") ? "override" : "env",
    wslTunnelSource: Object.prototype.hasOwnProperty.call(normalized, "wslTunnel") ? "override" : "env",
  };
}

export function buildTendrilCommand(args = [], env = process.env, overrides = {}) {
  const config = tendrilBridgeConfig(env, overrides);
  const prefix = [];
  if (config.remote) prefix.push("--remote", String(config.remote));
  if (config.wslTunnel) prefix.push("--wsl-tunnel");
  return {
    command: config.command,
    args: [...prefix, ...args.map((arg) => String(arg))],
    remote: config.remote || null,
    wslTunnel: config.wslTunnel,
    remoteSource: config.remoteSource,
    wslTunnelSource: config.wslTunnelSource,
  };
}

// Resolve a stable, human-readable identity for the machine a Tendril command
// targets, so captured images and downstream model-inference results can be
// associated with their source machine. Remote captures (via --remote <host>)
// report the host; local captures report "local". The returned shape also
// includes whether the identity came from a per-call override or the ambient
// env, mirroring tendrilBridgeConfig's *Source fields.
export function tendrilSourceMachine(env = process.env, overrides = {}) {
  const config = tendrilBridgeConfig(env, overrides);
  const remote = config.remote ? String(config.remote) : "";
  return {
    machine: remote || "local",
    remote: remote || null,
    isRemote: Boolean(remote),
    wslTunnel: config.wslTunnel,
    source: config.remoteSource,
  };
}

export function tendrilCommandSummary(env = process.env, overrides = {}) {
  const sample = buildTendrilCommand(["list", "--json"], env, overrides);
  return {
    command: sample.command,
    remote: sample.remote,
    wslTunnel: sample.wslTunnel,
    remoteSource: sample.remoteSource,
    wslTunnelSource: sample.wslTunnelSource,
    argsPrefix: sample.args.slice(0, sample.args.length - 2),
  };
}
