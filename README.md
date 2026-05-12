# agent-utils
Tools, skills, agents, MCP servers, etc

## Cacophony workflow notes

Agent/operator bead-filing conventions live in [`docs/bead-workflow.md`](docs/bead-workflow.md), including the distinction between parent epics and blocking `dependencies`.

Extension tool schema guidance lives in [`docs/extension-tool-schemas.md`](docs/extension-tool-schemas.md). Prefer the local `ToolSchema` helper for simple extension tools unless the package has a guaranteed runtime TypeBox dependency.

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
- `firecracker_vm_*` native Pi tools for preparing, spawning, inspecting, and stopping Firecracker VM workloads for Tendril-visible services
- OpenAI Realtime provider and voice commands (`/rt`, `/rt summary=true`, `/rt-listen`, `/rt-doctor`, `/rt-status full`, `/rt-off`) via [`extensions/realtime-agent.js`](extensions/realtime-agent.js). See the [Realtime Agent guide](docs/realtime-agent.md) for recommended workflows, Pulse/phone routing, summary context mode, VAD tuning, replay, and troubleshooting.
- `/update`, `/reload-tools`, and the `pi_self_update` / `pi_reload_tools` native Pi tools via [`extensions/pi-self-update.js`](extensions/pi-self-update.js). `/update` runs `pi update`, reloads the Pi runtime, then refreshes active tools; use `/update --no-reload` to skip the reload. `/reload-tools` reloads extensions/resources and then activates all registered tools so newly landed dynamic tools become model-visible. The tools queue the matching slash commands as follow-ups for agent-driven updates and refreshes.
- `app_automation_*` native Pi tools plus `/tendril-app` for blessed Slack, canvas, Outlook, and Teams app automation diagnostics/overviews/freshness/plans
- `skill-server` / `skill-search`, a Rust CLI + MCP stdio meta-tool for dynamic skill and host MCP server discovery

## App automation Pi extension

The app automation extension is loaded from [`extensions/app-automation.js`](extensions/app-automation.js). It gives agents a Pi-native catalog of blessed high-level actions for API-less web apps before they fall back to raw Playwright or Tendril commands.

Available tools:

- `app_automation_list` — list configured apps and high-level actions.
- `app_automation_doctor` — diagnose catalog/state-root/Playwright CLI setup, Tendril remote/WSL bridge configuration, optional bridge target-discovery probe, and standard action executability.
- `app_automation_overview` — summarize configured work apps, active refreshers, snapshot freshness, standard refresh-action freshness, latest snapshot digests, and optional compact snapshot links.
- `app_automation_plan` — return the deterministic action plan for an app/action without executing browser automation.
- `app_automation_run` — dry-run or execute deterministic allowlisted runner steps such as `cli.exec`, `tendril.run`, and `snapshot.write`.
- `app_automation_open_bundle_run_once` — open Slack, Calendar, Outlook mail/calendar, and Teams browser surfaces once to warm authenticated sessions; pass `dryRun` to inspect the planned browser actions first.
- `app_automation_refresh_start` / `app_automation_refresh_bundle_start` / `app_automation_refresh_bundle_run_once` / `app_automation_refresh_staleness` / `app_automation_refresh_stale_run_once` / `app_automation_refresh_status` / `app_automation_refresh_stop` — run non-overlapping Pi-session-local periodic app actions for snapshot refreshes, including standard Slack/Calendar/Outlook/Teams bundle start, one-shot, per-action staleness, stale-only refresh paths, and refresh status with consecutive-error and auth-required diagnostic tracking; one-shot bundles also support `dryRun`.
- `app_automation_snapshots_list` / `app_automation_snapshots_digest` / `app_automation_snapshot_links` / `app_automation_snapshots_staleness` / `app_automation_snapshots_cleanup_plan` / `app_automation_snapshot_read` — inspect, summarize, queryable timestamped/freshness-aware link-list with explicit kind filtering and aliases, optional sorting, matched/truncated counts, freshness/app/kind counts, source context, and clear empty-filter output, freshness-check, and cleanup-plan persisted Slack, Outlook, Teams, calendar, and canvas snapshot artifacts without ad-hoc filesystem reads.
- `app_automation_status` — inspect or create the canonical app automation state root.
- `/tendril-app [doctor|overview [links] [fresh|stale|unknown] [kind:<kind>] [query:<text>|query words] [link-limit:<n>] [link-sort:<order>] [stale-after:<minutes>] [app...]|links [[app|all] [fresh|stale|unknown|freshness:<state>] [kind:<kind>] [source:<text>] [from:<text>] [time:<text>] [sort:<order>] [limit:<n>] [stale-after:<minutes>] [query]]|staleness|refresh-staleness|bundle|open-bundle|stale-refresh|app action]` — quick command for diagnostics, app/action discovery, snapshot links, freshness, and bundle guidance from the Pi UI; omitting the app selector scans all snapshot apps.

