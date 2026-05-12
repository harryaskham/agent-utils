export const DEFAULT_TENDRIL_COMMAND = "tendril";

function envFlag(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

export function tendrilBridgeConfig(env = process.env) {
  return {
    command: env.AGENT_UTILS_TENDRIL_COMMAND || env.TENDRIL_COMMAND || DEFAULT_TENDRIL_COMMAND,
    remote: env.AGENT_UTILS_TENDRIL_REMOTE || env.TENDRIL_REMOTE || "",
    wslTunnel: envFlag(env.AGENT_UTILS_TENDRIL_WSL_TUNNEL || env.TENDRIL_WSL_TUNNEL),
  };
}

export function buildTendrilCommand(args = [], env = process.env) {
  const config = tendrilBridgeConfig(env);
  const prefix = [];
  if (config.remote) prefix.push("--remote", String(config.remote));
  if (config.wslTunnel) prefix.push("--wsl-tunnel");
  return {
    command: config.command,
    args: [...prefix, ...args.map((arg) => String(arg))],
    remote: config.remote || null,
    wslTunnel: config.wslTunnel,
  };
}

export function tendrilCommandSummary(env = process.env) {
  const sample = buildTendrilCommand(["list", "--json"], env);
  return {
    command: sample.command,
    remote: sample.remote,
    wslTunnel: sample.wslTunnel,
    argsPrefix: sample.args.slice(0, sample.args.length - 2),
  };
}
