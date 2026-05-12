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
    const limitMatch = lower.match(/^limit[:=](\d+)$/);
    if (limitMatch && !filters.linkLimit) {
      filters.linkLimit = Number(limitMatch[1]);
      continue;
    }
    const staleAfterMatch = lower.match(/^(?:stale-after|staleafter|stale-after-minutes|staleafterminutes)[:=](\d+)$/);
    if (staleAfterMatch && !filters.staleAfterMinutes) {
      filters.staleAfterMinutes = Number(staleAfterMatch[1]);
      continue;
    }
    queryWords.push(text);
  }
  filters.query = queryWords.join(" ");
  return filters;
}

export function parseLinkCommandArgs(words = [], { appIds = [] } = {}) {
  const args = words.map((word) => String(word || "").trim()).filter(Boolean);
  const knownApps = new Set(["all", "*", ...appIds.map(normalizeWord).filter(Boolean)]);
  let app;
  if (args.length && knownApps.has(normalizeWord(args[0]))) {
    app = args.shift();
  }
  let filters = parseLinkCommandFilters(args);
  if (!filters.linkLimit) {
    const maybeLimit = Number(args.at(-1));
    const hasLegacyLimit = Number.isFinite(maybeLimit) && args.length > 1;
    if (hasLegacyLimit) {
      filters = parseLinkCommandFilters(args.slice(0, -1));
      filters.linkLimit = maybeLimit;
    }
  }
  return {
    app,
    ...filters,
  };
}

export function parseOverviewCommandArgs(words = [], { appIds = [], defaultAppIds = [] } = {}) {
  const args = words.map((word) => String(word || "").trim()).filter(Boolean);
  const appIdSet = new Set(appIds.map(normalizeWord).filter(Boolean));
  let includeLinks = false;
  let linkFreshness;
  let linkKind;
  let linkLimitPerApp;
  let linkQuery;
  let linkSort;
  let staleAfterMinutes;
  const appTokens = [];
  for (const word of args) {
    const lower = normalizeWord(word);
    if (["links", "--links"].includes(lower)) {
      includeLinks = true;
      continue;
    }
    const freshnessMatch = lower.match(/^freshness[:=](fresh|stale|unknown)$/);
    if (!linkFreshness && (["fresh", "stale", "unknown"].includes(lower) || freshnessMatch)) {
      includeLinks = true;
      linkFreshness = freshnessMatch ? freshnessMatch[1] : lower;
      continue;
    }
    const kindMatch = word.match(/^kind[:=](.+)$/i);
    if (kindMatch && !linkKind) {
      includeLinks = true;
      linkKind = kindMatch[1];
      continue;
    }
    const linkQueryMatch = word.match(/^(?:link-query|linkquery|query|q)[:=](.+)$/i);
    if (linkQueryMatch && !linkQuery) {
      includeLinks = true;
      linkQuery = linkQueryMatch[1];
      continue;
    }
    const linkLimitMatch = lower.match(/^(?:link-limit|linklimit|links-limit|linkslimit)[:=](\d+)$/);
    if (linkLimitMatch && !linkLimitPerApp) {
      includeLinks = true;
      linkLimitPerApp = Number(linkLimitMatch[1]);
      continue;
    }
    const linkSortMatch = lower.match(/^(?:link-sort|linksort|sort|order)[:=](.+)$/);
    if (linkSortMatch && !linkSort && LINK_SORTS.has(linkSortMatch[1])) {
      includeLinks = true;
      linkSort = linkSortMatch[1];
      continue;
    }
    const staleAfterMatch = lower.match(/^(?:stale-after|staleafter|stale-after-minutes|staleafterminutes)[:=](\d+)$/);
    if (staleAfterMatch && !staleAfterMinutes) {
      staleAfterMinutes = Number(staleAfterMatch[1]);
      continue;
    }
    appTokens.push(word);
  }
  const wantsAll = appTokens.some((word) => ["all", "*"].includes(normalizeWord(word)));
  const apps = wantsAll
    ? appIds
    : appTokens.filter((word) => appIdSet.has(normalizeWord(word)));
  return {
    includeLinks,
    apps: apps.length ? apps : defaultAppIds,
    ...(linkFreshness ? { linkFreshness } : {}),
    ...(linkKind ? { linkKind } : {}),
    ...(linkLimitPerApp ? { linkLimitPerApp } : {}),
    ...(linkQuery ? { linkQuery } : {}),
    ...(linkSort ? { linkSort } : {}),
    ...(staleAfterMinutes ? { staleAfterMinutes } : {}),
  };
}