Recommended flow: run `app_automation_doctor`, then `app_automation_overview` (optionally with `includeLinks` or `/tendril-app overview links fresh kind:events standup link-sort:newest`; overview and snapshot-link sections render matched/truncated/scanned counts plus query/kind/freshness/sort across app samples); dry-run `app_automation_open_bundle_run_once` before warming browser sessions; use `app_automation_refresh_staleness` to preview per-action bundle freshness, `app_automation_refresh_stale_run_once` for normal per-action stale/partial/missing refreshes, and `app_automation_refresh_bundle_run_once` when a full refresh is explicitly needed; inspect results with the snapshot digest/read/staleness tools. Snapshot digests include link counts when Slack, Calendar, Outlook, or Teams artifacts contain actionable links. Generic snapshots preserve compact source/from/time metadata when extractors provide it, and link listings render, query, and explicitly filter that context while ignoring boolean Slack flags as source noise.

Initial blessed configs cover Slack web notifications, Markdown-to-canvas sync, generic Calendar web events, Outlook web open/snapshot actions, and Teams web open/snapshot actions. Slack/Calendar/Outlook/Teams snapshots preserve safe channel, DM, meeting, and message links while stripping query strings and fragments before writing artifacts; link filters accept natural kind aliases such as events, notifications, mail, chat, mentions, and meetings; Slack notification rows also provide explicit source labels for link context, and Calendar/Microsoft DOM extractors preserve visible time metadata when available. Auth-required diagnostics apply the same URL redaction to persisted args and stdout/stderr. JSON app configs can also be loaded from `APP_AUTOMATION_CONFIG_DIR` (default `~/.config/agent-utils/app-automation/apps.d`). Slack notification snapshots can already normalize supplied extraction text/JSON into canonical JSON and Markdown artifacts, canvas sync can export Markdown into canonical Markdown/HTML/paste artifacts with sync metadata and prepare live browser replacement steps, and Outlook/Teams include conservative notification and calendar snapshot examples. Executed actions also write safe `latest-run.json` manifests for durable refresh status without command stdout/stderr. The runner includes a deterministic Playwright bridge for `browser.open` and `dom.extract` steps, while app-specific live selectors continue to land incrementally. Explicitly allowlisted low-level runner steps can also be executed through `app_automation_run`. See [docs/app-automation.md](docs/app-automation.md) for the architecture, snapshot locations, auth policy, periodic refresh shape, and follow-up bead stack.

## skill-server (`skill-search`)

`skill-server` is a Rust utility that lets agents discover configured skill files and host MCP stdio servers without reloading. It supports a `skill-search` CLI shorthand and an MCP stdio server built on the same `mcp-cli` plumbing used by Tendril.

```bash
cargo build -p skill-server
skill-search --help
skill-search list --json
skill-search web query latest Rust MCP crate
skill-search mcp stdio
```

Configuration defaults to [`.config/ss/config.yaml`](.config/ss/config.yaml) and can be overridden with `SS_CONFIG` or `--config`. See [docs/skill-server/README.md](docs/skill-server/README.md) for the config schema, MCP tools, and build/test commands.

## Firecracker VM Pi extension

