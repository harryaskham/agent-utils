const MAX_MESSAGE_TEXT_CHARS = 4_000;
const MAX_MESSAGE_TEXT_TOTAL_CHARS = 32_000;
const MAX_CANVAS_MARKDOWN_CHARS = 12_000;
const MAX_CANVAS_MARKDOWN_TOTAL_CHARS = 36_000;
const MAX_CANVAS_FETCHES = 5;
const MAX_COMPACT_LIST_ITEMS = 200;
const MAX_GENERIC_ARRAY_ITEMS = 25;
const MAX_GENERIC_STRING_CHARS = 4_000;
const MAX_GENERIC_DEPTH = 4;

const GENERIC_NOISE_KEYS = new Set([
  "blocks",
  "title_blocks",
  "shares",
  "dm_mpdm_users_with_file_access",
  "editors",
  "enterprise_user",
  "favorites",
  "pending_shared",
  "response_metadata",
]);

function nonEmpty(value) {
  return value !== undefined && value !== null && value !== "";
}

function firstNonEmpty(...values) {
  return values.find(nonEmpty);
}

function unixSecondsToIso(value) {
  if (!nonEmpty(value)) return undefined;
  const seconds = Number.parseFloat(String(value));
  if (!Number.isFinite(seconds)) return undefined;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function compactRecord(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => nonEmpty(value)));
}

function decodeHtmlEntities(value) {
  return String(value || "").replace(
    /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (match, entity) => {
      const lower = entity.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos") return "'";
      if (lower === "nbsp") return " ";
      const radix = lower.startsWith("#x") ? 16 : 10;
      const digits = lower.replace(/^#x?/, "");
      const codePoint = Number.parseInt(digits, radix);
      try {
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
      } catch {
        return match;
      }
    },
  );
}

function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
}

