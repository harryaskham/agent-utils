# App automation extension architecture

`app-automation` is the first slice of a Pi-native surface for driving web apps that do not have usable APIs for agents. The goal is to give agents blessed, deterministic app actions before they fall back to raw Playwright or Tendril commands.

Parent work: `bd-ee8e57`. The delivered scaffold now includes the core config-loader, deterministic runner, Playwright bridge, blessed Slack/canvas/Outlook/Teams actions, periodic refreshers, and snapshot inspection tools. Future work should be filed as targeted hardening beads rather than extending the initial epic.

## Why this shape

Agents need to interact with Slack, Outlook, Teams, calendars, and canvas-style editors in the same session where they already use Pi and Tendril. Raw browser automation is powerful but too easy to make ad hoc: selectors drift, auth state is unclear, notification snapshots land in arbitrary temp paths, and periodic refreshes become unmanaged loops.

The extension therefore starts with a small declarative catalog:

- **App configs** describe a known web app (`slack`, `canvas`, `outlook`, `teams`).
- **Actions** describe high-level intents such as `notifications.snapshot` or `sync-markdown`.
- **Plans** describe deterministic steps such as `browser.open`, `dom.extract`, `document.export`, and `snapshot.write`.
- **State roots** define canonical persisted artifacts under `~/.local/state/agent-utils/app-automation` by default.
- **Execution is intentionally separate** from planning in this slice, so agents can discover stable contracts before low-level drivers land.

## Exposed Pi surfaces

The package registers [`extensions/app-automation.js`](../extensions/app-automation.js), which exposes:

- `app_automation_list` — list blessed app configs and available high-level actions.
- `app_automation_doctor` — diagnose catalog errors, state-root existence, Playwright CLI configuration, Tendril remote/WSL bridge configuration, optional Tendril target-discovery probe, and standard action executability.
- `app_automation_overview` — summarize configured work apps, active refreshers, app-level snapshot freshness, standard refresh-action freshness, and latest snapshot digests for quick orientation.
- `app_automation_plan` — return the deterministic plan for an app/action without executing browser automation.
- `app_automation_status` — inspect or create the state root used for snapshots and app state.
- `app_automation_run` — dry-run a plan or execute only deterministic allowlisted steps (`cli.exec`, `tendril.run`, `snapshot.write`).
- `app_automation_open_bundle_run_once` — open Slack, Calendar, Outlook mail/calendar, and Teams browser surfaces once to warm authenticated sessions.
- `app_automation_refresh_start` / `app_automation_refresh_bundle_start` / `app_automation_refresh_bundle_run_once` / `app_automation_refresh_staleness` / `app_automation_refresh_stale_run_once` / `app_automation_refresh_status` / `app_automation_refresh_stop` — manage non-overlapping Pi-session-local periodic app action refreshes, including standard Slack/Calendar/Outlook/Teams bundle start, one-shot, per-action staleness, and stale-only refresh paths.
- `app_automation_snapshots_list` / `app_automation_snapshots_digest` / `app_automation_snapshot_links` / `app_automation_snapshots_staleness` / `app_automation_snapshots_cleanup_plan` / `app_automation_snapshot_read` — list, summarize, queryable link-list, freshness-check, cleanup-plan, and read persisted JSON/Markdown/text/HTML snapshot artifacts under the state root without ad-hoc filesystem access.
- `/tendril-app [doctor|overview|links [app] [query]|staleness|refresh-staleness|bundle|open-bundle|stale-refresh|app action]` — operator/agent-facing command for quick diagnostics, work-app overview, snapshot links, snapshot freshness, refresh-action freshness, default bundle discovery, and app/action planning.

## Recommended daily workflow

For Slack, Outlook, Teams, calendars, and canvas/editor work, prefer this sequence before raw browser commands:

