import { writeFile } from "node:fs/promises";
import path from "node:path";

function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function splitSourceText(sourceText) {
  return String(sourceText || "")
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function parseItems(input = {}) {
  if (Array.isArray(input.items)) return input.items.map((item) => normalizeWhitespace(item.text || item.label || item.ariaLabel || item)).filter(Boolean);
  if (Array.isArray(input)) return input.map((item) => normalizeWhitespace(item.text || item.label || item)).filter(Boolean);
  if (typeof input === "string") return splitSourceText(input);
  if (typeof input.sourceText === "string") return splitSourceText(input.sourceText);
  return [];
}

export function buildGenericSnapshot({ app, kind, input = {}, includePatterns = [] } = {}) {
  const sourceItems = parseItems(input);
  const patterns = includePatterns.map((pattern) => new RegExp(pattern, "i"));
  const items = patterns.length
    ? sourceItems.filter((item) => patterns.some((pattern) => pattern.test(item)))
    : sourceItems;
  return {
    version: 1,
    app,
    kind,
    status: items.length ? "ok" : "empty",
    capturedAt: new Date().toISOString(),
    count: items.length,
    items: items.map((text, index) => ({ index, text })),
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
  for (const item of snapshot.items) lines.push(`- ${item.text}`);
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
