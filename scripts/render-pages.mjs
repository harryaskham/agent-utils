#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inventoryPath = resolve(repoRoot, 'docs/tools.json');
const indexPath = resolve(repoRoot, 'docs/index.html');
const checkOnly = process.argv.includes('--check');

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requireString(object, key, context) {
  if (!object || typeof object[key] !== 'string' || object[key].trim() === '') {
    throw new Error(`${context}.${key} must be a non-empty string`);
  }
}

function requireStringArray(object, key, context) {
  if (!Array.isArray(object?.[key]) || object[key].some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`${context}.${key} must be an array of non-empty strings`);
  }
}

function validateInventory(inventory) {
  requireString(inventory, 'title', 'inventory');
  requireString(inventory, 'description', 'inventory');
  requireString(inventory, 'lastReviewed', 'inventory');
  requireString(inventory?.publishing, 'githubPagesPath', 'inventory.publishing');
  requireString(inventory?.publishing, 'localPreview', 'inventory.publishing');
  requireString(inventory?.publishing, 'validation', 'inventory.publishing');

  if (!Array.isArray(inventory.sections) || inventory.sections.length === 0) {
    throw new Error('inventory.sections must contain at least one section');
  }

  inventory.sections.forEach((section, sectionIndex) => {
    const sectionContext = `inventory.sections[${sectionIndex}]`;
    requireString(section, 'name', sectionContext);
    requireString(section, 'summary', sectionContext);
    if (!Array.isArray(section.tools) || section.tools.length === 0) {
      throw new Error(`${sectionContext}.tools must contain at least one tool`);
    }

    section.tools.forEach((tool, toolIndex) => {
      const toolContext = `${sectionContext}.tools[${toolIndex}]`;
      for (const key of ['name', 'command', 'audience', 'purpose', 'sourceOfTruth']) {
        requireString(tool, key, toolContext);
      }
      requireStringArray(tool, 'commonActions', toolContext);
    });
  });
}

function renderTool(tool) {
  const actionItems = tool.commonActions
    .map((action) => `<li><code>${escapeHtml(action)}</code></li>`)
    .join('\n              ');

  return `
          <article class="tool-card">
            <div class="tool-card__header">
              <h3>${escapeHtml(tool.name)}</h3>
              <code>${escapeHtml(tool.command)}</code>
            </div>
            <p>${escapeHtml(tool.purpose)}</p>
            <dl>
              <div>
                <dt>Audience</dt>
                <dd>${escapeHtml(tool.audience)}</dd>
              </div>
              <div>
                <dt>Source of truth</dt>
                <dd>${escapeHtml(tool.sourceOfTruth)}</dd>
              </div>
            </dl>
            <details>
              <summary>Common actions</summary>
              <ul>
              ${actionItems}
              </ul>
            </details>
          </article>`;
}

function renderSection(section) {
  const tools = section.tools.map(renderTool).join('\n');
  return `
      <section class="inventory-section" id="${slug(section.name)}">
        <div class="section-heading">
          <h2>${escapeHtml(section.name)}</h2>
          <p>${escapeHtml(section.summary)}</p>
        </div>
        <div class="tool-grid">${tools}
        </div>
      </section>`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function renderPage(inventory) {
  const totalTools = inventory.sections.reduce((sum, section) => sum + section.tools.length, 0);
  const navItems = inventory.sections
    .map((section) => `<a href="#${slug(section.name)}">${escapeHtml(section.name)}</a>`)
    .join('\n          ');
  const sections = inventory.sections.map(renderSection).join('\n');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(inventory.title)}</title>
    <meta name="description" content="${escapeHtml(inventory.description)}">
    <link rel="stylesheet" href="assets/styles.css">
  </head>
  <body>
    <header class="site-header">
      <nav aria-label="Tool inventory sections">
        <a class="brand" href="./">agent-utils</a>
        <div class="nav-links">
          ${navItems}
        </div>
      </nav>
      <div class="hero">
        <p class="eyebrow">GitHub Pages · tool inventory</p>
        <h1>${escapeHtml(inventory.title)}</h1>
        <p>${escapeHtml(inventory.description)}</p>
        <div class="hero-stats" aria-label="Inventory summary">
          <span><strong>${inventory.sections.length}</strong> sections</span>
          <span><strong>${totalTools}</strong> tools and surfaces</span>
          <span><strong>${escapeHtml(inventory.lastReviewed)}</strong> reviewed</span>
        </div>
      </div>
    </header>

    <main>
      <section class="publishing-note" aria-labelledby="publishing-heading">
        <h2 id="publishing-heading">Publishing and preview</h2>
        <div class="publishing-grid">
          <p><strong>GitHub Pages path:</strong> ${escapeHtml(inventory.publishing.githubPagesPath)}</p>
          <p><strong>Local preview:</strong> <code>${escapeHtml(inventory.publishing.localPreview)}</code></p>
          <p><strong>Validation:</strong> <code>${escapeHtml(inventory.publishing.validation)}</code></p>
        </div>
        <p class="small">The rendered page is static HTML/CSS generated from <code>docs/tools.json</code>, so GitHub Pages can publish it without secrets, build services, or local-only daemon state.</p>
      </section>

${sections}
    </main>

    <footer>
      <p>Generated from <code>docs/tools.json</code>. Update the JSON and run <code>npm run docs:build</code> to refresh this page.</p>
    </footer>
  </body>
</html>
`;
}

const rawInventory = await readFile(inventoryPath, 'utf8');
const inventory = JSON.parse(rawInventory);
validateInventory(inventory);
const rendered = renderPage(inventory);

if (checkOnly) {
  const existing = await readFile(indexPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') {
      throw new Error('docs/index.html is missing; run npm run docs:build');
    }
    throw error;
  });
  if (existing !== rendered) {
    throw new Error('docs/index.html is stale; run npm run docs:build');
  }
  console.log('docs inventory is valid and docs/index.html is up to date');
} else {
  await writeFile(indexPath, rendered, 'utf8');
  console.log('rendered docs/index.html from docs/tools.json');
}
