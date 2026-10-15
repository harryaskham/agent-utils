# App automation extension architecture

`app-automation` is the first slice of a Pi-native surface for driving web apps that do not have usable APIs for agents. The goal is to give agents blessed, deterministic app actions before they fall back to raw Playwright or Tendril commands.

Parent work: `bd-515e29` (successor/duplicate lineage includes `bd-ee8e57`). The delivered scaffold now includes the core config-loader, deterministic runner, Playwright bridge, blessed Slack/canvas/Outlook/Teams actions, periodic refreshers, snapshot inspection tools, work briefings, ms-dev CDP refresh, and confirmed cleanup workflows. Future work should be filed as targeted hardening beads rather than extending the initial epic.

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
- `app_automation_doctor` — diagnose catalog errors, state-root existence, Playwright CLI configuration, Tendril remote/WSL bridge configuration, latest ms-dev CDP refresh status plus non-secret bridge config hints, optional Tendril target-discovery probe, and standard action executability.
- `app_automation_overview` — summarize configured work apps, active refreshers, app-level snapshot freshness, standard refresh-action freshness, latest snapshot digests, and optional compact snapshot links for quick orientation.
- `app_automation_work_briefing` — build a compact stale-aware shared briefing index from Slack, Outlook mail/calendar, Teams, and Calendar snapshots for natural-language questions.
- `app_automation_personal_status` — check personal automation prerequisites for a separate personal loop: verifies the existing `gws` Google Workspace CLI auth state locally and optionally on `ms-dev`, and scans `~/org/todo.org` for timely open items without adding a flake input or storing Google tokens.
- `app_automation_msdev_cdp_refresh` — refresh work-app snapshots through `ms-dev` Windows Chrome CDP using the PowerShell WSL escape route when local Playwright/Tendril cannot reach Windows browser state. Configure `APP_AUTOMATION_MSDEV_SSH_TARGET=<user>@ms-dev`; the default PowerShell path is `/mnt/c/Program Files/PowerShell/7/pwsh.exe`, the default CDP port is `9224`, and SSH/SCP connection attempts use bounded non-interactive connect options by default. Tune per-call connection waiting with `sshConnectTimeoutSeconds` or set `APP_AUTOMATION_MSDEV_SSH_CONNECT_TIMEOUT_SECONDS`. On flapping Tailscale/SSH links, `preflightAttempts` or `APP_AUTOMATION_MSDEV_PREFLIGHT_ATTEMPTS` can retry the initial SSH preflight before aborting the whole work-app pull; attempts are capped at five, and `0` skips preflight to try scp/PowerShell directly when the preflight itself is hanging. If scp is the unreliable stage, `scriptTransfer: "inline"` or `APP_AUTOMATION_MSDEV_SCRIPT_TRANSFER=inline` streams the generated PowerShell as bounded base64 chunks over SSH, decodes it on ms-dev, and runs it as a temporary `-File` script instead of copying it with scp. When CDP is not already listening, pass `ensureAppHost: true` (or set `APP_AUTOMATION_MSDEV_ENSURE_APPHOST=1`) to start or reuse a dedicated non-disruptive Edge/Chrome apphost with the requested remote-debugging port, using a cloned browser profile cache under the Windows user profile by default. Recurring refresh loops open one CDP tab per target; by default the generated PowerShell records only the target IDs it created and closes older FIFO runs after extraction (`tabGc`, `tabGcKeepTicks`, or `APP_AUTOMATION_MSDEV_TAB_GC*`; default keep is 2 ticks), which keeps the dedicated apphost bounded without touching unrelated user tabs. Failure manifests and refresh headers classify common bridge errors such as connection timeouts and summarize snapshot/skipped-write outcomes while still omitting raw stdout/stderr. When Slack Web is unauthenticated but Slack Desktop is visible, the bridge falls back to the desktop window badge count and writes only a generic unread-count row, not message contents.
- `app_automation_plan` — return the deterministic plan for an app/action without executing browser automation.
- `app_automation_status` — inspect or create the state root used for snapshots and app state.
- `app_automation_run` — dry-run a plan or execute only deterministic allowlisted steps (`cli.exec`, `tendril.run`, `snapshot.write`).
- `app_automation_open_bundle_run_once` — open Slack, Calendar, Outlook mail/calendar, and Teams browser surfaces once to warm authenticated sessions.
- `app_automation_refresh_start` / `app_automation_refresh_bundle_start` / `app_automation_refresh_bundle_run_once` / `app_automation_refresh_staleness` / `app_automation_refresh_stale_run_once` / `app_automation_refresh_status` / `app_automation_refresh_stop` — manage non-overlapping Pi-session-local periodic app action refreshes, including standard Slack/Calendar/Outlook/Teams bundle start, one-shot, per-action staleness, and stale-only refresh paths.
- `app_automation_snapshots_list` / `app_automation_snapshots_digest` / `app_automation_snapshot_links` / `app_automation_snapshots_staleness` / `app_automation_snapshots_cleanup_plan` / `app_automation_snapshots_cleanup_apply` / `app_automation_snapshot_read` — list, summarize, queryable timestamped/freshness-aware link-list with explicit kind filtering and aliases, optional sorting, matched/truncated counts, freshness/app/kind/host/source/from counts, source context, and clear empty-filter output, freshness-check, cleanup planning, explicit confirmed cleanup apply, and read persisted JSON/Markdown/text/HTML snapshot artifacts under the state root without ad-hoc filesystem access.
- `/tendril-app [doctor|overview [links] [fresh|stale|unknown] [kind:<kind>] [source:<text>] [from:<text>] [time:<text>] [host:<domain>] [query:<text>|query words] [link-limit:<n>] [link-sort:<order>] [stale-after:<minutes>] [app...]|briefing [stale-after:<minutes>] [app...]|links [[app|all] [fresh|stale|unknown|freshness:<state>] [kind:<kind>] [source:<text>] [from:<text>] [time:<text>] [host:<domain>] [sort:<order>] [limit:<n>] [stale-after:<minutes>] [query]]|cleanup [app] [keep:<n>]|cleanup-apply [app] [keep:<n>] confirm|staleness|refresh-staleness|bundle|open-bundle|stale-refresh|app action]` — operator/agent-facing command for quick diagnostics, work-app overview, stale-aware briefing indexes, snapshot links, snapshot cleanup planning/apply, snapshot freshness, refresh-action freshness, default bundle discovery, and app/action planning; omitting the app selector scans all snapshot apps. Shortcut commands `/tendril-app-overview`, `/tendril-app-briefing`, `/tendril-app-links`, `/tendril-app-cleanup`, `/tendril-app-cleanup-apply`, `/tendril-app-bundle`, `/tendril-app-open-bundle`, `/tendril-app-stale-refresh`, `/tendril-app-refresh-staleness`, and `/tendril-app-staleness` forward to the matching subcommands for common checks.

