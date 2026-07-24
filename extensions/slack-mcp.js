// Native Slack MCP-style extension for Pi.
//
// Provides Slack tools directly via Pi's extension API while reusing the
// ~/.slack-mcp-tokens.json credential convention from the Claude Slack MCP
// plugin. Tokens are refreshed in-process from an open Slack browser session
// (macOS Chrome/Edge/Brave) and automatically retried when Slack reports an
// authentication failure.
//
// Safety: tools that mutate Slack require confirmed=true and should only be
// called after showing the user the exact destination/content.

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { compactSlackResponse } from "./slack-compact.js";

const execFileAsync = promisify(execFile);

const TOKEN_FILE = join(homedir(), ".slack-mcp-tokens.json");
const TOKEN_WARNING_AGE_MS = 6 * 60 * 60 * 1000;
const TOKEN_CRITICAL_AGE_MS = 10 * 60 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 1000;
const AUTH_ERRORS = new Set([
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "not_authed",
  "cookie_not_found",
  "invalid_cookie",
]);
const WRITE_METHODS = new Set([
  "chat.postMessage",
  "chat.update",
  "chat.delete",
  "chat.scheduleMessage",
  "reactions.add",
  "reactions.remove",
  "pins.add",
  "pins.remove",
  "bookmarks.add",
  "bookmarks.edit",
  "bookmarks.remove",
  "files.delete",
  "reminders.add",
  "reminders.complete",
  "reminders.delete",
]);

let tokenCache = null;
let lastRefreshAttempt = 0;
let refreshPromise = null;

const RAW_PROPERTY = {
  raw: {
    type: "boolean",
    default: false,
    description: "Return the original Slack API payload instead of the compact result. Defaults to false.",
  },
};
const EMPTY_OBJECT = { type: "object", properties: {} };
const RAW_ONLY_OBJECT = { type: "object", properties: RAW_PROPERTY };

function jsonText(value) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    details: typeof value === "object" && value !== null ? value : { value },
  };
}

function errorText(message, details = {}) {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    details: { error: message, ...details },
  };
}

function parseTokenFile() {
  if (!existsSync(TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(TOKEN_FILE, "utf-8"));
    if (!data.SLACK_TOKEN || !data.SLACK_COOKIE) return null;
    return {
      token: data.SLACK_TOKEN,
      cookie: data.SLACK_COOKIE,
      source: "file",
      updatedAt: data.updated_at || data.updatedAt || null,
    };
  } catch {
    return null;
  }
}

function loadTokens({ forceReload = false } = {}) {
  if (!forceReload && tokenCache) return tokenCache;

  if (process.env.SLACK_TOKEN && process.env.SLACK_COOKIE) {
    tokenCache = {
      token: process.env.SLACK_TOKEN,
      cookie: process.env.SLACK_COOKIE,
      source: "environment",
      updatedAt: null,
    };
    return tokenCache;
  }

  tokenCache = parseTokenFile();
  return tokenCache;
}