function appendMarkdown(state, value) {
  if (!value) return;
  if (state.inPre) {
    state.output += value;
    return;
  }
  const normalized = value.replace(/\s+/g, " ");
  if (!normalized.trim()) {
    if (state.output && !/[\s\n]$/.test(state.output)) state.output += " ";
    return;
  }
  if (state.output && !/[\s\n`*_[({>]$/.test(state.output) && !/^[\s,.;:!?)}\]]/.test(normalized)) {
    state.output += " ";
  }
  state.output += normalized;
}

function ensureNewlines(state, count = 1) {
  state.output = state.output.replace(/[ \t]+$/g, "");
  const existing = state.output.match(/\n*$/)?.[0].length || 0;
  if (existing < count) state.output += "\n".repeat(count - existing);
}

/** Convert Slack's downloadable canvas HTML into bounded, readable Markdown. */
export function canvasHtmlToMarkdown(html) {
  const sanitized = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  const state = {
    output: "",
    inPre: false,
    listStack: [],
    linkStack: [],
    blockquoteDepth: 0,
  };
  const tokens = sanitized.match(/<[^>]+>|[^<]+/g) || [];

  for (const token of tokens) {
    if (!token.startsWith("<")) {
      appendMarkdown(state, decodeHtmlEntities(token));
      continue;
    }

    const closing = /^<\s*\//.test(token);
    const name = token.match(/^<\s*\/?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase();
    if (!name) continue;

    if (!closing) {
      if (/^h[1-6]$/.test(name)) {
        ensureNewlines(state, 2);
        state.output += `${"#".repeat(Number(name.slice(1)))} `;
      } else if (["p", "div", "section", "article"].includes(name)) {
        ensureNewlines(state, state.output ? 2 : 0);
      } else if (name === "br") {
        ensureNewlines(state, 1);
      } else if (name === "ul" || name === "ol") {
        state.listStack.push(name);
        ensureNewlines(state, 1);
      } else if (name === "li") {
        ensureNewlines(state, 1);
        const depth = Math.max(0, state.listStack.length - 1);
        const marker = state.listStack.at(-1) === "ol" ? "1. " : "- ";
        state.output += `${"  ".repeat(depth)}${marker}`;
      } else if (name === "strong" || name === "b") {
        state.output += "**";
      } else if (name === "em" || name === "i") {
        state.output += "*";
      } else if (name === "s" || name === "del") {
        state.output += "~~";
      } else if (name === "code" && !state.inPre) {
        state.output += "`";
      } else if (name === "pre") {
        ensureNewlines(state, 2);
        state.output += "```\n";
        state.inPre = true;
      } else if (name === "blockquote") {
        ensureNewlines(state, 2);
        state.blockquoteDepth += 1;
        state.output += `${"> ".repeat(state.blockquoteDepth)}`;
      } else if (name === "a") {
        const href = attributeValue(token, "href");
        state.linkStack.push(href);
        if (href) state.output += "[";
      } else if (name === "input" && /\btype\s*=\s*["']?checkbox/i.test(token)) {
        state.output += /\bchecked\b/i.test(token) ? "[x] " : "[ ] ";
      } else if (name === "hr") {
        ensureNewlines(state, 2);
        state.output += "---";
        ensureNewlines(state, 2);
      } else if (name === "tr") {
        ensureNewlines(state, 1);
      } else if (name === "th" || name === "td") {
        if (!state.output.endsWith("| ")) state.output += "| ";
      }
      continue;
    }

    if (/^h[1-6]$/.test(name) || ["p", "section", "article"].includes(name)) {
      ensureNewlines(state, 2);
    } else if (name === "div") {
      ensureNewlines(state, 1);
    } else if (name === "ul" || name === "ol") {
      state.listStack.pop();
      ensureNewlines(state, state.listStack.length ? 1 : 2);
    } else if (name === "li") {
      ensureNewlines(state, 1);
    } else if (name === "strong" || name === "b") {
      state.output += "**";
    } else if (name === "em" || name === "i") {
      state.output += "*";
    } else if (name === "s" || name === "del") {
      state.output += "~~";
    } else if (name === "code" && !state.inPre) {
      state.output += "`";
    } else if (name === "pre") {
      state.output = state.output.replace(/[ \t]+$/g, "");
      ensureNewlines(state, 1);
      state.output += "```";
      state.inPre = false;
      ensureNewlines(state, 2);
    } else if (name === "blockquote") {
      state.blockquoteDepth = Math.max(0, state.blockquoteDepth - 1);
      ensureNewlines(state, 2);
    } else if (name === "a") {
      const href = state.linkStack.pop();
      if (href) state.output += `](${href})`;
    } else if (name === "th" || name === "td") {
      state.output = state.output.replace(/[ \t]+$/g, "");
      state.output += " | ";
    } else if (name === "tr") {
      ensureNewlines(state, 1);
    }
  }

  return state.output
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+|\s+$/g, "");
}

function richTextElementText(element) {
  if (!element || typeof element !== "object") return "";
  if (element.type === "text") return element.text || "";
  if (element.type === "link") return element.text ? `[${element.text}](${element.url})` : element.url || "";
  if (element.type === "user") return element.user_id ? `<@${element.user_id}>` : "";
  if (element.type === "channel") return element.channel_id ? `<#${element.channel_id}>` : "";
  if (element.type === "emoji") return element.name ? `:${element.name}:` : "";
  if (element.type === "date") return element.fallback || element.timestamp || "";
  if (Array.isArray(element.elements)) return element.elements.map(richTextElementText).join("");
  return "";
}

export function slackMessageText(message = {}) {
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  const parts = [];
  for (const block of message.blocks || []) {
    if (typeof block?.text?.text === "string") parts.push(block.text.text);
    else if (Array.isArray(block?.elements)) parts.push(block.elements.map(richTextElementText).join(""));
  }
  if (parts.some((part) => part.trim())) return parts.filter(Boolean).join("\n").trim();
  for (const attachment of message.attachments || []) {
    const text = firstNonEmpty(attachment?.text, attachment?.fallback, attachment?.title);
    if (text) parts.push(String(text));
  }
  return parts.filter(Boolean).join("\n").trim();
}