## Recommended daily workflow

For Slack, Outlook, Teams, calendars, and canvas/editor work, prefer this sequence before raw browser commands:

1. **Diagnose setup** — run `app_automation_doctor` or `/tendril-app doctor` to confirm the catalog, state root, Playwright CLI, Tendril bridge routing, latest ms-dev refresh status/config hints, and standard action executability. Add `probeTendrilBridge: true` (or `/tendril-app doctor probe`) when you need a safe target-count check through the configured Tendril bridge.
2. **Check staleness first** — run `app_automation_refresh_staleness`, `app_automation_snapshots_staleness`, or `/tendril-app refresh-staleness` before opening browsers. The standard refresh staleness report is per action (`slack.notifications.snapshot`, `outlook.calendar.snapshot`, and so on), so a fresh Outlook mail snapshot does not hide a missing Outlook calendar snapshot.
3. **Refresh via ms-dev when local browser state is unavailable** — on ms-dev setups, run `app_automation_msdev_cdp_refresh` to pull bounded/redacted Slack, Outlook, Teams, and Calendar observations from Windows Chrome via PowerShell/CDP. If `ms-dev` is unreachable, pass a short `sshConnectTimeoutSeconds` value for a fast failure while preserving the latest manifest and stale snapshot context; if the link is flapping, pass a small `preflightAttempts` value such as `2` or `3`; if the preflight command itself hangs after authentication, pass `preflightAttempts: 0`; if scp is the failing stage, pass `scriptTransfer: "inline"`; if the host is reachable but CDP is unavailable, pass `ensureAppHost: true` so the tool starts a dedicated Edge/Chrome apphost on the requested port before extraction. Recurring ms-dev refreshes should leave `tabGc` enabled (default) so the generated PowerShell records only CDP targets it created and closes older FIFO runs after extraction while preserving the newest ticks and never touching unrelated user tabs.
4. **Check personal-loop prerequisites separately** — run `app_automation_personal_status` before adding personal Google Calendar/Gmail or `~/org/todo.org` items to a daily brief. It verifies the existing `gws auth status` locally and, when requested, on ms-dev; output redacts the account local-part and reports only coarse scope/domain/readiness details plus timely org-mode TODO headings.
5. **Generate the compact work briefing** — run `app_automation_work_briefing` or `/tendril-app briefing` after refresh. For day-start summaries use a wider freshness window such as `staleAfterMinutes: 1440` so yesterday evening's preserved snapshots can still answer morning questions while the report clearly labels truly stale/auth-required actions. The briefing index is written to `[state-root]/indexes/work-briefing.json` and summarizes action status, freshness, preserved-stale refresh attempts, filtered-empty refreshes, auth-required snapshots, and bounded samples.
6. **Add overview and links when drafting a human briefing** — run `app_automation_overview` or `/tendril-app overview` to see apps, active refreshers, app-level freshness, standard refresh-action freshness, and recent snapshot digests. Add `includeLinks: true` or `/tendril-app overview links` when you also want a small set of actionable snapshot URLs; use `/tendril-app overview links fresh kind:events host:meet.google.com source:calendar standup link-sort:newest link-limit:5 stale-after:1440` for larger daily event-link samples. For a link-only pass, use `app_automation_snapshot_links` or `/tendril-app links` with the same query/source/from/time/host/kind/freshness filters and sort labels.
7. **Preview browser churn before local warming** — run `app_automation_open_bundle_run_once` with `dryRun: true` before opening Slack, Calendar, Outlook mail/calendar, and Teams surfaces. Only run it without `dryRun` when auth/session state is likely stale and browser warming is acceptable; inspect `auth-required.json` diagnostics if login is needed.
8. **Refresh only what is stale when not using ms-dev CDP** — run `app_automation_refresh_stale_run_once` with `dryRun: true`, then without `dryRun` when the stale/missing decisions look right. Use `app_automation_refresh_bundle_run_once` for an explicit all-app refresh, or `app_automation_refresh_bundle_start` for periodic refreshers.
9. **Inspect artifacts through tools** — use `app_automation_snapshots_staleness`, `app_automation_snapshots_digest`, `app_automation_snapshots_list`, `app_automation_snapshot_links`, and `app_automation_snapshot_read` instead of ad-hoc filesystem reads.
10. **Plan cleanup conservatively** — use `app_automation_snapshots_cleanup_plan` or `/tendril-app cleanup [app] [keep:<n>]` first. Only delete after reviewing candidates with `app_automation_snapshots_cleanup_apply` and `confirmed: true`, or `/tendril-app cleanup-apply [app] [keep:<n>] confirm`. The cleanup planner/apply path protects `latest-run.json` and `auth-required.json` by default and revalidates candidate paths under the app-automation state root before unlinking.

