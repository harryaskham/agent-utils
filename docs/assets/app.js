const sections = Array.from(document.querySelectorAll('[data-section]'));
const cards = Array.from(document.querySelectorAll('[data-tool-card]'));
const searchInput = document.querySelector('#tool-search');
const resultSummary = document.querySelector('#result-summary');
const routeLinks = Array.from(document.querySelectorAll('[data-route-link]'));

function currentRoute() {
  const hash = window.location.hash || '#/';
  const sectionMatch = hash.match(/^#\/section\/([a-z0-9-]+)$/);
  if (sectionMatch) return sectionMatch[1];
  return 'all';
}

function cardMatches(card, query) {
  if (!query) return true;
  return card.textContent.toLowerCase().includes(query);
}

function applyState() {
  const route = currentRoute();
  const query = (searchInput?.value || '').trim().toLowerCase();
  let visibleSections = 0;
  let visibleCards = 0;

  for (const section of sections) {
    const inRoute = route === 'all' || section.dataset.section === route;
    let sectionVisibleCards = 0;
    const sectionCards = Array.from(section.querySelectorAll('[data-tool-card]'));
    for (const card of sectionCards) {
      const visible = inRoute && cardMatches(card, query);
      card.hidden = !visible;
      if (visible) sectionVisibleCards += 1;
    }
    const sectionVisible = inRoute && sectionVisibleCards > 0;
    section.hidden = !sectionVisible;
    if (sectionVisible) visibleSections += 1;
    visibleCards += sectionVisibleCards;
  }

  for (const link of routeLinks) {
    const target = link.dataset.routeLink || 'all';
    const active = target === route || (route === 'all' && target === 'all');
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }

  if (resultSummary) {
    const routeText = route === 'all' ? 'all sections' : route.replaceAll('-', ' ');
    const queryText = query ? ` matching “${searchInput.value.trim()}”` : '';
    resultSummary.textContent = `${visibleCards} tool${visibleCards === 1 ? '' : 's'} across ${visibleSections} section${visibleSections === 1 ? '' : 's'} in ${routeText}${queryText}.`;
  }
}

window.addEventListener('hashchange', applyState);
searchInput?.addEventListener('input', applyState);
applyState();
