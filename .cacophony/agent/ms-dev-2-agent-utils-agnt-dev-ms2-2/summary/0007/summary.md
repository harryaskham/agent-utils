# bd-37d130 — agent-utils CI → azure-ephemeral self-hosted runners

## What
Operator directive (Harry, 2026-06-28): bringing up azure-ephemeral self-hosted
GitHub runners (x86-capable); one agent per project routes that project's
x86/Linux CI to them via `runs-on: [self-hosted, azure-ephemeral]`. ms2-2 owns
the agent-utils slice (won the 6-agent claim race on earliest broadcast 18:36:30
+ first-filed bead).

## Changes
- **`.github/workflows/ci.yml`** — `js`, `rust`, `audit` jobs:
  `runs-on: ubuntu-latest` → `[self-hosted, azure-ephemeral]`.
- **`.github/workflows/pages.yml`** — `changes`, `build`, `deploy` jobs: same.
  All 6 agent-utils CI jobs are x86/Linux (no macOS/darwin jobs), consistent
  with the router's "x86/Linux jobs only, leave macOS on existing runners".
- Reconciled the two now-stale comments (ci.yml `js`, pages.yml `build`) that
  justified GitHub-hosted "to avoid the managed/self-hosted fleet" — superseded
  by the dedicated azure-ephemeral pool.
- **NEW `.github/actionlint.yaml`** — registers the custom `azure-ephemeral`
  label under `self-hosted-runner.labels`. Required: actionlint (run by
  `npm run lint:workflows`, also the CI lint step) otherwise FAILS the change
  with "label azure-ephemeral is unknown".

## Landing note
Landed via **`--mode direct`**, deliberately not pr_auto_merge: a PR's own
ci.yml now requires the not-yet-live azure-ephemeral runners, so pr_auto_merge
would deadlock waiting on CI that can't run until the runners are up. Direct
squash-merge avoids the chicken-and-egg; CI only runs on tag/PR/dispatch, not
main pushes, so landing does not immediately queue jobs.

## Validation
- `npm run check` — lint:workflows (actionlint, 2 files) **OK**; docs:check **OK**.