function compactUser(user = {}) {
  const profile = user.profile || {};
  return compactRecord({
    id: user.id,
    username: firstNonEmpty(user.name, user.username),
    display_name: profile.display_name,
    real_name: firstNonEmpty(profile.real_name, user.real_name),
    title: profile.title,
    is_bot: user.is_bot || undefined,
    deleted: user.deleted || undefined,
  });
}

function conversationKind(channel = {}) {
  if (channel.is_im) return "dm";
  if (channel.is_mpim) return "group_dm";
  if (channel.is_group || channel.is_private) return "private_channel";
  return "channel";
}

function userLabel(user = {}) {
  return firstNonEmpty(user.display_name, user.real_name, user.username, user.name, user.id);
}

function compactConversation(channel = {}, users = {}) {
  const kind = conversationKind(channel);
  const dmUser = channel.user ? users[channel.user] : undefined;
  const rawName = firstNonEmpty(channel.name_normalized, channel.name);
  const name = kind === "dm" && dmUser
    ? `DM with ${userLabel(dmUser)}`
    : firstNonEmpty(rawName, kind === "group_dm" ? "Group DM" : undefined, channel.id);
  return compactRecord({
    id: channel.id,
    name,
    kind,
    user_id: channel.user,
    topic: channel.topic?.value,
    purpose: channel.purpose?.value,
    is_archived: channel.is_archived || undefined,
  });
}

function rawUserMap(result = {}) {
  const users = {};
  const add = (user, id) => {
    if (!user && !id) return;
    const compact = compactUser({ ...(user || {}), id: firstNonEmpty(user?.id, id) });
    if (compact.id) users[compact.id] = { ...(users[compact.id] || {}), ...compact };
  };
  if (Array.isArray(result.members)) result.members.forEach((user) => add(user));
  if (result.user) add(result.user);
  if (result.users && !Array.isArray(result.users)) {
    for (const [id, user] of Object.entries(result.users)) add(user, id);
  }
  return users;
}

function rawConversationMap(result = {}) {
  const conversations = {};
  const add = (channel, id) => {
    if (!channel && !id) return;
    const resolved = { ...(channel || {}), id: firstNonEmpty(channel?.id, id) };
    if (resolved.id) conversations[resolved.id] = { ...(conversations[resolved.id] || {}), ...resolved };
  };
  if (Array.isArray(result.channels)) result.channels.forEach((channel) => add(channel));
  if (result.channel) add(result.channel);
  for (const key of ["channels", "groups", "ims"]) {
    if (result[key] && !Array.isArray(result[key])) {
      for (const [id, channel] of Object.entries(result[key])) add(channel, id);
    }
  }
  return conversations;
}

async function enrichUsers(ids, users, api, signal) {
  if (typeof api !== "function") return;
  const unresolved = [...new Set(ids)].filter((id) => id && !(users[id]?.username || users[id]?.real_name || users[id]?.display_name));
  if (!unresolved.length) return;

  if (unresolved.length > 8) {
    try {
      const result = await api("users.list", { limit: 200 }, { signal });
      for (const user of result?.members || []) {
        if (unresolved.includes(user.id)) users[user.id] = compactUser(user);
      }
    } catch {}
    return;
  }

  await Promise.all(unresolved.map(async (id) => {
    try {
      const result = await api("users.info", { user: id }, { signal });
      if (result?.ok && result.user) users[id] = compactUser(result.user);
    } catch {}
  }));
}

async function enrichMessageMetadata(messages, conversations, users, api, signal) {
  if (typeof api !== "function") return;
  const conversationIds = [...new Set(messages.map((message) => firstNonEmpty(message.channel_id, message.channel?.id)).filter(Boolean))];
  await Promise.all(conversationIds.map(async (id) => {
    if (conversations[id]?.name || conversations[id]?.user) return;
    try {
      const result = await api("conversations.info", { channel: id }, { signal });
      if (result?.ok && result.channel) conversations[id] = result.channel;
    } catch {}
  }));

  const userIds = new Set(messages.map((message) => message.user).filter(Boolean));
  for (const channel of Object.values(conversations)) {
    if (channel.user) userIds.add(channel.user);
  }
  await enrichUsers(userIds, users, api, signal);
}