The Firecracker VM extension is loaded from [`extensions/firecracker-vm.js`](extensions/firecracker-vm.js). It gives Pi agents a first-class control plane for microVM workloads that should be visible and controllable by Tendril agents. Firecracker itself is headless, so the extension tracks both serial-console output and any declared host-visible screen/control services such as VNC, noVNC, browser debug endpoints, or web apps.

Available tools:

- `firecracker_vm_start` — create a VM workspace, write `firecracker-config.json` and `tendril-firecracker-manifest.json`, and optionally spawn `firecracker --api-sock ... --config-file ...`. Use `dryRun: true` on hosts without Firecracker/KVM to generate the config and manifest only.
- `firecracker_vm_status` / `firecracker_vm_list` — list tracked VMs, lifecycle state, process liveness, manifest paths, service endpoints, logs, and sockets.
- `firecracker_vm_screen` — return the serial-console tail plus declared graphical service endpoints that Tendril/browser automation can open or capture.
- `firecracker_vm_stop` — stop a tracked VM with SIGTERM followed by bounded SIGKILL and persist lifecycle metadata.
- `/firecracker-vms` — operator command that summarizes tracked VMs in the TUI.

Key capabilities:

- Configurable VM boot inputs: kernel, optional initrd, rootfs, CPU/memory sizing, kernel args, rootfs read-only mode, logging, metrics, and optional TAP networking.
- Tendril manifest generation with lifecycle metadata, API socket path, serial-console log path, and declared screen/control service URLs.
- Browser/workload configuration via `services`, e.g. a noVNC endpoint with `{ "name": "novnc", "protocol": "http", "hostPort": 6080, "path": "/vnc.html", "screen": true }`.
- Visible output access through `firecracker_vm_screen`: serial console for all VMs, plus VNC/noVNC/browser URLs for graphical guests.
- Lifecycle tracking inside the Pi session with autostop on session shutdown by default.

Example dry-run config/manifest generation:

```json
{
  "id": "browser-vm",
  "dryRun": true,
  "kernelPath": "./vm/vmlinux",
  "rootfsPath": "./vm/rootfs.ext4",
  "cpuCount": 2,
  "memMiB": 2048,
  "tapName": "tap0",
  "services": [
    { "name": "novnc", "protocol": "http", "hostPort": 6080, "guestPort": 6080, "path": "/vnc.html", "screen": true },
    { "name": "browser-debug", "protocol": "http", "hostPort": 9222, "guestPort": 9222 }
  ]
}
```

## Tendril share Pi extension

The Tendril share extension is loaded from [`extensions/tendril-share.js`](extensions/tendril-share.js). It gives the user a slash-command path for showing the model a current screen/window, complementing the agent-facing Tendril tools that let the model inspect or control UI.

Available commands:

- `tendril_bridge_doctor` — native Pi tool that reports the configured Tendril command, `--remote` target, `--wsl-tunnel` flag, and optionally probes `tendril list --json` through that bridge.
- `/tendril list` — runs `tendril list --json` and shows readable display/window targets.
- `/tendril window <id-or-name> [prompt]` — captures a Tendril window to PNG and sends a user message containing the screenshot image plus optional prompt text.
- `/tendril display <id-or-name> [prompt]` — captures a Tendril display to PNG and sends it to the model.
- `/tendril screen <id-or-name> [prompt]` — alias for `/tendril display`.
- `/tendril describe window <id-or-name> [prompt]` / `/tendril describe display <id-or-name> [prompt]` — captures the target, describes it with a configurable image-capable model, and sends the textual description to the active model.
- `/tendril-describe window <id-or-name> [prompt]` / `/tendril-describe display <id-or-name> [prompt]` — shortcut aliases for the describe path.
- `/tendril stream window <id-or-name> [seconds] [prompt]` / `/tendril stream display <id-or-name> [seconds] [prompt]` — starts low-resolution periodic screenshot sharing. Defaults to 30 seconds, clamps to at least 10 seconds, and captures at 640×360.
- `/tendril stream status` / `/tendril stream stop` — inspect or stop the active screenshot stream.

