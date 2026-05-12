import { writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitSourceText(sourceText) {
  return String(sourceText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .map((text) => ({ text, urls: [] }));
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

function compactMetadata(value, limit = 120) {
  if (typeof value === "boolean") return null;
  const text = normalizeWhitespace(value);
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function contextFields(item = {}) {
  const context = {};
  for (const [target, candidates] of Object.entries({
    source: [item.channel, item.team, item.folder, item.calendar, item.source],
    from: [item.from, item.sender, item.organizer, item.author],
    time: [item.time, item.timestamp, item.start, item.startTime, item.date, item.when],
  })) {
    const value = candidates.map((candidate) => compactMetadata(candidate)).find(Boolean);
    if (value) context[target] = value;
  }
  return context;
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return { text: normalizeWhitespace(item), urls: [] };
  const text = normalizeWhitespace(item.text || item.label || item.ariaLabel || item.title || "");
  return { text, urls: collectUrls(item), context: contextFields(item) };
}

function parseItems(input = {}) {
  if (Array.isArray(input.items)) return input.items.map(normalizeItem).filter((item) => item.text);
  if (Array.isArray(input)) return input.map(normalizeItem).filter((item) => item.text);
  if (typeof input === "string") return splitSourceText(input);
  if (typeof input.sourceText === "string") return splitSourceText(input.sourceText);
  return [];
}

export function buildGenericSnapshot({ app, kind, input = {}, includePatterns = [] } = {}) {
  const sourceItems = parseItems(input);
  const patterns = includePatterns.map((pattern) => new RegExp(pattern, "i"));
  const filteredItems = patterns.length
    ? sourceItems.filter((item) => patterns.some((pattern) => pattern.test(item.text)))
    : sourceItems;
  const items = [];
  const seen = new Set();
  for (const item of filteredItems) {
    const key = `${item.text.toLowerCase()}|${item.urls[0] || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return {
    version: 1,
    app,
    kind,
    status: items.length ? "ok" : "empty",
    capturedAt: new Date().toISOString(),
    count: items.length,
    items: items.map((item, index) => ({
      index,
      text: item.text,
      ...(Object.keys(item.context || {}).length ? item.context : {}),
      ...(item.urls[0] ? { url: item.urls[0], urls: item.urls } : {}),
    })),
  };
}

export function renderGenericMarkdown(snapshot) {
  const lines = [
    `# ${snapshot.app} ${snapshot.kind}`,
    "",
    `Captured: ${snapshot.capturedAt}`,
    `Status: ${snapshot.status}`,
    `Items: ${snapshot.count}`,
    "",
  ];
  if (!snapshot.items.length) lines.push("No matching items were detected.");
  for (const item of snapshot.items) {
    const label = String(item.text || "").replace(/[\[\]]/g, "");
    const context = [item.source ? `source: ${item.source}` : null, item.from ? `from: ${item.from}` : null, item.time ? `time: ${item.time}` : null].filter(Boolean).join("; ");
    const contextText = context ? ` — ${context}` : "";
    if (item.url) {
      const extraUrls = Array.isArray(item.urls) && item.urls.length > 1 ? ` — additional links: ${item.urls.slice(1).join(", ")}` : "";
      lines.push(`- [${label}](${item.url})${contextText}${extraUrls}`);
    } else {
      lines.push(`- ${item.text}${contextText}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export async function writeGenericSnapshot(snapshotDir, snapshot) {
  const safeKind = snapshot.kind.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const jsonPath = path.join(snapshotDir, `${safeKind}.json`);
  const markdownPath = path.join(snapshotDir, `${safeKind}.md`);
  await writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderGenericMarkdown(snapshot), "utf8");
  return { jsonPath, markdownPath };
}
