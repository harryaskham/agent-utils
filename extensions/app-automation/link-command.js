const LINK_SORTS = new Set(["newest", "oldest", "freshest", "stalest", "app", "kind"]);

function normalizeWord(value) {
  return String(value || "").trim().toLowerCase();
}

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
    const sortMatch = lower.match(/^(?:sort|order)[:=](.+)$/);
    if (sortMatch && !filters.sort && LINK_SORTS.has(sortMatch[1])) {
      filters.sort = sortMatch[1];
      continue;
    }
    queryWords.push(text);
  }
  filters.query = queryWords.join(" ");
  return filters;
}

export function parseLinkCommandArgs(words = [], { appIds = [] } = {}) {
  const args = words.map((word) => String(word || "").trim()).filter(Boolean);
  const maybeLimit = Number(args.at(-1));
  const hasLimit = Number.isFinite(maybeLimit) && args.length > 1;
  const rest = hasLimit ? args.slice(0, -1) : [...args];
  const knownApps = new Set(["all", "*", ...appIds.map(normalizeWord).filter(Boolean)]);
  let app;
  if (rest.length && knownApps.has(normalizeWord(rest[0]))) {
    app = rest.shift();
  }
  return {
    app,
    linkLimit: hasLimit ? maybeLimit : undefined,
    ...parseLinkCommandFilters(rest),
  };
}
