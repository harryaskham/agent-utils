const SLACK_EXTRACTOR_SCRIPT = `(() => {
  const selectors = [
    '[data-qa="channel_sidebar_name"]',
    '[data-qa="channel_sidebar_channel"]',
    '[data-qa="channel_sidebar_dm"]',
    '[data-qa="channel_sidebar_section"]',
    '[data-qa="virtual-list-item"]',
    '[aria-label]'
  ];
  const seen = new Set();
  const items = [];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const ariaLabel = (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const dataQa = element.getAttribute('data-qa') || '';
      const key = dataQa + '|' + ariaLabel + '|' + text;
      if ((!text && !ariaLabel) || seen.has(key)) continue;
      seen.add(key);
      items.push({ text, ariaLabel, dataQa });
    }
  }
  return { url: location.href, title: document.title, items };
})()`;

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function parseUnreadCount(text) {
  const normalized = normalizeWhitespace(text);
  const match = normalized.match(/(?:^|\D)(\d{1,4})(?:\s*(?:unread|new|mentions?|replies?))?(?:\D|$)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function classifySlackLine(line) {
  const text = normalizeWhitespace(line);
  const lower = text.toLowerCase();
  if (!text) return null;
  const count = parseUnreadCount(text);
  const mention = /\bmention\b|mentioned you|@/.test(lower);
  const dm = /\bdirect message\b|\bdm\b/.test(lower);
  const channel = /#|\bchannel\b/.test(lower);
  const unread = count !== null || /\bunread\b|\bnew message\b|\bnew messages\b/.test(lower);
  if (!unread && !mention) return null;
  return {
    label: text.replace(/\s+\d{1,4}\s*$/, "").trim() || text,
    text,
    unreadCount: count,
    mention,
    dm,
    channel,
  };
}

export function normalizeSlackExtraction(input = {}) {
  if (typeof input === "string") {
    return { source: "text", items: input.split(/\r?\n/).map((line) => ({ text: line, ariaLabel: "", dataQa: "" })) };
  }
  if (Array.isArray(input)) return { source: "array", items: input };
  if (Array.isArray(input.items)) return { source: input.source || "playwright", url: input.url, title: input.title, items: input.items };
  return { source: "empty", items: [] };
}

export function buildSlackNotificationSnapshot(input = {}, { now = new Date() } = {}) {
  const extraction = normalizeSlackExtraction(input);
  const candidates = [];
  for (const item of extraction.items) {
    const text = normalizeWhitespace([item.text, item.ariaLabel].filter(Boolean).join(" "));
    const parsed = classifySlackLine(text);
    if (parsed) candidates.push({ ...parsed, dataQa: item.dataQa || null });
  }
  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = item.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return {
    version: 1,
    app: "slack",
    kind: "notifications.snapshot",
    status: deduped.length > 0 ? "ok" : "empty",
    capturedAt: now.toISOString(),
    source: extraction.source,
    page: { url: extraction.url || null, title: extraction.title || null },
    counts: {
      items: deduped.length,
      mentions: deduped.filter((item) => item.mention).length,
      dms: deduped.filter((item) => item.dm).length,
      channels: deduped.filter((item) => item.channel).length,
    },
    notifications: deduped,
  };
}

export function renderSlackNotificationMarkdown(snapshot) {
  const lines = [
    "# Slack notifications",
    "",
    `Captured: ${snapshot.capturedAt}`,
    `Status: ${snapshot.status}`,
    `Source: ${snapshot.source}`,
    `Items: ${snapshot.counts.items}; mentions: ${snapshot.counts.mentions}; DMs: ${snapshot.counts.dms}; channels: ${snapshot.counts.channels}`,
    "",
  ];
  if (!snapshot.notifications.length) {
    lines.push("No unread Slack notifications were detected.");
  } else {
    for (const item of snapshot.notifications) {
      const badges = [
        item.unreadCount !== null ? `${item.unreadCount} unread` : null,
        item.mention ? "mention" : null,
        item.dm ? "dm" : null,
        item.channel ? "channel" : null,
      ].filter(Boolean).join(", ");
      lines.push(`- ${item.label}${badges ? ` (${badges})` : ""}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function slackExtractorScript() {
  return SLACK_EXTRACTOR_SCRIPT;
}