function messageAttachmentIds(message = {}) {
  return [...new Set((message.attachments || [])
    .map((attachment) => firstNonEmpty(attachment?.id, attachment?.file_id, attachment?.callback_id))
    .filter(Boolean))];
}

function compactMessages(messages, conversations, users) {
  const groups = [];
  let textBudget = MAX_MESSAGE_TEXT_TOTAL_CHARS;
  for (const rawMessage of messages) {
    const conversationId = firstNonEmpty(rawMessage.channel_id, rawMessage.channel?.id, "unknown");
    if (rawMessage.channel?.id) conversations[rawMessage.channel.id] = rawMessage.channel;
    if (rawMessage.user && rawMessage.username && !users[rawMessage.user]) {
      users[rawMessage.user] = compactUser({ id: rawMessage.user, name: rawMessage.username });
    }
    const originalText = slackMessageText(rawMessage);
    const available = Math.max(0, Math.min(MAX_MESSAGE_TEXT_CHARS, textBudget));
    const truncated = originalText.length > available;
    const text = available > 0
      ? `${originalText.slice(0, Math.max(0, available - (truncated ? 1 : 0)))}${truncated ? "…" : ""}`
      : "";
    textBudget -= text.length;
    const fileIds = [...new Set((rawMessage.files || []).map((file) => file?.id).filter(Boolean))];
    const attachmentIds = messageAttachmentIds(rawMessage);
    const message = compactRecord({
      ts: rawMessage.ts,
      timestamp: unixSecondsToIso(rawMessage.ts),
      user_id: firstNonEmpty(rawMessage.user, rawMessage.bot_id),
      text,
      text_truncated: truncated || undefined,
      thread_ts: rawMessage.thread_ts,
      reply_count: rawMessage.reply_count,
      permalink: rawMessage.permalink,
      file_ids: fileIds.length ? fileIds : undefined,
      attachment_ids: attachmentIds.length ? attachmentIds : undefined,
      attachment_count: rawMessage.attachments?.length || undefined,
      reactions: rawMessage.reactions?.map((reaction) => compactRecord({ name: reaction.name, count: reaction.count })),
    });
    const previous = groups.at(-1);
    if (previous?.conversation?.id === conversationId) {
      previous.messages.push(message);
    } else {
      const channel = conversations[conversationId] || { id: conversationId };
      groups.push({ conversation: compactConversation(channel, users), messages: [message] });
    }
  }
  return groups;
}

function resultMessages(method, result = {}) {
  if (method === "search.messages") return result.messages?.matches || [];
  if (method === "chat.postMessage") return result.message ? [{ ...result.message, channel_id: result.channel, ts: firstNonEmpty(result.ts, result.message.ts) }] : [];
  return Array.isArray(result.messages) ? result.messages : [];
}

function totalForMessages(method, result, messages) {
  if (method === "search.messages") return firstNonEmpty(result.messages?.total, result.messages?.pagination?.total_count, messages.length);
  return messages.length;
}

async function compactMessageResult(method, result, params, options) {
  const messages = resultMessages(method, result);
  const users = rawUserMap(result);
  const conversations = rawConversationMap(result);
  for (const message of messages) {
    if (message.channel?.id) conversations[message.channel.id] = message.channel;
    if (params.channel && !message.channel_id) message.channel_id = params.channel;
  }
  await enrichMessageMetadata(messages, conversations, users, options.api, options.signal);
  const groups = compactMessages(messages, conversations, users);
  return compactRecord({
    ok: result.ok,
    query: result.query,
    total: totalForMessages(method, result, messages),
    returned: messages.length,
    message_groups: groups,
    users: Object.keys(users).length ? users : undefined,
    has_more: result.has_more || undefined,
    next_cursor: result.response_metadata?.next_cursor,
    error: result.error,
  });
}

