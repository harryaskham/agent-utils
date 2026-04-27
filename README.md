# agent-utils
Tools, skills, agents, MCP servers, etc

## Pi package

This repo is also a Pi package.

After tagging a release, it can be installed with:

```bash
pi install git:github.com/harryaskham/agent-utils@v1
```

It currently provides:
- `/web-search` prompt template
- `search_web` native Pi tool for live web lookups via GitHub Copilot Responses API

## GitHub Pages tool inventory

This repository includes a minimal GitHub Pages site in [`docs/`](docs/) with a concise inventory of the Cacophony, Pi, UI automation, and repo-local tools available to agents/operators.

Publishing path:
- GitHub Pages source: **Deploy from a branch**
- Branch: `main`
- Folder: `/docs`

Update and validate the rendered page with:

```bash
npm run docs:build
npm run docs:check
```

Preview locally with:

```bash
npm run docs:build
python3 -m http.server --directory docs 8000
```

Then open <http://localhost:8000/>.
