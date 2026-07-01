# Session summary — lint-workflows: loud/strict actionlint-absent signal (bd-c2eb33)

## Goal

Close the "local green != CI gate" footgun in `npm run check`: when actionlint is
not on PATH, `lint:workflows` previously fell back to a YAML-only validator (or a
no-validator skip) *silently*, so a local check could pass while CI's actionlint
gate (which also checks Actions semantics — runner labels, expression syntax)
fails. This bit the azure-ephemeral runner-label migration concretely. Make the
fallback loud and offer an opt-in strict hard-fail so pre-PR check can match CI.

## Bead(s)

- `bd-c2eb33` — npm run check silently skips actionlint when missing (local green != CI gate)

## Before state

- Failing tests: none.
- `scripts/lint-workflows.mjs`: `lintWorkflows()` returned `{ok, skipped, validator, files, errors}`;
  when actionlint was absent it fell back to ruby/python YAML-only checks (or skipped)
  with no signal that the actionlint semantic layer had not run. `main()` printed a
  warning only for the no-validator-at-all case.
- `test/lint-workflows.test.js`: 4 tests (listing, well-formed repo, empty dir, malformed).

## After state

- Failing tests: none. `node --test test/lint-workflows.test.js` = 6/6; full `npm test` green.
- `lintWorkflows()` now also returns `usedActionlint` and accepts a `strict` option:
  - `usedActionlint` is true only when the actionlint validator actually ran.
  - `strict: true` turns an actionlint-absent run (YAML-only fallback OR no validator)
    into a hard failure (`ok:false`, `(actionlint)` error).
- `main()` reads `LINT_WORKFLOWS_STRICT=1`, prints a loud non-silent warning whenever a
  YAML-only fallback ran (actionlint absent), and hard-fails (exit 1) under strict. The
  no-validator-at-all case stays a soft skip by default (unchanged), or a clean strict
  FAILED message; default `npm run check` is NOT regressed for parser-less environments.
- Verified via CLI: actionlint present -> `OK ... via actionlint`, exit 0; `LINT_WORKFLOWS_STRICT=1`
  with actionlint absent -> loud warning + `FAILED`, exit 1.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `scripts/lint-workflows.mjs` (usedActionlint + strict + loud main warning + header note),
  `test/lint-workflows.test.js` (+2 tests: usedActionlint on fallback; strict fails when actionlint absent).
- Tests: +2 / -0 / flipped 0.
- Behavioural delta: workflow-lint no longer silently green-lights when the actionlint
  semantic layer was skipped; loud by default, hard-fail under LINT_WORKFLOWS_STRICT=1.

## Operator-takeaway

The workflow-lint used to fool a local `npm run check` into passing when actionlint
wasn't installed (only YAML well-formedness ran, not Actions semantics), so
runner-label/expression errors only surfaced in CI. Now it says so loudly, and
`LINT_WORKFLOWS_STRICT=1` makes it a hard failure for anyone who wants local==CI
parity. actionlint already ships in the repo's nix devShell, so the devShell path
stays fully green with real semantic checks.
