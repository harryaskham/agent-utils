# App automation extension architecture

`app-automation` is the first slice of a Pi-native surface for driving web apps that do not have usable APIs for agents. The goal is to give agents blessed, deterministic app actions before they fall back to raw Playwright or Tendril commands.

Parent work: `bd-ee8e57`. The architecture scaffold landed in `bd-bf9c5e`; the core config-loader and deterministic runner surface is tracked by `bd-afa933`; app-specific browser actions follow in later beads.

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
- `app_automation_plan` — return the deterministic plan for an app/action without executing browser automation.
- `app_automation_status` — inspect or create the state root used for snapshots and app state.
- `app_automation_run` — dry-run a plan or execute only deterministic allowlisted steps (`cli.exec`, `tendril.run`, `snapshot.write`).
- `/tendril-app [app] [action]` — operator/agent-facing command for quick app/action discovery.

## Blessed initial configs

### Slack

`slack` targets <https://app.slack.com/client> and starts with:

- `open` — open or reuse Slack web in a browser session.
- `notifications.snapshot` — future read-only extraction of unread/channel/DM summaries into:
  - `snapshots/slack/notifications.json`
  - `snapshots/slack/notifications.md`

Slack auth should reuse a Playwright/browser profile or an already-authenticated system browser session. The extension must never persist cookies, tokens, or secrets in repo files or snapshots.

### Canvas

`canvas` is a generic Markdown-to-editor sync profile. Its first action is:

- `sync-markdown` — read Markdown, export with `pandoc` or a configured renderer, open a target URL, replace/paste into a target selector, and persist sync metadata.

Planned outputs:

- `snapshots/canvas/latest.md`
- `snapshots/canvas/latest.html`
- `snapshots/canvas/sync.json`

### Outlook and Teams

`outlook` and `teams` are placeholder blessed configs for follow-up work. They establish app ids, auth expectations, and notification snapshot action names so agents can reference stable contracts while selectors and extraction logic are built.

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
   - `cli.exec` runs only allowlisted commands: `playwright-cli`, `tendril`, and `pandoc`.
   - `tendril.run` builds a structured `tendril run --window <target> <dsl>` invocation.
   - `snapshot.write` persists run metadata under the app snapshot directory.
   - high-level steps such as `browser.open`, `dom.extract`, `document.export`, and `editor.replace` remain planned until app-specific driver beads implement them.
4. **App-specific execution** lands behind the same plan vocabulary:
   - Prefer Playwright DOM extraction for structured read-only snapshots.
   - Use Tendril capture/run when visual verification or native input is needed.
   - Keep paste/import/write actions explicit and parameterized.
5. **Artifacts** always land under the app automation state root unless a future action explicitly accepts a workspace output path.

## Periodic refresh model

Periodic actions should stay Pi-native and controllable rather than using daemon-global cron or unmanaged shell loops. The intended follow-up shape is:

- `app_automation_refresh_start` for an app/action interval.
- `app_automation_refresh_status` to list active refreshers and last snapshot timestamps.
- `app_automation_refresh_stop` to stop one or all refreshers.
- bounded non-overlapping runs that skip a tick if the previous action is still active.

This model is tracked by `bd-829091`.

## Safety rules

- Prefer blessed app/action plans before raw browser commands.
- Do not persist web auth secrets in snapshots or git.
- Treat write actions (`sync-markdown`) as explicit and parameterized.
- Keep selectors and app-specific heuristics in app configs, not scattered across agent prompts.
- Store snapshots in canonical state paths so later agents can inspect the latest known app state.

## Follow-up beads

- `bd-afa933` — implement config loader and deterministic action runner.
- `bd-de1af2` — add Slack web notification snapshot extraction.
- `bd-cb5a40` — add Markdown-to-canvas sync execution.
- `bd-829091` — add periodic refresh controls and persisted snapshot storage.
- `bd-a7835e` — add Outlook and Teams blessed config examples.
