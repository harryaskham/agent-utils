export function parseLinkCommandFilters(words = []) {
  const queryWords = [];
  const filters = { query: "" };
  const freshnessWords = new Set(["fresh", "stale", "unknown"]);
  for (const word of words) {
    const text = String(word || "").trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    const freshnessMatch = lower.match(/^freshness[:=](fresh|stale|unknown)$/);
    if (!filters.freshness && (freshnessWords.has(lower) || freshnessMatch)) {
      filters.freshness = freshnessMatch ? freshnessMatch[1] : lower;
      continue;
    }
    const kindMatch = text.match(/^kind[:=](.+)$/i);
    if (kindMatch && !filters.kind) {
      filters.kind = kindMatch[1];
      continue;
    }
    queryWords.push(text);
  }
  filters.query = queryWords.join(" ");
  return filters;
}
