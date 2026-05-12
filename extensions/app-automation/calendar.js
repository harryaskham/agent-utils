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
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const text = [
        element.innerText || element.textContent || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || ''
      ].join(' ').replace(/\\s+/g, ' ').trim();
      if (!text || text.length < 3 || seen.has(text)) continue;
      if (includePatterns.length && !includePatterns.some((pattern) => pattern.test(text))) continue;
      seen.add(text);
      items.push({ text, selector });
    }
  }
  return { source: 'playwright-dom', app: ${JSON.stringify(app)}, kind: ${JSON.stringify(kind)}, url: location.href, title: document.title, items };
})()`;
}
