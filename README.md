# agent-utils GitHub Pages

This directory is the GitHub Pages source for `agent-utils`. Keep it public-safe: do not add secrets, private app automation snapshot contents, auth diagnostics with unredacted URLs, cookies, tokens, or local-only daemon state.

## Publishing path

Configure GitHub Pages for the repository with:

- Source: **GitHub Actions**
- Workflow: [`.github/workflows/pages.yml`](../.github/workflows/pages.yml)
- Runner: `self-hosted`

The published entry point is `docs/index.html`. It is a static HTML/CSS/JS SPA and does not require secrets, a daemon checkout, private app snapshots, auth cookies, tokens, or local-only Cacophony state.

## Updating the tool inventory

1. Edit [`tools.json`](./tools.json).
2. Regenerate the rendered page:

   ```bash
   npm run docs:build
   ```

3. Validate that the checked-in page is in sync:

   ```bash
   npm run docs:check
   ```

## Local preview

Serve the static SPA files after building:

```bash
npm run docs:build
python3 -m http.server --directory docs 8000
```

Then open <http://localhost:8000/>.
