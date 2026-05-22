# Session summary — Pi true-defaults settings guard

## Goal

Implement bd-1c47a6 so Harry can keep immutable-by-convention Pi defaults for provider, model, and thinking effort even when runtime TUI controls temporarily change the active selection during a session.

## Bead(s)

- `bd-1c47a6` — Add trueDefault model/provider/effort settings guard

## Before state

- Failing tests: none known at session start.
- Relevant metrics: no `trueDefault*` persistence guard existed in `agent-utils`; `/effort` could adjust runtime thinking level but default model/provider/thinking persistence remained owned by Pi's normal settings keys.
- Context: `settings.md` documents `defaultProvider`, `defaultModel`, and `defaultThinkingLevel`; the bead asked for separate true-default settings that are only changed by direct settings edits.

## After state

- Failing tests: none observed.
- Relevant metrics: targeted `node --test test/effort-command.test.js test/true-defaults.test.js` passed 12/12; full `npm test` passed 272/272; `npm run docs:check` passed.
- Context: `extensions/true-defaults.js` is packaged as a Pi extension, restores persisted defaults on load/startup/shutdown, applies active runtime defaults on startup when model/thinking APIs are available, and exposes `/true-defaults [status|apply]` for inspection/reapply.

## Diff summary

- Code/content commits: `accfe03`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/true-defaults.js`, `test/true-defaults.test.js`, `package.json`, `README.md`.
- Tests: added 6 unit tests covering namespaced/legacy key parsing, persisted default restoration, startup runtime application, shutdown restoration, runtime model switch non-interception, and project-over-global source selection.
- Behavioural delta: users can configure `agentUtils.trueDefaults` (or legacy `trueDefault*` keys) and runtime `/model`, Ctrl+P, `/settings`, and `/effort` changes remain allowed without becoming the restored persisted defaults.

## Operator-takeaway

`agent-utils` now has a dedicated true-defaults guard: edit the true-default values directly in `settings.json`, then let the extension copy them back to Pi's normal default keys at startup and clean shutdown while leaving normal in-session model/effort switching flexible.
