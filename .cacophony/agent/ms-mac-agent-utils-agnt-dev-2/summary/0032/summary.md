# Session summary — Adaptive effort true default

## Goal

Make adaptive thinking selectable as a default/true-default effort in Pi settings without confusing it with core Pi thinking levels or `/fast`.

## Bead(s)

- `bd-308403` — Support adaptive effort as true default

## Before state

- `true-defaults` accepted only core thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`).
- The effort extension did not read settings defaults, so `adaptive` could only be enabled manually with `/effort adaptive` per runtime.
- Passing `adaptive` through core `setThinkingLevel` would be unsafe because adaptive is extension-managed state, not necessarily a core Pi thinking level.

## After state

- `true-defaults` now accepts `adaptive` in `agentUtils.trueDefaults.thinkingLevel`, `trueDefaultThinkingLevel`, `trueDefaultEffort`, etc.
- It persists `defaultThinkingLevel: "adaptive"` when configured, but deliberately does not call core `setThinkingLevel("adaptive")`.
- The effort extension reads default effort from settings and enables adaptive mode on extension load / `session_start` when the configured default is `adaptive`.
- Supported settings shapes include:
  - `agentUtils.trueDefaults.thinkingLevel: "adaptive"`
  - `agentUtils.trueDefaults.effort: "adaptive"`
  - `agentUtils.trueDefaultThinkingLevel: "adaptive"`
  - `agentUtils.trueDefaultEffort: "adaptive"`
  - `trueDefaultThinkingLevel: "adaptive"`
  - `trueDefaultEffort: "adaptive"`
  - `defaultThinkingLevel: "adaptive"`

## Diff summary

- Code/content commit: 5423e33.
- Files touched: `extensions/effort.js`, `extensions/true-defaults.js`, `test/effort-command.test.js`, `test/true-defaults.test.js`, `README.md`.
- Tests added:
  - default effort extraction recognizes adaptive settings,
  - adaptive true-default enables adaptive payload rewriting on startup,
  - true-defaults persists adaptive but does not call core `setThinkingLevel`.

## Validation

- `node --test test/effort-command.test.js test/true-defaults.test.js` — pass, 25 tests.
- `npm run docs:check` — pass.
- `git diff --check` — pass.
- `npm test` — pass, 327 tests.

## Operator-takeaway

Add this to settings to make adaptive the startup default:

```json
{
  "agentUtils": {
    "trueDefaults": {
      "thinkingLevel": "adaptive"
    }
  }
}
```

This is independent from `/fast`, which still only toggles `model`/`model-fast`.