Set `AGENT_UTILS_TENDRIL_REMOTE=<host>` to wrap Tendril invocations with `tendril --remote <host>`, and set `AGENT_UTILS_TENDRIL_WSL_TUNNEL=1` to add Tendril's `--wsl-tunnel` hop for WSL-to-Windows-host control (for example ms-dev with a visible Windows `tendril.exe`). Capture targets can be exact ids or unique case-insensitive substrings from Tendril target titles, names, or app names (for example `/tendril window Safari`). Captures are written under the active Pi session directory when available, or a process-scoped temp folder otherwise, and the extension records a visible history message with the saved file path. If the agent is already streaming, screenshot messages are queued as follow-ups so the user can share visual context without interrupting the current turn. Description commands default to `litellm-anthropic/claude-opus-4-7`; override with `TENDRIL_SHARE_DESCRIBE_MODEL=provider/model`.

## Kitty image preview Pi extension

The kitty image preview extension is loaded from [`extensions/kitty-image-preview.js`](extensions/kitty-image-preview.js) and uses shared protocol helpers in [`extensions/kitty-graphics.js`](extensions/kitty-graphics.js). It is a first-class Pi package extension like `search_web`: install this repo as a Pi package, then the tools become available to the agent without shelling out to `kitty icat`.

Available tools:

- `kitty_image_preview_add` — add a PNG/APNG image and optionally show it immediately.
- `kitty_image_preview_capture` — capture a Tendril screenshot into the current Pi session screenshot folder and show it immediately.
- `kitty_image_preview_add_folder` — add a sorted image series from a directory, optionally recursively.
- `kitty_image_preview_show` — navigate `current`, `next`, `previous`, `first`, `last`, `index`, `hide`, or `clear`.
- `kitty_image_preview_animate` — start or stop lightweight frame animation by cycling a loaded image series.
- `kitty_image_preview_cycle` — start (`action: "start", intervalSeconds: 5`) or stop (`action: "stop"`) timed cycling through the loaded gallery. Slash-command equivalents: `/image-next`, `/image-prev`, `/image-hide`, `/image-show`, `/image-clear`, `/image-start-cycle [seconds]`, `/image-stop-cycle` (legacy `/kitty-show-next`, `/kitty-show-prev`, `/kitty-start-cycle`, and `/kitty-stop-cycle` aliases remain supported).
- `kitty_image_preview_stream_start` / `kitty_image_preview_stream_stop` / `kitty_image_preview_stream_status` — show an ephemeral Tendril screenshot stream using a two-file temp buffer so frames do not accumulate on disk or in model context. Set `intervalMs: 0` for max non-overlapping Tendril capture rate.
- `kitty_image_preview_stream_sample` — persist one selected stream frame, optionally with `describe: true`.
- `kitty_image_preview_playwright_start` — watch a PNG path written by Playwright `page.screenshot()` calls so users see a live browser mirror while the agent can keep using DOM-only context.
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
- Playwright visual mirroring can automatically run `playwright-cli screenshot --filename <temp>` on an interval for the active/session browser, or can watch a screenshot path written by external Playwright code when `autoScreenshot: false`. Frames remain display-only unless sampled.
- Session-state reconstruction from prior tool results so loaded image lists survive Pi session reloads.
- Scoped kitty image cleanup: the extension tracks the kitty graphics image ids it transmits and only ever issues per-image deletes (`d=i,i=<id>`) for those owned ids when hiding, clearing, or shutting down. It never emits a global delete-all (`d=A`) sequence, so running it inside another kitty graphics consumer (e.g. caco) does not erase unrelated images or the surrounding UI.
- User-facing TUI controls: the preview widget/status line advertises `/image-prev`, `/image-next`, `/image-hide`, `/image-show`, and `/image-clear` so the operator can control multi-image galleries without waiting for an agent tool call. Legacy `/kitty-show-next`, `/kitty-show-prev`, `/kitty-start-cycle [seconds]`, and `/kitty-stop-cycle` aliases remain supported; `/image-start-cycle [seconds]` and `/image-stop-cycle` are the preferred cycle commands.

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