1. **Diagnose setup** — run `app_automation_doctor` or `/tendril-app doctor` to confirm the catalog, state root, Playwright CLI, Tendril bridge routing, and standard action executability. Add `probeTendrilBridge: true` (or `/tendril-app doctor probe`) when you need a safe target-count check through the configured Tendril bridge.
2. **Orient on current state** — run `app_automation_overview` or `/tendril-app overview` to see apps, active refreshers, app-level freshness, standard refresh-action freshness, and recent snapshot digests.
3. **Preview browser churn** — run `app_automation_open_bundle_run_once` with `dryRun: true` before opening Slack, Calendar, Outlook mail/calendar, and Teams surfaces.
4. **Warm sessions when needed** — run `app_automation_open_bundle_run_once` without `dryRun` if auth/session state is likely stale; inspect `auth-required.json` diagnostics if login is needed.
5. **Refresh only what is stale** — run `app_automation_refresh_staleness` or `/tendril-app refresh-staleness` to preview exact action freshness, then run `app_automation_refresh_stale_run_once` with `dryRun: true`, then without `dryRun` when the stale/missing decisions look right. This stale-refresh path evaluates the expected artifacts for each standard app/action independently, so one fresh Outlook snapshot does not mask a missing Outlook calendar snapshot.
6. **Force a full refresh only when necessary** — use `app_automation_refresh_bundle_run_once` for an explicit all-app refresh, or `app_automation_refresh_bundle_start` for periodic refreshers.
7. **Inspect artifacts through tools** — use `app_automation_snapshots_staleness`, `app_automation_snapshots_digest`, `app_automation_snapshots_list`, and `app_automation_snapshot_read` instead of ad-hoc filesystem reads.
8. **Plan cleanup conservatively** — use `app_automation_snapshots_cleanup_plan`; it is dry-run only and protects `latest-run.json` / `auth-required.json` by default.

## Blessed initial configs

### Slack

`slack` targets <https://app.slack.com/client> and starts with:

- `open` — open or reuse Slack web in a browser session.
- `notifications.snapshot` — read-only normalization of Slack unread/channel/DM summaries into:
  - `snapshots/slack/notifications.json`
  - `snapshots/slack/notifications.md`
  - `snapshots/slack/extractor.js`

Slack auth should reuse a Playwright/browser profile or an already-authenticated system browser session. The extension must never persist cookies, tokens, or secrets in repo files or snapshots. Slack snapshots preserve safe channel/DM links from extracted `url`, `href`, `urls`, `hrefs`, or `links` fields while stripping query strings, fragments, usernames, and passwords before writing artifacts. Agents can pass `sourceText`, `sourceJson`, or `extraction` to `app_automation_run` for offline normalization, or use the Playwright-backed live `browser.open`/`dom.extract` plan when an authenticated session is available.

### Canvas

`canvas` is a generic Markdown-to-editor sync profile. Its first action is:

- `sync-markdown` — read Markdown, export to deterministic HTML/paste artifacts, and prepare a browser paste/import plan for a target URL and selector when supplied.

Outputs:

- `snapshots/canvas/latest.md`
- `snapshots/canvas/latest.html`
- `snapshots/canvas/paste.txt`
- `snapshots/canvas/sync.json`

The implementation performs the source/export/persist part and records whether the artifact is `exported` or `ready_for_browser_sync`. When `targetUrl` and `targetSelector` are provided, the action also plans a `browser.open` followed by an `editor.replace` step that writes a temporary browser-side replacement script for Playwright evaluation.

### Calendar, Outlook, and Teams

`calendar`, `outlook`, and `teams` provide interactive open actions plus conservative read-only notification and calendar/meeting snapshots:

- `open` — open or reuse the primary Outlook/Teams web surface.
- `calendar.open` — open or reuse the Outlook/Teams calendar surface.
- `events.snapshot` — normalize visible generic web calendar events into canonical JSON and Markdown.
- `notifications.snapshot` — normalize supplied mail/chat/activity extraction text or JSON into canonical JSON and Markdown.
- `calendar.snapshot` — normalize supplied calendar/meeting extraction text or JSON into canonical JSON and Markdown.

