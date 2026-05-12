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
  const absoluteHref = (href) => {
    try {
      const parsed = new URL(href, location.href);
      if (!['http:', 'https:'].includes(parsed.protocol)) return null;
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch (_) {
      return null;
    }
  };
  const linksFor = (element) => {
    const urls = [];
    const add = (href) => {
      const url = absoluteHref(href);
      if (url && !urls.includes(url)) urls.push(url);
    };
    const ownLink = element.closest?.('a[href]');
    if (ownLink) add(ownLink.getAttribute('href'));
    for (const link of element.querySelectorAll?.('a[href]') || []) add(link.getAttribute('href'));
    return urls;
  };
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
      const ariaLabel = (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const dataQa = element.getAttribute('data-qa') || '';
      const hrefs = linksFor(element);
      const key = dataQa + '|' + ariaLabel + '|' + text + '|' + hrefs.join('|');
      if ((!text && !ariaLabel) || seen.has(key)) continue;
      seen.add(key);
      items.push({ text, ariaLabel, dataQa, hrefs });
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

function sanitizeSnapshotUrl(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

function collectUrls(item = {}) {
  const candidates = [item.url, item.href, item.link, item.canonicalUrl];
  for (const value of [item.urls, item.hrefs, item.links]) {
    if (Array.isArray(value)) candidates.push(...value);
    else if (value) candidates.push(value);
  }
  const seen = new Set();
  const urls = [];
  for (const candidate of candidates) {
    const url = sanitizeSnapshotUrl(candidate);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function slackSourceLabel(label) {
  const source = normalizeWhitespace(label).replace(/\s+\d{1,4}\s*(?:unread|new|mentions?|replies?)?\s*$/i, "").trim();
  return source || normalizeWhitespace(label) || null;
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
  const label = text.replace(/\s+\d{1,4}\s*$/, "").trim() || text;
  return {
    label,
    text,
    source: slackSourceLabel(label),
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
    if (parsed) candidates.push({ ...parsed, dataQa: item.dataQa || null, urls: collectUrls(item) });
  }
  const deduped = [];
  const seen = new Set();
  for (const item of candidates) {
    const key = `${item.text.toLowerCase()}|${item.urls[0] || ""}`;
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
    notifications: deduped.map((item) => ({ ...item, ...(item.urls[0] ? { url: item.urls[0] } : {}) })),
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
      const label = String(item.label || "").replace(/[\[\]]/g, "");
      const renderedLabel = item.url ? `[${label}](${item.url})` : item.label;
      const extraUrls = Array.isArray(item.urls) && item.urls.length > 1 ? ` — additional links: ${item.urls.slice(1).join(", ")}` : "";
      lines.push(`- ${renderedLabel}${badges ? ` (${badges})` : ""}${extraUrls}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function slackExtractorScript() {
  return SLACK_EXTRACTOR_SCRIPT;
}