function fileProvenance(file = {}) {
  const byId = new Map();
  for (const visibility of ["public", "private"]) {
    for (const [id, shares] of Object.entries(file.shares?.[visibility] || {})) {
      const first = Array.isArray(shares) ? shares[0] : undefined;
      byId.set(id, compactRecord({ id, name: first?.channel_name, kind: visibility === "private" ? "private_channel" : "channel" }));
    }
  }
  for (const id of file.channels || []) if (!byId.has(id)) byId.set(id, { id, kind: "channel" });
  for (const id of file.groups || []) if (!byId.has(id)) byId.set(id, { id, kind: "private_channel" });
  for (const id of file.ims || []) if (!byId.has(id)) byId.set(id, { id, kind: "dm" });
  return [...byId.values()];
}

function fileMatches(result = {}) {
  if (result.file) return [result.file];
  if (Array.isArray(result.files)) return result.files;
  return result.files?.matches || [];
}

function isCanvas(file = {}) {
  return file.mimetype === "application/vnd.slack-docs" || file.pretty_type === "Canvas" || file.mode === "quip";
}

async function enrichFileUsers(files, users, api, signal) {
  await enrichUsers(files.map((file) => file.user).filter(Boolean), users, api, signal);
}

async function compactFileResult(method, result, params, options) {
  const files = fileMatches(result);
  const users = rawUserMap(result);
  await enrichFileUsers(files, users, options.api, options.signal);
  let markdownBudget = MAX_CANVAS_MARKDOWN_TOTAL_CHARS;
  let canvasFetches = 0;
  let omittedCanvasFetches = 0;
  const compactFiles = [];

  for (const file of files) {
    const compact = compactRecord({
      id: file.id,
      title: firstNonEmpty(file.title, file.name),
      type: firstNonEmpty(file.pretty_type, file.filetype, file.mimetype),
      user_id: file.user,
      created_at: unixSecondsToIso(firstNonEmpty(file.created, file.timestamp)),
      updated_at: unixSecondsToIso(file.updated),
      size_bytes: file.size,
      permalink: file.permalink,
      provenance: fileProvenance(file),
      access: file.access,
    });

    if (isCanvas(file)) {
      if (typeof options.fetchCanvas === "function" && canvasFetches < MAX_CANVAS_FETCHES && markdownBudget > 0) {
        canvasFetches += 1;
        try {
          const html = await options.fetchCanvas(file, { signal: options.signal });
          const fullMarkdown = canvasHtmlToMarkdown(html);
          const available = Math.max(0, Math.min(MAX_CANVAS_MARKDOWN_CHARS, markdownBudget));
          const truncated = fullMarkdown.length > available;
          compact.content_markdown = available > 0
            ? `${fullMarkdown.slice(0, Math.max(0, available - (truncated ? 1 : 0)))}${truncated ? "…" : ""}`
            : "";
          compact.content_truncated = truncated || undefined;
          compact.content_status = "ok";
          markdownBudget -= compact.content_markdown.length;
        } catch (error) {
          compact.content_status = "unavailable";
          compact.content_error = error?.message || String(error);
        }
      } else {
        omittedCanvasFetches += 1;
        compact.content_status = "omitted_budget";
      }
    }
    compactFiles.push(compactRecord(compact));
  }

  return compactRecord({
    ok: result.ok,
    query: result.query,
    total: firstNonEmpty(result.files?.total, result.files?.pagination?.total_count, files.length),
    returned: files.length,
    files: compactFiles,
    users: Object.keys(users).length ? users : undefined,
    canvas_content: canvasFetches || omittedCanvasFetches
      ? { fetched: canvasFetches, omitted: omittedCanvasFetches, max_fetches: MAX_CANVAS_FETCHES }
      : undefined,
    error: result.error,
  });
}