### Daily briefing Markdown recipe

When an agent needs to produce an updated operator-facing daily briefing document from the current snapshots, use the tools as the source of truth and write a short Markdown artefact outside the app-automation state root only after reviewing the rendered tool output:

1. Capture the setup line from `app_automation_doctor` when setup recently changed, or from `app_automation_overview` otherwise. Include state-root freshness, active refreshers, and the latest ms-dev refresh status, not raw command stdout/stderr.
2. Refresh with `app_automation_msdev_cdp_refresh` only if the action staleness report says the work-app snapshots are stale/missing or the operator explicitly asks for a refresh-now pass. Prefer `ensureAppHost: true` on dedicated ms-dev apphost setups and leave FIFO tab cleanup enabled. If the refresh fails, keep the stale snapshot context and include the classified failure kind from the manifest instead of treating the briefing as empty.
3. Generate `app_automation_work_briefing` with `staleAfterMinutes: 1440` for a daily morning brief, or a shorter threshold such as `15` for an in-session “what just changed?” brief. Copy the action rows and only the useful bounded samples into the Markdown.
4. Add `app_automation_overview` with `includeLinks: true` or a focused `app_automation_snapshot_links` query for meeting/join/action links. Record matched/truncated/scanned counts when a link sample is filtered so readers know whether the brief shows all matches or a bounded subset.
5. If personal work is in scope, add `app_automation_personal_status` as a separate section. Keep the same redaction policy as the tool output: no raw email local-parts, no OAuth tokens, no cookie/session material, and no raw `gws` command output.
6. Use this Markdown skeleton:

```markdown
# Daily briefing — YYYY-MM-DD

## Snapshot health

- State root: `[state-root]`
- Work-app freshness: <fresh/stale/auth-required summary from work briefing>
- Latest ms-dev refresh: <ok/failed/skipped-write/tabGc summary>
- Personal prerequisites: <optional gws/todo status>

## Calendar and meetings

- <today's Outlook/Calendar/Teams rows; include join links only from sanitized snapshot-link output>

## Mail, chat, and notifications

- <bounded Slack/Outlook/Teams samples with source labels>

## Action links

- <focused links from overview/snapshot_links; include matched/truncated/scanned counts>

## Caveats

- <auth-required, stale-but-preserved, filtered-empty, or bridge failure notes>
```

The generated daily brief should be a human digest of tool-rendered snapshots, not a dump of raw app data. Keep samples bounded, preserve the tool's source/from/time labels, and explicitly call out when the current answer depends on preserved stale snapshots.

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

