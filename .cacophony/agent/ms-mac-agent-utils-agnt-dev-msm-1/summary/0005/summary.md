# Session summary — fix node --test non-TTY hang (pin the test reporter)

## Goal

Fix the local-dev / CI-future-proofing friction found this session: `npm test`
(and `node --test`) hang indefinitely in a non-TTY context (piped or redirected)
on Node 26+, because the default-reporter auto-selection wedges. Pin an explicit
reporter so the test runner is deterministic across Node versions and TTY/non-TTY
contexts. Done overnight per Harry's "make meaningful progress" directive.

## Bead(s)

- `bd-dda361` — node --test hangs in non-TTY (piped/redirected) on Node 26.2.0
  with default reporter; npm test affected on newer Node (CI on Node 20
  unaffected)

## Before state

- Failing tests: none (suite passes interactively). But `npm test` / `node
  --test` hung with zero output when stdout was not a TTY on Node v26.2.0
  (verified: timed out, EXIT 124). CI is on Node 20 so it was green, but the
  hang blocks any non-TTY local run / piped automation on newer Node, and would
  bite when CI bumps Node.

## After state

- Failing tests: none. `npm test` in a non-TTY pipe now COMPLETES: 902 tests,
  902 pass, 0 fail, ~19.5s, EXIT 0.
- `package.json` `test` and `test:coverage` scripts now pass
  `--test-reporter=spec` (pretty in a TTY, readable in non-TTY, no hang). TTY
  interactive output is unchanged (spec is already the TTY default); CI checks
  exit code only, so spec-format logs are fine.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `package.json` (two script lines).
- Tests: 0 added (this is a runner-invocation fix); the full existing suite
  (902 tests) is the validation and passes.
- Behavioural delta: `npm test` no longer hangs in non-TTY on Node 26+.

## Operator-takeaway

`npm test` would silently hang for anyone running it piped/redirected on Node
26+ (the newer fleet nodes). One-line-per-script reporter pin fixes it with no
change to interactive output and no CI risk (CI on Node 20 only ever read the
exit code). If/when CI moves to Node 26+, this also prevents a 10-minute CI
timeout. The deeper cause is a Node-26 default-reporter regression in non-TTY
mode; pinning any explicit reporter sidesteps it.
