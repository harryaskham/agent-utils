export function microsoftExtractorScript({ app = "microsoft", kind = "notifications.snapshot", includePatterns = [] } = {}) {
  const patternSource = JSON.stringify(includePatterns);
  return `(() => {
  const includePatterns = ${patternSource}.map((pattern) => new RegExp(pattern, 'i'));
  const appName = ${JSON.stringify(app)};
  const snapshotKind = ${JSON.stringify(kind)};
  const selectors = [
    '[aria-label]',
    '[role="treeitem"]',
    '[role="listitem"]',
    '[data-testid]',
    '[data-tid]',
    '[title]'
  ];
  const ignoreChromePatterns = [
    /^search\b/i,
    /^(mail|calendar|people|files|teams chat|to do|onedrive)$/i,
    /^(new mail|new event|new message)$/i,
    /^(navigation|navigation pane|app launcher|settings|help|feedback|filter|filter applied|share|print|quick steps?|flag|unflag|flag \/ unflag|expand to see flag options)$/i,
    /keyboard shortcuts/i,
    /favorite|sent item|draft|github ci/i,
    /you can take multiple actions? on a message/i,
    /apply or remove calendar event filters/i,
    /share a calendar|print a copy of your calendar/i,
    /^ribbon\b/i,
    /^move [&] delete\b/i,
    /^respond\b/i,
    /create a new email message/i,
    /move this message to your archive folder/i,
    /this message as phishing/i,
    /go to today/i,
    /my calendars/i,
    /deselect all calendars/i,
    /loading calendar actions/i,
    /add a new calendar instruction/i
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
  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const sourceFor = () => {
    const href = String(location.href || '').toLowerCase();
    const calendarLike = snapshotKind.includes('calendar') || href.includes('/calendar');
    if (appName === 'outlook' && calendarLike) return 'Outlook Calendar';
    if (appName === 'outlook') return 'Outlook Mail';
    if (appName === 'teams' && calendarLike) return 'Teams Calendar';
    if (appName === 'teams') return 'Teams';
    return compact(document.title) || appName;
  };
  const metadataTextFor = (element) => [
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.closest?.('[aria-label]')?.getAttribute?.('aria-label'),
    element.closest?.('[title]')?.getAttribute?.('title'),
    element.innerText || element.textContent || ''
  ].map(compact).filter(Boolean).join(' | ');
  const fromFor = (element) => {
    const senderElement = element.querySelector?.('[data-testid*="Sender"], [data-testid*="sender"], [data-testid*="author"], [data-testid*="organizer"], [aria-label*="From"], [aria-label*="from"], [title*="From"], [title*="from"]');
    const senderText = compact(senderElement?.innerText || senderElement?.textContent || senderElement?.getAttribute?.('aria-label') || senderElement?.getAttribute?.('title'));
    if (senderText) return senderText.slice(0, 120);
    const match = metadataTextFor(element).match(/\b(?:from|sender|organizer|organiser|author)\s*:?\s*([^,;|•]{2,120})/i);
    if (!match) return null;
    return compact(match[1]).replace(/\s+(subject|sent|received|starts|start time|when)\b.*$/i, '').slice(0, 120) || null;
  };
  const timeFor = (element) => {
    const candidates = [
      element.getAttribute?.('datetime'),
      element.getAttribute?.('data-start'),
      element.getAttribute?.('data-start-time'),
      element.getAttribute?.('data-date'),
      element.querySelector?.('time')?.getAttribute?.('datetime'),
      element.querySelector?.('time')?.textContent,
      element.closest?.('time')?.getAttribute?.('datetime'),
      element.closest?.('time')?.textContent
    ].map(compact).filter(Boolean);
    return candidates[0] || null;
  };
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = [
        element.innerText || element.textContent || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ').replace(/\\s+/g, ' ').trim();
      if (ignoreChromePatterns.some((pattern) => pattern.test(text))) continue;
      const hrefs = linksFor(element);
      const time = timeFor(element);
      const source = sourceFor();
      const from = fromFor(element);
      const key = text + '|' + hrefs.join('|') + '|' + (time || '') + '|' + (from || '');
      if (!text || seen.has(key)) continue;
      if (includePatterns.length && !includePatterns.some((pattern) => pattern.test(text))) continue;
      seen.add(key);
      items.push({ text, selector, hrefs, ...(source ? { source } : {}), ...(from ? { from } : {}), ...(time ? { time } : {}) });
    }
  }
  return { source: 'playwright-dom', app: appName, kind: snapshotKind, url: location.href, title: document.title, items };
})()`;
}
