import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { displayPath } from "./display-path.js";

export const DEFAULT_GWS_COMMAND = "gws";
export const DEFAULT_PERSONAL_TODO_PATH = "~/org/todo.org";
export const DEFAULT_PERSONAL_TODO_HORIZON_DAYS = 7;
export const DEFAULT_PERSONAL_TODO_LOOKBACK_DAYS = 2;

function compact(value, limit = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function expandHome(inputPath) {
  if (!inputPath?.startsWith("~/")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(2));
}

function jsonFromOutput(stdout = "") {
  const text = String(stdout || "");
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) throw new Error("output did not contain a JSON object");
  return JSON.parse(text.slice(first, last + 1));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function domainFromEmail(value) {
  const match = String(value || "").match(/@([^@\s>]+)$/);
  return match ? match[1].toLowerCase() : null;
}

function redactEmail(value) {
  const text = String(value || "").trim();
  const match = text.match(/^([^@\s]+)@([^@\s]+)$/);
  if (!match) return text ? "[configured]" : null;
  const local = match[1];
  const domain = match[2];
  const prefix = local.slice(0, 1) || "?";
  return `${prefix}***@${domain}`;
}

function scopeFlags(scopes = []) {
  const joined = (Array.isArray(scopes) ? scopes : []).join(" ").toLowerCase();
  return {
    gmail: joined.includes("gmail"),
    calendar: joined.includes("calendar"),
    tasks: joined.includes("tasks"),
    drive: joined.includes("drive"),
  };
}

function gwsStatusFromResult(result = {}, { host = "local" } = {}) {
  if (result.code !== 0) {
    return {
      host,
      available: !/ENOENT|not found|No such file/i.test(`${result.stderr || ""} ${result.stdout || ""}`),
      authenticated: false,
      status: "error",
      error: compact(result.stderr || result.stdout || `exit code ${result.code}`, 240),
    };
  }
  try {
    const parsed = jsonFromOutput(result.stdout);
    return {
      host,
      available: true,
      authenticated: Boolean(parsed.token_valid || parsed.has_refresh_token || parsed.encrypted_credentials_exists || parsed.plain_credentials_exists),
      status: parsed.token_valid === false ? "token_invalid" : "ok",
      authMethod: compact(parsed.auth_method, 40),
      userConfigured: Boolean(parsed.user),
      user: redactEmail(parsed.user),
      userDomain: domainFromEmail(parsed.user),
      projectConfigured: Boolean(parsed.project_id),
      keyringBackend: compact(parsed.keyring_backend, 40),
      tokenValid: parsed.token_valid === undefined ? undefined : Boolean(parsed.token_valid),
      hasRefreshToken: parsed.has_refresh_token === undefined ? undefined : Boolean(parsed.has_refresh_token),
      scopes: scopeFlags(parsed.scopes),
    };
  } catch (error) {
    return { host, available: true, authenticated: false, status: "parse_failed", error: compact(error.message, 240) };
  }
}

export async function checkGwsStatus({ exec, command = DEFAULT_GWS_COMMAND, timeoutMs = 10_000, host = "local" } = {}) {
  if (!exec) throw new Error("checkGwsStatus requires exec");
  const result = await exec(command, ["auth", "status"], { timeout: timeoutMs });
  return gwsStatusFromResult(result, { host });
}

export async function checkRemoteGwsStatus({ exec, sshTarget, command = DEFAULT_GWS_COMMAND, sshConnectTimeoutSeconds = 10, timeoutMs = 15_000 } = {}) {
  if (!exec) throw new Error("checkRemoteGwsStatus requires exec");
  if (!sshTarget) return null;
  const timeout = Math.max(1, Number.parseInt(String(sshConnectTimeoutSeconds || 10), 10) || 10);
  const remoteCommand = `${shellQuote(command)} auth status`;
  const result = await exec("ssh", ["-o", "BatchMode=yes", "-o", `ConnectTimeout=${timeout}`, sshTarget, remoteCommand], { timeout: timeoutMs });
  return gwsStatusFromResult(result, { host: "ms-dev" });
}

function parseOrgDate(value) {
  const match = String(value || "").match(/[<[](?<date>\d{4}-\d{2}-\d{2})(?:\s+\w+)?(?:\s+(?<time>\d{1,2}:\d{2}))?/);
  if (!match?.groups?.date) return null;
  const time = match.groups.time || "00:00";
  const parsed = new Date(`${match.groups.date}T${time}:00`);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function daysFrom(ms) {
  return ms / 86_400_000;
}

export function parseOrgTodoTimelyItems(text, { now = new Date(), horizonDays = DEFAULT_PERSONAL_TODO_HORIZON_DAYS, lookbackDays = DEFAULT_PERSONAL_TODO_LOOKBACK_DAYS, limit = 20 } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const minMs = nowDate.getTime() - (Number(lookbackDays) || 0) * 86_400_000;
  const maxMs = nowDate.getTime() + (Number(horizonDays) || 0) * 86_400_000;
  const items = [];
  let current = null;
  const flush = () => {
    if (!current) return;
    const dates = current.dates.filter(Boolean);
    const due = dates.find((date) => date.getTime() >= minMs && date.getTime() <= maxMs);
    if (!due) return;
    items.push({
      title: compact(current.title, 180),
      todoState: current.todoState || null,
      line: current.line,
      date: due.toISOString(),
      days: Math.round(daysFrom(due.getTime() - nowDate.getTime()) * 10) / 10,
    });
  };
  const lines = String(text || "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(/^(\*+)\s+(?:(TODO|NEXT|WAIT|WAITING|IN-PROGRESS|DONE|CANCELLED)\s+)?(.+?)\s*$/i);
    if (heading) {
      flush();
      current = {
        line: index + 1,
        level: heading[1].length,
        todoState: heading[2] ? heading[2].toUpperCase() : null,
        title: heading[3].replace(/\s+:[\w:@#%:]+:\s*$/, ""),
        dates: [],
      };
      const inlineDate = parseOrgDate(line);
      if (inlineDate) current.dates.push(inlineDate);
      continue;
    }
    if (!current) continue;
    if (/^\*+\s+/.test(line)) continue;
    if (/\b(SCHEDULED|DEADLINE|TIMESTAMP|CLOSED):/i.test(line)) {
      const date = parseOrgDate(line);
      if (date) current.dates.push(date);
    }
  }
  flush();
  return items
    .filter((item) => item.title && !["DONE", "CANCELLED"].includes(item.todoState || ""))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .slice(0, Math.max(1, Number.parseInt(String(limit), 10) || 20));
}

export async function checkPersonalTodoStatus({ todoPath = DEFAULT_PERSONAL_TODO_PATH, now = new Date(), horizonDays = DEFAULT_PERSONAL_TODO_HORIZON_DAYS, lookbackDays = DEFAULT_PERSONAL_TODO_LOOKBACK_DAYS } = {}) {
  const resolvedPath = path.resolve(expandHome(todoPath));
  const exists = await stat(resolvedPath).then(() => true, () => false);
  if (!exists) return { path: resolvedPath, displayPath: displayPath(resolvedPath), exists: false, timelyItems: [] };
  const raw = await readFile(resolvedPath, "utf8");
  const timelyItems = parseOrgTodoTimelyItems(raw, { now, horizonDays, lookbackDays, limit: 20 });
  return { path: resolvedPath, displayPath: displayPath(resolvedPath), exists: true, timelyItems, timelyCount: timelyItems.length };
}

function renderGwsStatus(label, status) {
  return `${label}=${status?.status || "unknown"}${status?.available === false ? " available=false" : ""}${status?.authenticated != null ? ` authenticated=${status.authenticated}` : ""}${status?.userDomain ? ` userDomain=${status.userDomain}` : ""}${status?.scopes ? ` scopes=${Object.entries(status.scopes).filter(([, enabled]) => enabled).map(([name]) => name).join(",") || "none"}` : ""}${status?.error ? ` error=${status.error}` : ""}`;
}

export function renderPersonalAutomationStatus({ gws, msDevGws, todo } = {}) {
  const lines = [
    `personalAutomation ${renderGwsStatus("gws", gws)}`,
    msDevGws ? renderGwsStatus("msDevGws", msDevGws) : null,
    todo ? `personalTodo exists=${todo.exists}${todo.displayPath ? ` path=${todo.displayPath}` : ""}${todo.timelyCount != null ? ` timely=${todo.timelyCount}` : ""}` : null,
  ].filter(Boolean);
  for (const item of (todo?.timelyItems || []).slice(0, 8)) {
    lines.push(`- ${item.todoState ? `${item.todoState} ` : ""}${item.title} @ ${item.date.slice(0, 10)}${item.days != null ? ` (${item.days}d)` : ""}`);
  }
  return lines.join("\n");
}
