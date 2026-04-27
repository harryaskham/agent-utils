# agent-utils GitHub Pages

This directory is the GitHub Pages source for `agent-utils`.

## Publishing path

Configure GitHub Pages for the repository with:

- Source: **Deploy from a branch**
- Branch: `main`
- Folder: `/docs`

The published entry point is `docs/index.html`. It is static HTML/CSS and does not require secrets, a daemon checkout, or local-only Cacophony state.

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

Serve the static files after building:

```bash
npm run docs:build
python3 -m http.server --directory docs 8000
```

Then open <http://localhost:8000/>.
