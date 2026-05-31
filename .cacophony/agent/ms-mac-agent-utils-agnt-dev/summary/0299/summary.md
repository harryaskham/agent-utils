# Session summary — /m model-switch command (scope-independent)

## Goal

Operator hit friction where scoped-models (Pi's Ctrl+P model-cycling scope) also blocks `/model <arbitrary-model>`, forcing `/scoped-models` then Tab-to-"all" then pick. The ask: give a quick independent `/m` command that tab-completes from the full `provider/model` list and switches immediately, while leaving Pi's built-in `/model` and `/scoped-models` (Ctrl+P) untouched.

## Bead(s)

- `bd-bc26e9` — scoped-models blocks `/model <arg>`; should only govern Ctrl+P cycling (resolved via the agent-utils `/m` command path, option B)

## Before state

- No `/m` command. Switching to an out-of-scope model required opening the selector and toggling its `all` scope.
- Root cause (investigated): `/scoped-models` is a **Pi builtin**, not a collective extension. Pi's `getModelCandidates()` returns only the scoped set when scope is active, and the builtin `/model <arg>` (consumed by the TUI submit handler before any extension `input` hook) resolves through it. Scope is activated by `enabledModels` in `~/collective/standalone/pi/settings.json`. Pi is built from the `llm-agents.nix` flake input, so the builtin is not patchable from an agent-utils extension. There is no legacy voice plugin in collective to migrate/remove.
- Tests: 441 passing.

## After state

- New `extensions/m.js` registers `/m <provider/model>`:
  - resolves against the **full** registry (`modelRegistry.refresh()` + `getAvailable()`, fallback `getAll()`), never the scoped set;
  - `getArgumentCompletions` Tab-completes every `provider/model` string (fuzzy across whitespace tokens, canonical-prefix sorted, capped at 50), using a registry captured at `session_start`;
  - matching mirrors Pi core: canonical `provider/id`, then `provider/id` split, then unambiguous bare id;
  - no-arg prints usage + available count; no match warns with suggestions; failed switch reports an error.
- Pure helpers exported and unit-tested. Does not touch `/model` or `/scoped-models`.
- Registered in `package.json` `pi.extensions`; documented in README and `docs/tools.json` (+ regenerated `docs/index.html`).
- Tests: 456 passing (15 new).

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Files touched: `extensions/m.js` (new), `test/m-command.test.js` (new), `package.json`, `README.md`, `docs/tools.json`, `docs/index.html`.
- Tests: +15 (`test/m-command.test.js`); full suite 441 → 456 green.
- Behavioural delta: adds scope-independent `/m` model switcher with full-list Tab-completion; no change to Pi builtins.

## Embedded artefacts

- None.

## Operator-takeaway

scoped-models is upstream-Pi, not ours, so we did not patch Pi or migrate anything out of collective. `/m` is the agent-utils-owned fast path: it ignores scope and tab-completes the whole model list, while `/scoped-models` keeps governing only Ctrl+P. If a true fix to the builtin `/model` is wanted later, that needs a Pi overlay `postPatch` or an upstream PR (tracked thinking in `bd-bc26e9`).
