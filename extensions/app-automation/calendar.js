export function calendarExtractorScript({ app = "calendar", kind = "events.snapshot", includePatterns = [] } = {}) {
  const patternSource = JSON.stringify(includePatterns);
  return `(() => {
  const includePatterns = ${patternSource}.map((pattern) => new RegExp(pattern, 'i'));
  const selectors = [
    '[role="button"]',
    '[role="gridcell"]',
    '[role="listitem"]',
    '[aria-label]',
    '[data-eventid]',
    '[data-testid]',
    '[title]'
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
      const hrefs = linksFor(element);
      const time = timeFor(element);
      const key = text + '|' + hrefs.join('|') + '|' + (time || '');
      if (!text || text.length < 3 || seen.has(key)) continue;
      if (includePatterns.length && !includePatterns.some((pattern) => pattern.test(text))) continue;
      seen.add(key);
      items.push({ text, selector, hrefs, ...(time ? { time } : {}) });
    }
  }
  return { source: 'playwright-dom', app: ${JSON.stringify(app)}, kind: ${JSON.stringify(kind)}, url: location.href, title: document.title, items };
})()`;
}
