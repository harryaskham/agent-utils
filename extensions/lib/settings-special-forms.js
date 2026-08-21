import { spawnSync } from "node:child_process";

const TRUE_RE = /^(1|true|yes|on)$/i;
const FALSE_RE = /^(0|false|no|off)$/i;
const SPECIAL_KEYS = new Set(["$envAbsent", "$envPresent", "$envBool", "$envEq", "$boolCommand", "$stringCommand", "$numberCommand"]);

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

function runCommand(command, {
  env = process.env,
  timeoutMs = 1000,
  spawnSyncImpl = spawnSync,
} = {}) {
  return spawnSyncImpl("bash", ["-lc", String(command || "")], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function runBoolCommand(command, options = {}) {
  const result = runCommand(command, options);
  if (result?.error) return { value: false, ok: false, code: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed" };
  const explicit = boolFromText(result?.stdout);
  if (explicit !== null) return { value: explicit, ok: true, code: "stdout" };
  const status = Number(result?.status);
  return { value: status === 0, ok: Number.isInteger(status), code: Number.isInteger(status) ? "exit-status" : "no-exit-status" };
}

function runShellValueExpression(expression, {
  env = process.env,
  timeoutMs = 1000,
  spawnSyncImpl = spawnSync,
} = {}) {
  const script = 'eval "printf %s \\"$1\\""';
  return spawnSyncImpl("bash", ["-lc", script, "agent-utils-string-command", String(expression || "")], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function runStringCommand(command, options = {}) {
  const source = String(command || "");
  const trimmed = source.trim();
  // A command-substitution expression such as $(hostname) is expanded as a
  // value instead of treating its resulting text as another command name.
  const result = /^\$\([\s\S]*\)$/.test(trimmed) || /^\$\{[^}]+\}$/.test(trimmed)
    ? runShellValueExpression(source, options)
    : runCommand(source, options);
  if (result?.error) return { value: "", ok: false, code: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed" };
  if (Number(result?.status) !== 0) return { value: "", ok: false, code: "nonzero-exit" };
  return { value: String(result?.stdout || "").replace(/(?:\r?\n)+$/, ""), ok: true, code: "stdout" };
}

export function runNumberCommand(command, options = {}) {
  const result = runCommand(command, options);
  if (result?.error) return { value: 0, ok: false, code: result.error.code === "ETIMEDOUT" ? "timeout" : "spawn-failed" };
  if (Number(result?.status) !== 0) return { value: 0, ok: false, code: "nonzero-exit" };
  const text = String(result?.stdout || "").trim();
  if (!text) return { value: 0, ok: false, code: "empty-number-output" };
  const number = Number(text);
  if (!Number.isFinite(number)) return { value: 0, ok: false, code: "invalid-number-output" };
  return { value: number, ok: true, code: "stdout" };
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
    diagnostic(options, path, `empty-${key.slice(1).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    return { matched: true, value: key === "$stringCommand" ? "" : key === "$numberCommand" ? 0 : false };
  }
  if (key === "$stringCommand") {
    const result = (options.stringCommandRunner || runStringCommand)(command, options);
    if (!result?.ok) diagnostic(options, path, result?.code || "string-command-failed");
    return { matched: true, value: result?.ok ? String(result.value ?? "") : "" };
  }
  if (key === "$numberCommand") {
    const result = (options.numberCommandRunner || runNumberCommand)(command, options);
    if (!result?.ok) diagnostic(options, path, result?.code || "number-command-failed");
    return { matched: true, value: result?.ok && Number.isFinite(Number(result.value)) ? Number(result.value) : 0 };
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
  stringCommandRunner,
  numberCommandRunner,
  envEqRunner,
  spawnSyncImpl,
  timeoutMs = 1000,
  onDiagnostic,
} = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return settings;
  const agentUtils = settings.agentUtils;
  if (!agentUtils || typeof agentUtils !== "object" || Array.isArray(agentUtils)) return settings;
  if (agentUtils.globalShellExpansion?.enabled !== true) return settings;
  const options = { env, commandRunner, stringCommandRunner, numberCommandRunner, envEqRunner, spawnSyncImpl, timeoutMs, onDiagnostic };
  return { ...settings, agentUtils: resolveNode(agentUtils, options, "agentUtils") };
}