async function compactConversationResult(result = {}, options = {}) {
  const users = rawUserMap(result);
  const channels = result.channel ? [result.channel] : (Array.isArray(result.channels) ? result.channels : []);
  const kept = channels.slice(0, MAX_COMPACT_LIST_ITEMS);
  await enrichFileUsers(kept.map((channel) => ({ user: channel.user })), users, options.api, options.signal);
  return compactRecord({
    ok: result.ok,
    count: firstNonEmpty(result.count, channels.length),
    returned: kept.length,
    omitted: channels.length > kept.length ? channels.length - kept.length : undefined,
    conversations: kept.map((channel) => compactConversation(channel, users)),
    users: Object.keys(users).length ? users : undefined,
    next_cursor: result.response_metadata?.next_cursor,
    error: result.error,
  });
}

function compactUserResult(result = {}) {
  const members = result.user ? [result.user] : (Array.isArray(result.members) ? result.members : []);
  const kept = members.slice(0, MAX_COMPACT_LIST_ITEMS);
  return compactRecord({
    ok: result.ok,
    count: firstNonEmpty(result.count, members.length),
    returned: kept.length,
    omitted: members.length > kept.length ? members.length - kept.length : undefined,
    users: kept.map(compactUser),
    next_cursor: result.response_metadata?.next_cursor,
    error: result.error,
  });
}

function compactGenericValue(value, depth = 0) {
  if (typeof value === "string") {
    return value.length > MAX_GENERIC_STRING_CHARS ? `${value.slice(0, MAX_GENERIC_STRING_CHARS - 1)}…` : value;
  }
  if (value === null || ["number", "boolean"].includes(typeof value)) return value;
  if (depth >= MAX_GENERIC_DEPTH) {
    if (Array.isArray(value)) return { omitted_items: value.length };
    return { omitted_fields: Object.keys(value || {}).length };
  }
  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_GENERIC_ARRAY_ITEMS).map((item) => compactGenericValue(item, depth + 1));
    if (value.length > kept.length) kept.push({ omitted_items: value.length - kept.length });
    return kept;
  }
  if (typeof value !== "object") return String(value);
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (GENERIC_NOISE_KEYS.has(key)) {
      if (Array.isArray(nested) && nested.length) out[`${key}_ids`] = nested.map((item) => item?.id).filter(Boolean);
      continue;
    }
    const compacted = compactGenericValue(nested, depth + 1);
    if (nonEmpty(compacted)) out[key] = compacted;
  }
  return out;
}

/** Compact a Slack Web API response. Pass raw=true at the tool boundary to skip this entirely. */
export async function compactSlackResponse(method, result = {}, params = {}, options = {}) {
  if (!result || typeof result !== "object") return result;
  if (result.ok === false) return compactRecord({ ok: false, error: result.error, needed: result.needed, provided: result.provided });
  if (["search.messages", "conversations.history", "conversations.replies", "chat.postMessage"].includes(method)) {
    return compactMessageResult(method, result, params, options);
  }
  if (["search.files", "files.info"].includes(method)) {
    return compactFileResult(method, result, params, options);
  }
  if (["conversations.list", "conversations.info"].includes(method)) return compactConversationResult(result, options);
  if (["users.list", "users.info"].includes(method)) return compactUserResult(result);
  if (method === "auth.test") {
    return compactRecord({ ok: result.ok, user: result.user, user_id: result.user_id, team: result.team, team_id: result.team_id, enterprise_id: result.enterprise_id, error: result.error });
  }
  return compactGenericValue(result);
}

export const slackCompactLimits = Object.freeze({
  maxMessageTextChars: MAX_MESSAGE_TEXT_CHARS,
  maxMessageTextTotalChars: MAX_MESSAGE_TEXT_TOTAL_CHARS,
  maxCanvasMarkdownChars: MAX_CANVAS_MARKDOWN_CHARS,
  maxCanvasMarkdownTotalChars: MAX_CANVAS_MARKDOWN_TOTAL_CHARS,
  maxCanvasFetches: MAX_CANVAS_FETCHES,
  maxCompactListItems: MAX_COMPACT_LIST_ITEMS,
});
