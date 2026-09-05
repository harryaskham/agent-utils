import { spawn } from "node:child_process";

export const DEFAULT_MAX_OUTPUT_BYTES = 50 * 1024;
export const DEVSHELL_FAILURE_HINT = "This project has a Nix devshell; call nix_devshell_enable before retrying repository commands, or use bash_devshell for a one-off command.";

export function flakeDeclaresDevShell(source) {
  const text = String(source ?? "").replace(/#[^\n]*/g, "");
  return /\bdevShells?\b\s*(?:\.|=)/.test(text);
}

export function normalizeDevShellName(value) {
  const name = String(value ?? "").trim();
  if (!name || name === "default") return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
    throw new Error("devshell name must contain only letters, numbers, '.', '_', '+', or '-'");
  }
  return name;
}

export function devShellInstallable(name) {
  const normalized = normalizeDevShellName(name);
  return normalized ? `.#${normalized}` : null;
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function parseNullEnvironment(value) {
  const environment = {};
  for (const entry of String(value ?? "").split("\0")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    environment[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return environment;
}

const VOLATILE_DEVSHELL_ENV_KEYS = new Set(["PWD", "OLDPWD", "SHLVL", "_", "NIX_BUILD_TOP", "TMP", "TEMP", "TEMPDIR", "TMPDIR"]);

export function sanitizeDevShellEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment || {}).filter(([key]) => !VOLATILE_DEVSHELL_ENV_KEYS.has(key)));
}

export function wrapCommandForDevShell(command, name) {
  const installable = devShellInstallable(name);
  return `nix develop${installable ? ` ${shellQuote(installable)}` : ""} --command bash -c ${shellQuote(command)}`;
}

export function nixDevelopArgs(name, command = ["true"]) {
  const installable = devShellInstallable(name);
  return ["develop", ...(installable ? [installable] : []), "--command", ...command];
}

export function runNixDevelop({ command, name, cwd, signal, timeoutMs = 120000, spawnImpl = spawn, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  const child = spawnImpl("nix", nixDevelopArgs(name, command ?? ["true"]), {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    const append = (current, chunk) => {
      const joined = Buffer.concat([current, Buffer.from(chunk)]);
      if (joined.length <= maxOutputBytes) return joined;
      truncated = true;
      return joined.subarray(joined.length - maxOutputBytes);
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { child.kill?.("SIGTERM"); finish(new Error("nix develop cancelled")); };
    signal?.addEventListener?.("abort", abort, { once: true });
    child.on("error", (error) => finish(error));
    child.on("close", (code, sig) => finish(null, {
      exitCode: Number.isInteger(code) ? code : 1,
      signal: sig || null,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      truncated,
    }));
    const timer = timeoutMs > 0 ? setTimeout(() => {
      child.kill?.("SIGTERM");
      finish(new Error(`nix develop timed out after ${timeoutMs}ms`));
    }, timeoutMs) : null;
  });
}