These examples use the same live extraction shape as Slack: `browser.open`, `dom.extract` with conservative calendar/Microsoft extractor snippets, then `generic.notifications.snapshot` for canonical JSON/Markdown artifacts. Generic snapshots preserve safe meeting/message links from extracted `url`, `href`, `urls`, `hrefs`, or `links` fields while stripping query strings, fragments, usernames, and passwords before writing artifacts. They still accept supplied extraction input as a fallback, and selector maintenance can improve behind the same action ids later without changing the artifact contract.

## Config loader

The built-in catalog can be extended or overridden with JSON files in `APP_AUTOMATION_CONFIG_DIR`, defaulting to `~/.config/agent-utils/app-automation/apps.d`. Each `.json` file may contain either one app config, an array of app configs, or an object with an `apps` array. External configs with the same app id override built-ins for that Pi session, which lets operators bless local variants without patching the package.

Minimal dynamic config example:

```json
{
  "id": "example-app",
  "label": "Example App",
  "url": "https://example.invalid/app",
  "actions": [
    {
      "id": "version",
      "mode": "read",
      "driver": "playwright",
      "plan": [
        { "kind": "cli.exec", "command": "playwright-cli", "args": ["--version"] },
        { "kind": "snapshot.write", "name": "version" }
      ]
    }
  ]
}
```

## Driver boundary

The architecture deliberately keeps a thin bridge between app actions and browser/UI backends:

1. **Catalog and validation** live in `extensions/app-automation/catalog.js` and are pure enough to unit test without Pi runtime dependencies.
2. **Pi extension registration** lives in `extensions/app-automation.js` and exposes tools/commands.
3. **Core execution** is deterministic and conservative:
   - `browser.open` builds a `playwright-cli` invocation with optional session reuse (`session`, `playwrightSession`, or `APP_AUTOMATION_PLAYWRIGHT_SESSION`).
   - `dom.extract` builds a `playwright-cli evaluate --script-file ... --output ...` invocation when a script/output path is supplied, or writes an inline script to the snapshot directory before running.
   - `cli.exec` runs only allowlisted commands: `playwright-cli`, `tendril`, and `pandoc`.
   - `tendril.run` builds a structured `tendril run --window <target> <dsl>` invocation.
   - `snapshot.write` persists run metadata under the app snapshot directory.
   - `slack.notifications.snapshot` normalizes Slack extraction text/JSON and writes canonical JSON, Markdown, and the browser-side extractor snippet.
   - `canvas.sync-markdown` reads Markdown and writes canonical Markdown, HTML, paste text, and sync metadata with a browser paste plan; `editor.replace` can turn that paste artifact into a browser-side replacement script.
   - `generic.notifications.snapshot` normalizes Outlook/Teams/calendar-style supplied extraction text/JSON with conservative include-pattern filters and safe link preservation.
   - high-level `browser.open`, `dom.extract`, and `editor.replace` steps are executable through the Playwright bridge when their required parameters are present; optional steps are skipped when no target URL or selector is supplied, and skipped optional steps do not make an otherwise successful run fail.
4. **App-specific execution** lands behind the same plan vocabulary:
   - Prefer Playwright DOM extraction for structured read-only snapshots.
   - Use Tendril capture/run when visual verification or native input is needed. For WSL-to-Windows-host control, set `AGENT_UTILS_TENDRIL_WSL_TUNNEL=1`; combine with `AGENT_UTILS_TENDRIL_REMOTE=<host>` when a controller should SSH to a WSL host such as ms-dev before Tendril performs its Windows tunnel.
   - Keep paste/import/write actions explicit and parameterized.
5. **Artifacts** always land under the app automation state root unless a future action explicitly accepts a workspace output path.

## Snapshot inspection

Snapshots are persisted under:

```text
${APP_AUTOMATION_STATE_ROOT:-~/.local/state/agent-utils/app-automation}/snapshots/<app>/...
```

