import { spawnSync } from "node:child_process";

const TRUE_RE = /^(1|true|yes|on)$/i;
const FALSE_RE = /^(0|false|no|off)$/i;
const SPECIAL_KEYS = new Set(["$envAbsent", "$envPresent", "$envBool", "$envEq", "$boolCommand"]);

function diagnostic(options, path, code) {
  try { options.onDiagnostic?.({ path, code }); } catch {}
}

function envName(value, options, path) {
  const name = String(value || "").trim();
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  diagnostic(options, path, "invalid-env-name");
  return null;
}

function boolFromText(value) {
  const text = String(value ?? "").trim();
  if (TRUE_RE.test(text)) return true;
  if (FALSE_RE.test(text)) return false;
  return null;
}

export function runBoolCommand(command, {
  env = process.env,
  timeoutMs = 1000,
  spawnSyncImpl = spawnSync,
} = {}) {
  const result = spawnSyncImpl("bash", ["-lc", String(command || "")], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result?.error) return { value: false, ok: false, code: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed" };
  const explicit = boolFromText(result?.stdout);
  if (explicit !== null) return { value: explicit, ok: true, code: "stdout" };
  const status = Number(result?.status);
  return { value: status === 0, ok: Number.isInteger(status), code: Number.isInteger(status) ? "exit-status" : "no-exit-status" };
}

export function runEnvEq(operands, {
  env = process.env,
  timeoutMs = 1000,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Array.isArray(operands) || operands.length !== 2 || operands.some((entry) => typeof entry !== "string")) {
    return { value: false, ok: false, code: "invalid-env-eq-operands" };
  }
  // The operands are argv, not interpolated into this script. `eval` is
  // deliberate: $envEq is an explicit trusted-settings shell special form and
  // supports both ${VAR} expansion and $(command) substitution.
  const script = 'left=$(eval "printf %s \\"$1\\"") || exit; right=$(eval "printf %s \\"$2\\"") || exit; [[ "$left" == "$right" ]]';
  const result = spawnSyncImpl("bash", ["-lc", script, "agent-utils-env-eq", operands[0], operands[1]], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  if (result?.error) return { value: false, ok: false, code: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed" };
  const status = Number(result?.status);
  return { value: status === 0, ok: Number.isInteger(status), code: Number.isInteger(status) ? "exit-status" : "no-exit-status" };
}

function resolveSpecialForm(value, options, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { matched: false, value };
  const keys = Object.keys(value);
  const special = keys.filter((key) => SPECIAL_KEYS.has(key));
  const dollar = keys.filter((key) => key.startsWith("$"));
  if (special.length === 0) {
    if (dollar.length > 0) {
      diagnostic(options, path, "unknown-special-form");
      return { matched: true, value: false };
    }
    return { matched: false, value };
  }
  if (special.length !== 1) {
    diagnostic(options, path, "ambiguous-special-form");
    return { matched: true, value: false };
  }
  const key = special[0];
  const allowed = key === "$envBool" ? new Set([key, "default"]) : new Set([key]);
  if (keys.some((candidate) => !allowed.has(candidate))) {
    diagnostic(options, path, "mixed-special-form");
    return { matched: true, value: false };
  }
  if (key === "$envAbsent" || key === "$envPresent") {
    const name = envName(value[key], options, path);
    if (!name) return { matched: true, value: false };
    const present = Object.prototype.hasOwnProperty.call(options.env, name);
    return { matched: true, value: key === "$envPresent" ? present : !present };
  }
  if (key === "$envBool") {
    const name = envName(value[key], options, path);
    if (!name) return { matched: true, value: false };
    const raw = options.env[name];
    if (raw == null || String(raw).trim() === "") {
      if (value.default === undefined) return { matched: true, value: false };
      if (typeof value.default !== "boolean") {
        diagnostic(options, path, "invalid-env-bool-default");
        return { matched: true, value: false };
      }
      return { matched: true, value: value.default };
    }
    const parsed = boolFromText(raw);
    if (parsed === null) {
      diagnostic(options, path, "invalid-env-bool-value");
      return { matched: true, value: typeof value.default === "boolean" ? value.default : false };
    }
    return { matched: true, value: parsed };
  }
  if (key === "$envEq") {
    const result = (options.envEqRunner || runEnvEq)(value[key], options);
    if (!result?.ok && result?.code !== "exit-status") diagnostic(options, path, result?.code || "env-eq-failed");
    return { matched: true, value: result?.value === true };
  }
  const command = String(value[key] || "");
  if (!command.trim()) {
    diagnostic(options, path, "empty-bool-command");
    return { matched: true, value: false };
  }
  const result = (options.commandRunner || runBoolCommand)(command, options);
  if (!result?.ok) diagnostic(options, path, result?.code || "bool-command-failed");
  return { matched: true, value: result?.value === true };
}

function resolveNode(value, options, path) {
  const special = resolveSpecialForm(value, options, path);
  if (special.matched) return special.value;
  if (Array.isArray(value)) return value.map((entry, index) => resolveNode(entry, options, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveNode(entry, options, `${path}.${key}`)]));
  }
  return value;
}

export function resolveAgentUtilsSpecialForms(settings = {}, {
  env = process.env,
  commandRunner,
  envEqRunner,
  spawnSyncImpl,
  timeoutMs = 1000,
  onDiagnostic,
} = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  const agentUtils = settings.agentUtils;
  if (!agentUtils || typeof agentUtils !== "object" || Array.isArray(agentUtils)) return settings;
  if (agentUtils.globalShellExpansion?.enabled !== true) return settings;
  const options = { env, commandRunner, envEqRunner, spawnSyncImpl, timeoutMs, onDiagnostic };
  return { ...settings, agentUtils: resolveNode(agentUtils, options, "agentUtils") };
}