function atomicWriteTokens(token, cookie, source) {
  const payload = JSON.stringify(
    {
      SLACK_TOKEN: token,
      SLACK_COOKIE: cookie,
      updated_at: new Date().toISOString(),
      source,
    },
    null,
    2
  );
  const tmp = `${TOKEN_FILE}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, payload, { mode: 0o600 });
    renameSync(tmp, TOKEN_FILE);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

function tokenAgeInfo(tokens) {
  if (!tokens?.updatedAt) return { ageMs: null, status: "unknown" };
  const updated = Date.parse(tokens.updatedAt);
  if (Number.isNaN(updated)) return { ageMs: null, status: "unknown" };
  const ageMs = Date.now() - updated;
  const status = ageMs >= TOKEN_CRITICAL_AGE_MS ? "critical" : ageMs >= TOKEN_WARNING_AGE_MS ? "warning" : "ok";
  return { ageMs, ageHours: Math.round((ageMs / 36_000) ) / 100, status };
}

function escapeAppleScriptString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, " ");
}

async function runOsaScript(script) {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    encoding: "utf-8",
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

async function extractFromMacBrowser(appName) {
  const tokenJs = `(() => {
    const configs = ["localConfig_v3", "localConfig_v2"];
    for (const key of configs) {
      try {
        const raw = localStorage.getItem(key) || localStorage[key];
        if (!raw) continue;
        const cfg = JSON.parse(raw);
        const teams = cfg.teams || {};
        for (const team of Object.values(teams)) {
          const token = team && team.token;
          if (typeof token === "string" && token.startsWith("xoxc-")) return token;
        }
      } catch (_) {}
    }
    try {
      const redux = JSON.parse(localStorage.getItem("reduxPersist:localConfig") || "{}");
      for (const team of Object.values(redux.teams || {})) {
        const token = team && team.token;
        if (typeof token === "string" && token.startsWith("xoxc-")) return token;
      }
    } catch (_) {}
    return "";
  })()`;
  const cookieJs = `(() => document.cookie.split('; ').find(c => c.startsWith('d='))?.split('=')[1] || '')()`;
  const script = `
    tell application "${escapeAppleScriptString(appName)}"
      repeat with w in windows
        repeat with t in tabs of w
          set u to URL of t
          if u contains "slack.com" then
            set slackToken to execute t javascript "${escapeAppleScriptString(tokenJs)}"
            set slackCookie to execute t javascript "${escapeAppleScriptString(cookieJs)}"
            if slackToken starts with "xoxc-" and slackCookie starts with "xoxd-" then
              return slackToken & (ASCII character 10) & slackCookie
            end if
          end if
        end repeat
      end repeat
    end tell
    return ""
  `;
  const out = await runOsaScript(script);
  const [token, cookie] = out.split(/\r?\n/);
  if (token?.startsWith("xoxc-") && cookie?.startsWith("xoxd-")) {
    return { token, cookie, source: `${appName.toLowerCase().replaceAll(" ", "-")}-browser` };
  }
  return null;
}

async function refreshTokens({ force = false } = {}) {
  if (refreshPromise) return refreshPromise;
  const now = Date.now();
  if (!force && now - lastRefreshAttempt < REFRESH_COOLDOWN_MS) {
    return loadTokens({ forceReload: true });
  }
  lastRefreshAttempt = now;

  refreshPromise = (async () => {
    if (platform() !== "darwin") {
      throw new Error("Automatic browser token refresh currently supports macOS Chrome/Edge/Brave. Update ~/.slack-mcp-tokens.json manually on this platform.");
    }

    const browsers = ["Google Chrome", "Microsoft Edge", "Brave Browser"];
    const failures = [];
    for (const browser of browsers) {
      try {
        const refreshed = await extractFromMacBrowser(browser);
        if (refreshed) {
          atomicWriteTokens(refreshed.token, refreshed.cookie, refreshed.source);
          tokenCache = {
            token: refreshed.token,
            cookie: refreshed.cookie,
            source: refreshed.source,
            updatedAt: new Date().toISOString(),
          };
          return tokenCache;
        }
      } catch (err) {
        failures.push(`${browser}: ${err.message}`);
      }
    }
    throw new Error(`Could not extract Slack tokens from an open browser tab. Open https://app.slack.com in Chrome/Edge/Brave and try /slack-refresh. ${failures.join("; ")}`);
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

function browserHeaders(tokens) {
  return {
    "Authorization": `Bearer ${tokens.token}`,
    "Cookie": `d=${tokens.cookie}`,
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.30 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36",
    "Origin": "https://app.slack.com",
    "Referer": "https://app.slack.com/",
    "Accept": "*/*",
  };
}

function encodeParams(params = {}) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) || (typeof value === "object" && !(value instanceof Date))) {
      body.set(key, JSON.stringify(value));
    } else {
      body.set(key, String(value));
    }
  }
  return body;
}

