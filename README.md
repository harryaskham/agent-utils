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
- `kitty_image_preview_*` native Pi tools for persistent terminal image previews via the kitty graphics protocol

## Kitty image preview Pi extension

The kitty image preview extension is loaded from [`extensions/kitty-image-preview.js`](extensions/kitty-image-preview.js) and uses shared protocol helpers in [`extensions/kitty-graphics.js`](extensions/kitty-graphics.js). It is a first-class Pi package extension like `search_web`: install this repo as a Pi package, then the tools become available to the agent without shelling out to `kitty icat`.

Available tools:

- `kitty_image_preview_add` — add a PNG/APNG image and optionally show it immediately.
- `kitty_image_preview_capture` — capture a Tendril screenshot into the current Pi session screenshot folder and show it immediately.
- `kitty_image_preview_add_folder` — add a sorted image series from a directory, optionally recursively.
- `kitty_image_preview_show` — navigate `current`, `next`, `previous`, `first`, `last`, `index`, `hide`, or `clear`.
- `kitty_image_preview_animate` — start or stop lightweight frame animation by cycling a loaded image series.
- `kitty_image_preview_status` — inspect loaded images, active index, transfer mode, and passthrough detection.

Key capabilities:

- Native kitty graphics APC serialization with chunking, PNG file or in-memory transfer, and tmux DCS passthrough autodetection.
- First-party screenshot capture via `tendril capture --output`, saved under a per-session `kitty-image-preview-screenshots` folder by default.
- Persistent Pi widget mounted above or below the editor with configurable cell width/height and captioning.
- Negative z-index rendering by default so images can sit underneath text; `background: true` uses an extra-low z-index for background-style placement.
- Alpha/transparency support through PNG/APNG and kitty's compositor.
- Lightweight animation support by cycling folder/series frames at configurable intervals.
- Session-state reconstruction from prior tool results so loaded image lists survive Pi session reloads.

Example image tool use:

```json
{
  "path": "./artifacts/preview.png",
  "config": {
    "columns": 72,
    "placement": "belowEditor",
    "transferMode": "auto",
    "passthrough": "auto",
    "zIndex": -10
  }
}
```

Example screenshot capture tool use:

```json
{
  "targetKind": "display",
  "maxWidth": 1200,
  "config": {
    "columns": 80,
    "placement": "belowEditor"
  }
}
```

The native protocol path currently accepts PNG/APNG input. Convert JPEG/WebP/GIF assets to PNG first when using the widget directly.

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