These examples use the same live extraction shape as Slack: `browser.open`, `dom.extract` with conservative calendar/Microsoft extractor snippets, then `generic.notifications.snapshot` for canonical JSON/Markdown artifacts. Outlook Web mail snapshots explicitly look for unread/flag/important mail plus sender/subject/inbox/message cues while suppressing aggregate mail-list chrome rows; Outlook Web calendar and Teams calendar snapshots look for meeting/event/join/organizer cues; Teams notification snapshots look for unread/chat/message/author/activity cues. The Microsoft extractor tags rows with bounded source labels such as `Outlook Mail`, `Outlook Calendar`, `Teams`, or `Teams Calendar`, and attempts to infer a bounded `from` field from visible sender/organizer/author metadata. Teams notification handling preserves the safe badge-count row while suppressing context-menu/accessibility chrome such as bare `Chat` navigation and `has context menu` scaffolding in snapshots and briefings. Generic snapshots preserve safe meeting/message links from extracted `url`, `href`, `urls`, `hrefs`, or `links` fields while stripping query strings, fragments, usernames, and passwords before writing artifacts; the ms-dev extractor also scans bounded nearest row/list/card containers for links when the selected label element has none; when row-level source metadata is absent, the extracted page title or sanitized page hostname becomes bounded fallback source context. They still accept supplied extraction input as a fallback, and selector maintenance can improve behind the same action ids later without changing the artifact contract.

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

Agents should run `app_automation_doctor` (or `/tendril-app doctor`) when setup is unclear, use `app_automation_msdev_cdp_refresh` on ms-dev/Windows-browser setups when snapshots are stale or missing, then prefer `app_automation_work_briefing` (or `/tendril-app briefing`) for natural-language work-app questions, then `app_automation_overview` (or `/tendril-app overview`) for quick orientation including freshness, `/tendril-app staleness` or `app_automation_snapshots_staleness` for a compact freshness check, and `app_automation_snapshots_list`, `app_automation_snapshots_digest`, `app_automation_snapshot_links`, `app_automation_snapshots_cleanup_plan`, `app_automation_snapshots_cleanup_apply`, and `app_automation_snapshot_read` for deeper inspection. Digest summaries include `links=` and `linkItems=` counts for JSON snapshots that contain actionable Slack, Calendar, Outlook, or Teams links, while `app_automation_snapshot_links` returns compact app/artifact/label/url/urlHost rows with source context, snapshot/modified timestamps, per-link freshness/age, aggregate freshness/app/kind/host/source/from counts, and can scan all apps by omitting `app` or passing `all`; `/tendril-app links` follows the same default, so omitted app selectors scan all snapshot apps. Filter rows with `query`, `source`, `from`, `time`, `host`, `freshness`, and `kind`; host accepts exact substrings plus service aliases such as `meet`, `gcal`, `teams`, `outlook`, `owa`, `m365`, `slack`, `zoom`, and `github`; kind accepts exact values such as `events.snapshot` plus aliases `events`, `notifications`, `calendar`, `mail`, `chat`, `mentions`, and `meetings`. Sort with `sort` values `newest`, `oldest`, `freshest`, `stalest`, `app`, `kind`, `host`, `source`, `from`, or `time`; bound output with `limit:<n>` (or a legacy trailing number), tune freshness with `stale-after:<minutes>`, and when reports are link-limited, rendered output shows how many links matched before truncation (`/tendril-app links kind:events host:meet.google.com source:calendar from:harry fresh sort:newest stale-after:1440 limit:5 standup`; slash-command filter/sort/limit/freshness-threshold/context/host tokens can appear in any order after the optional app). Generic snapshots preserve compact `source`, `from`, and `time` metadata when extractors provide channel/team/folder/calendar/source, extracted page titles or sanitized page hostnames, from/sender/organizer/author, or time/start/date fields; link rows render each sanitized `urlHost`, and link queries plus explicit context filters match that context; Slack notification snapshots emit explicit source labels for channel/DM rows while boolean Slack flags such as `channel: true` are ignored as source-context noise. Calendar and Microsoft DOM extractors include visible `datetime`/`time`/`data-start` metadata when available so link rows can show event or message timing. Work briefing calendar samples prioritize current-day rows and, when current-day rows are present, do not backfill the sample with older events. Empty filtered results name the active filters and scanned artifact count. Cleanup planning stays dry-run; cleanup apply refuses to delete unless `confirmed=true` or `/tendril-app cleanup-apply ... confirm` is supplied, deletes only planner candidates, and preserves protected latest/auth diagnostics. Each executed action writes a safe `latest-run.json` manifest in its snapshot directory with statuses/counts/paths but without command stdout/stderr. The digest tool extracts compact status/count/action/result/auth-required summaries from JSON artifacts and first-line summaries from text artifacts. The read tool only returns readable artifact types (`.json`, `.md`, `.txt`, `.html`) and enforces that paths stay inside the configured state root.

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