async function slackApi(method, params = {}, options = {}) {
  const tokens = loadTokens();
  if (!tokens) {
    if (options.autoRefresh !== false) {
      await refreshTokens({ force: true });
      return slackApi(method, params, { ...options, autoRefresh: false });
    }
    throw new Error(`Slack credentials not found. Create ${TOKEN_FILE} or run /slack-refresh with Slack open in a browser.`);
  }

  const response = await fetch(`https://www.slack.com/api/${method}`, {
    method: "POST",
    headers: browserHeaders(tokens),
    body: encodeParams(params),
    signal: options.signal,
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { ok: false, error: `HTTP ${response.status}`, response: text.slice(0, 2000) };
  }

  if ((!response.ok || json.ok === false) && AUTH_ERRORS.has(json.error) && options.autoRefresh !== false) {
    await refreshTokens({ force: true });
    return slackApi(method, params, { ...options, autoRefresh: false });
  }

  return json;
}

async function fetchSlackCanvasHtml(file, options = {}) {
  const rawUrl = file?.url_private_download || file?.url_private;
  if (!rawUrl) throw new Error(`Canvas ${file?.id || "file"} has no private content URL`);
  const url = new URL(rawUrl);
  if (url.protocol !== "https:" || url.hostname !== "files.slack.com") {
    throw new Error(`Refusing unexpected Slack canvas content host: ${url.hostname}`);
  }

  let tokens = loadTokens();
  if (!tokens) tokens = await refreshTokens({ force: true });
  const response = await fetch(url, {
    headers: browserHeaders(tokens),
    signal: options.signal,
  });
  if ((response.status === 401 || response.status === 403) && options.autoRefresh !== false) {
    await refreshTokens({ force: true });
    return fetchSlackCanvasHtml(file, { ...options, autoRefresh: false });
  }
  if (!response.ok) throw new Error(`Slack canvas download failed with HTTP ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) {
    throw new Error(`Slack canvas download returned ${contentType || "an unknown content type"}`);
  }
  return response.text();
}

async function maybeCompact(method, result, params, signal) {
  if (params.raw === true) return result;
  return compactSlackResponse(method, result, params, {
    api: slackApi,
    fetchCanvas: fetchSlackCanvasHtml,
    signal,
  });
}

async function paginate(method, params, itemKey, limit, cursorKey = "cursor") {
  const out = [];
  let cursor = params.cursor || undefined;
  const max = Math.max(1, Math.min(Number(limit || params.limit || 200), 5000));
  while (out.length < max) {
    const pageLimit = Math.min(200, max - out.length);
    const result = await slackApi(method, { ...params, limit: pageLimit, [cursorKey]: cursor });
    if (!result.ok) return { ...result, partial: out };
    const items = Array.isArray(result[itemKey]) ? result[itemKey] : [];
    out.push(...items);
    cursor = result.response_metadata?.next_cursor;
    if (!cursor || items.length === 0) break;
  }
  return { ok: true, [itemKey]: out, count: out.length };
}

function registerSlackTool(pi, spec, handler) {
  pi.registerTool({
    ...spec,
    async execute(_toolCallId, params = {}, signal) {
      try {
        const result = await handler(params, signal);
        return jsonText(result);
      } catch (err) {
        return errorText(err.message, { stack: err.stack });
      }
    },
  });
}

function requireConfirmation(method, params) {
  if (WRITE_METHODS.has(method) && params.confirmed !== true) {
    return {
      ok: false,
      confirmation_required: true,
      method,
      preview: Object.fromEntries(Object.entries(params).filter(([key]) => key !== "confirmed")),
      instructions: "Show the exact Slack action to the user and only retry with confirmed=true after explicit approval.",
    };
  }
  return null;
}

const SYSTEM_PROMPT = `Slack MCP tools are available natively in Pi. They use the user's personal Slack session from ~/.slack-mcp-tokens.json and can act as the user. Before any Slack write operation (sending/updating/deleting messages, reactions, pins, bookmarks, files, reminders), show the exact destination and content/action, get explicit user approval, and only then set confirmed=true. Never write to Slack based only on inferred intent.`;

export default function slackMcpExtension(pi) {
  pi.appendSystemPromptSection?.("slack-mcp-safety", SYSTEM_PROMPT);

  pi.registerCommand("slack-status", {
    description: "Check native Slack MCP token/API health.",
    handler: async (_args, ctx) => {
      try {
        const tokens = loadTokens({ forceReload: true });
        if (!tokens) {
          ctx.ui.notify("Slack tokens not found; run /slack-refresh with Slack open in a browser.", "warning");
          return;
        }
        const auth = await slackApi("auth.test");
        ctx.ui.notify(auth.ok ? `Slack OK: ${auth.user} / ${auth.team}` : `Slack auth failed: ${auth.error}`, auth.ok ? "success" : "error");
      } catch (err) {
        ctx.ui.notify(`Slack status failed: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("slack-refresh", {
    description: "Refresh native Slack MCP tokens from an open Slack browser tab.",
    handler: async (_args, ctx) => {
      try {
        ctx.ui.notify("Refreshing Slack tokens from browser...", "info");
        const tokens = await refreshTokens({ force: true });
        ctx.ui.notify(`Slack tokens refreshed from ${tokens.source}.`, "success");
      } catch (err) {
        ctx.ui.notify(`Slack token refresh failed: ${err.message}`, "error");
      }
    },
  });

  registerSlackTool(pi, {
    name: "slack_token_status",
    label: "Slack Token Status",
    description: "Check Slack token source, age, and refresh availability without making a Slack API call.",
    parameters: EMPTY_OBJECT,
  }, async () => {
    const tokens = loadTokens({ forceReload: true });
    return {
      ok: Boolean(tokens),
      token_file: TOKEN_FILE,
      source: tokens?.source || null,
      updated_at: tokens?.updatedAt || null,
      age: tokenAgeInfo(tokens),
      auto_refresh: {
        supported: platform() === "darwin",
        method: "macOS browser AppleScript (Chrome/Edge/Brave)",
      },
    };
  });

  registerSlackTool(pi, {
    name: "slack_health_check",
    label: "Slack Health Check",
    description: "Validate Slack credentials and report compact API health. Set raw=true for the original nested API payloads.",
    parameters: RAW_ONLY_OBJECT,
  }, async (params, signal) => {
    const [auth, conversations, search, users] = await Promise.all([
      slackApi("auth.test", {}, { signal }),
      slackApi("conversations.list", { types: "im,mpim,public_channel,private_channel", limit: 1 }, { signal }),
      slackApi("search.messages", { query: "from:me", count: 1 }, { signal }),
      slackApi("users.list", { limit: 1 }, { signal }),
    ]);
    const token = await (async () => { const t = loadTokens(); return { source: t?.source, updated_at: t?.updatedAt, age: tokenAgeInfo(t) }; })();
    const full = { ok: auth.ok && conversations.ok && search.ok && users.ok, auth, apis: { conversations, search, users }, token };
    if (params.raw === true) return full;
    return {
      ok: full.ok,
      auth: await compactSlackResponse("auth.test", auth),
      apis: {
        conversations: { ok: conversations.ok, error: conversations.error },
        search: { ok: search.ok, error: search.error },
        users: { ok: users.ok, error: users.error },
      },
      token,
    };
  });

  registerSlackTool(pi, {
    name: "slack_refresh_tokens",
    label: "Slack Refresh Tokens",
    description: "Force-refresh Slack session tokens from an open Slack browser tab and save ~/.slack-mcp-tokens.json.",
    parameters: EMPTY_OBJECT,
  }, async () => {
    const tokens = await refreshTokens({ force: true });
    return { ok: true, source: tokens.source, token_file: TOKEN_FILE, updated_at: tokens.updatedAt };
  });

  registerSlackTool(pi, {
    name: "slack_api",
    label: "Slack API",
    description: "Call a Slack Web API method and return a compact result by default. Set raw=true for the original payload. Write methods require confirmed=true.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "Slack API method, e.g. search.messages or conversations.history." },
        params: { type: "object", description: "Parameters for the Slack API method." },
        confirmed: { type: "boolean", description: "Required true for write methods after explicit user approval." },
        ...RAW_PROPERTY,
      },
      required: ["method"],
    },
  }, async (params, signal) => {
    const guard = requireConfirmation(params.method, { ...(params.params || {}), confirmed: params.confirmed });
    if (guard) return guard;
    const result = await slackApi(params.method, params.params || {}, { signal });
    return maybeCompact(params.method, result, { ...(params.params || {}), raw: params.raw }, signal);
  });

  registerSlackTool(pi, {
    name: "slack_search_messages",
    label: "Slack Search Messages",
    description: "Search Slack messages, grouped under compact conversation provenance by default. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number", default: 20 }, ...RAW_PROPERTY }, required: ["query"] },
  }, async (params, signal) => {
    const result = await slackApi("search.messages", { query: params.query, count: params.count || 20 }, { signal });
    return maybeCompact("search.messages", result, params, signal);
  });

  registerSlackTool(pi, {
    name: "slack_search_files",
    label: "Slack Search Files",
    description: "Search Slack files/canvases with compact provenance and bounded Markdown canvas content by default. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { query: { type: "string" }, count: { type: "number", default: 20 }, ...RAW_PROPERTY }, required: ["query"] },
  }, async (params, signal) => {
    const result = await slackApi("search.files", { query: params.query, count: params.count || 20 }, { signal });
    return maybeCompact("search.files", result, params, signal);
  });

  registerSlackTool(pi, {
    name: "slack_list_conversations",
    label: "Slack List Conversations",
    description: "List Slack DMs/channels compactly with pagination. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { types: { type: "string", default: "im,mpim" }, limit: { type: "number", default: 200 }, exclude_archived: { type: "boolean", default: true }, ...RAW_PROPERTY } },
  }, async (params, signal) => {
    const result = await paginate("conversations.list", { types: params.types || "im,mpim", exclude_archived: params.exclude_archived !== false }, "channels", params.limit || 200);
    return maybeCompact("conversations.list", result, params, signal);
  });

  registerSlackTool(pi, {
    name: "slack_conversations_history",
    label: "Slack Conversation History",
    description: "Get compact grouped messages from a channel or DM. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { channel_id: { type: "string" }, limit: { type: "number", default: 50 }, oldest: { type: "string" }, latest: { type: "string" }, ...RAW_PROPERTY }, required: ["channel_id"] },
  }, async (params, signal) => {
    const apiParams = { channel: params.channel_id, limit: params.limit || 50, oldest: params.oldest, latest: params.latest };
    const result = await slackApi("conversations.history", apiParams, { signal });
    return maybeCompact("conversations.history", result, { ...apiParams, raw: params.raw }, signal);
  });

  registerSlackTool(pi, {
    name: "slack_get_thread",
    label: "Slack Get Thread",
    description: "Get compact grouped replies in a Slack thread. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { channel_id: { type: "string" }, thread_ts: { type: "string" }, ...RAW_PROPERTY }, required: ["channel_id", "thread_ts"] },
  }, async (params, signal) => {
    const apiParams = { channel: params.channel_id, ts: params.thread_ts };
    const result = await slackApi("conversations.replies", apiParams, { signal });
    return maybeCompact("conversations.replies", result, { ...apiParams, raw: params.raw }, signal);
  });

  registerSlackTool(pi, {
    name: "slack_channel_info",
    label: "Slack Channel Info",
    description: "Get compact Slack channel/DM metadata. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { channel_id: { type: "string" }, ...RAW_PROPERTY }, required: ["channel_id"] },
  }, async (params, signal) => {
    const result = await slackApi("conversations.info", { channel: params.channel_id }, { signal });
    return maybeCompact("conversations.info", result, params, signal);
  });

  registerSlackTool(pi, {
    name: "slack_users_info",
    label: "Slack User Info",
    description: "Get compact identity information for a Slack user. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { user_id: { type: "string" }, ...RAW_PROPERTY }, required: ["user_id"] },
  }, async (params, signal) => {
    const result = await slackApi("users.info", { user: params.user_id }, { signal });
    return maybeCompact("users.info", result, params, signal);
  });

  registerSlackTool(pi, {
    name: "slack_list_users",
    label: "Slack List Users",
    description: "List compact Slack user identities with pagination. Set raw=true for the original payload.",
    parameters: { type: "object", properties: { limit: { type: "number", default: 500 }, ...RAW_PROPERTY } },
  }, async (params, signal) => {
    const result = await paginate("users.list", {}, "members", params.limit || 500);
    return maybeCompact("users.list", result, params, signal);
  });

  registerSlackTool(pi, {
    name: "slack_send_message",
    label: "Slack Send Message",
    description: "Send a Slack message as the user and return a compact receipt by default. Set raw=true for the original response. Requires confirmed=true after explicit approval.",
    parameters: { type: "object", properties: { channel_id: { type: "string" }, text: { type: "string" }, thread_ts: { type: "string" }, unfurl_links: { type: "boolean" }, unfurl_media: { type: "boolean" }, confirmed: { type: "boolean" }, ...RAW_PROPERTY }, required: ["channel_id", "text"] },
  }, async (params, signal) => {
    const guard = requireConfirmation("chat.postMessage", params);
    if (guard) return guard;
    const apiParams = { channel: params.channel_id, text: params.text, thread_ts: params.thread_ts, unfurl_links: params.unfurl_links, unfurl_media: params.unfurl_media };
    const result = await slackApi("chat.postMessage", apiParams, { signal });
    return maybeCompact("chat.postMessage", result, { ...apiParams, raw: params.raw }, signal);
  });
}
