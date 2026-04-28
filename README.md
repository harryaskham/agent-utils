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
- `kitty_image_preview_stream_start` / `kitty_image_preview_stream_stop` / `kitty_image_preview_stream_status` — show an ephemeral Tendril screenshot stream using a two-file temp buffer so frames do not accumulate on disk or in model context. Set `intervalMs: 0` for max non-overlapping Tendril capture rate.
- `kitty_image_preview_stream_sample` — persist one selected stream frame, optionally with `describe: true`.
- `kitty_image_preview_status` — inspect loaded images, active index, transfer mode, and passthrough detection.

Key capabilities:

- Native kitty graphics APC serialization with chunking, PNG file or in-memory transfer, and tmux DCS passthrough autodetection.
- Unicode placeholder placement under tmux so the image is anchored to the widget text cells and scrolls with the pane instead of floating at the outer terminal cursor.
- First-party screenshot capture via `tendril capture --output`, saved under a per-session `kitty-image-preview-screenshots` folder by default.
- Persistent Pi widget mounted above or below the editor with configurable cell width/height and captioning.
- Automatic screenshot-friendly placement via `placement: "auto"` (the default): outside tmux on wide terminals it uses a right-side side panel sized to the current image, capped by 50% of terminal width and the visible height above the input box, so chat text reflows beside it; inside tmux or on narrow terminals it falls back to the inline above-editor widget.
- Negative z-index rendering by default for direct cursor placement so images can sit underneath text; `background: true` uses an extra-low z-index for background-style placement. In tmux placeholder mode, image stacking follows kitty's placeholder rendering semantics.
- Alpha/transparency support through PNG/APNG and kitty's compositor.
- Lightweight animation support by cycling folder/series frames at configurable intervals.
- Optional `describe: true` on still-image tools to send just that image to a VLM for an objective visual description. Screenshot descriptions use a separate full-resolution Tendril capture even when the terminal preview is downscaled. Defaults to `litellm-anthropic/claude-opus-4-7`, override with `describeModel` or `KITTY_IMAGE_PREVIEW_DESCRIBE_MODEL`.
- Optional stream descriptions with `describe: true` or `describeIntervalSecs`, recorded as text metadata only. Stream previews can stay low-res while description frames are captured separately at full resolution in the background.
- Session-state reconstruction from prior tool results so loaded image lists survive Pi session reloads.

Example image tool use:

```json
{
  "path": "./artifacts/preview.png",
  "config": {
    "columns": 48,
    "placement": "auto",
    "transferMode": "auto",
    "passthrough": "auto",
    "placementMode": "auto",
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
    "columns": 48,
    "placement": "auto"
  }
}
```

Example fixed right-side screenshot preview:

```json
{
  "targetKind": "display",
  "maxWidth": 1200,
  "config": {
    "columns": 48,
    "placement": "rightOverlay",
    "transferMode": "auto"
  }
}
```

The native protocol path currently accepts PNG/APNG input. Convert JPEG/WebP/GIF assets to PNG first when using the widget directly. `placement: "auto"` chooses the fixed right-side panel only when it should be ergonomic; use `"rightOverlay"`, `"aboveEditor"`, or `"belowEditor"` to force a location. `placementMode: "auto"` uses anchored Unicode placeholders by default so previews update in-place without moving the terminal cursor or flooding scrollback; use `"cursor"` only for debugging terminal-specific behavior. The right-side panel dynamically fits the image to the available frame, clamps total reserved width (including left padding) to 50% of the terminal, never exceeds the visible height above the editor/input area, and bottom-aligns the image immediately above that input area. If tmux passthrough or an older Pi runtime prevents side-panel rendering, it falls back to the inline above-editor widget. Preview images stay out of model context unless `describe: true` is explicitly requested for a still image.

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