Agents should run `app_automation_doctor` (or `/tendril-app doctor`) when setup is unclear, then prefer `app_automation_overview` (or `/tendril-app overview`) for quick orientation including freshness, `/tendril-app staleness` or `app_automation_snapshots_staleness` for a compact freshness check, and `app_automation_snapshots_list`, `app_automation_snapshots_digest`, `app_automation_snapshot_links`, `app_automation_snapshots_cleanup_plan`, and `app_automation_snapshot_read` for deeper inspection. Digest summaries include `links=` and `linkItems=` counts for JSON snapshots that contain actionable Slack, Calendar, Outlook, or Teams links, while `app_automation_snapshot_links` returns compact app/artifact/label/url rows and can filter them with `query`. Cleanup planning is dry-run only and does not delete files. Each executed action writes a safe `latest-run.json` manifest in its snapshot directory with statuses/counts/paths but without command stdout/stderr. The digest tool extracts compact status/count/action/result/auth-required summaries from JSON artifacts and first-line summaries from text artifacts. The read tool only returns readable artifact types (`.json`, `.md`, `.txt`, `.html`) and enforces that paths stay inside the configured state root.

## Periodic refresh model

Periodic actions stay Pi-native and controllable rather than using daemon-global cron or unmanaged shell loops:

- `app_automation_open_bundle_run_once` opens Slack, Calendar, Outlook mail/calendar, and Teams browser surfaces once without snapshot extraction or timers, useful for warming authenticated sessions. Pass `dryRun` to inspect planned browser actions first.
- `app_automation_refresh_start` starts one app/action interval and optionally runs immediately.
- `app_automation_refresh_bundle_start` starts the standard Slack notifications, Outlook mail/calendar, and Teams notification/calendar bundle. It defaults `runImmediately` to `false` so agents can arm the bundle without opening several authenticated apps at once.
- `app_automation_refresh_bundle_run_once` runs that same standard bundle once without creating timers, for explicit refresh-now workflows. Pass `dryRun` to inspect planned snapshot actions first.
- `app_automation_refresh_staleness` reports fresh/stale/partial/missing status for each standard Slack, Calendar, Outlook, and Teams refresh action without opening browser surfaces; `partial` means at least one expected artifact exists but another expected JSON/Markdown artifact is missing.
- `app_automation_refresh_stale_run_once` checks expected snapshot artifacts for each standard app/action first and runs only the refresh actions whose own outputs are stale, partial, or missing. Pass `dryRun` to inspect executable steps first.
- `app_automation_refresh_status` lists active refreshers, run counts, total errors, consecutive errors, last success time, auth-required counts/diagnostic paths when present, last error text when present, and last snapshot status.
- `app_automation_refresh_stop` stops one refresher or all refreshers.
- Runs are bounded and non-overlapping: if a previous refresh is still in flight, the next tick is skipped.
- Refreshers are session-local and are cleaned up on Pi session shutdown.

## Safety rules

- Prefer blessed app/action plans before raw browser commands.
- Do not persist web auth secrets in snapshots or git. Auth-required diagnostics are redacted and only record the failing step, status, and operator hint; command args and stdout/stderr strip URL usernames, passwords, query strings, and fragments before being written. Latest-run manifests intentionally omit command stdout/stderr.
- Treat write actions (`sync-markdown`) as explicit and parameterized.
- Keep selectors and app-specific heuristics in app configs, not scattered across agent prompts.
- Store snapshots in canonical state paths so later agents can inspect the latest known app state.

## Delivery beads

The initial `bd-ee8e57` epic was delivered through small reintegrated slices:

- `bd-bf9c5e` — design architecture and scaffold extension contract.
- `bd-afa933` — implement config loader and deterministic action runner.
- `bd-de1af2` — add Slack web notification snapshot extraction.
- `bd-cb5a40` — add Markdown-to-canvas sync execution.
- `bd-829091` — add periodic refresh controls and persisted snapshot storage.
- `bd-a7835e` — add Outlook and Teams blessed config examples.
- `bd-3fc088` — add Playwright bridge for `browser.open` and DOM extraction.
- `bd-328a43` — wire Slack notifications to live Playwright DOM extraction.
- `bd-53d66c` — wire Markdown canvas sync to live browser paste/import.
- `bd-d0b4ce` — add live Outlook and Teams extraction selectors.
- `bd-41184b` — add snapshot list/digest/read tools for persisted artifacts.
