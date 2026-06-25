# Session summary — docs/tools.json inventory drift reconciliation (bd-4500b9)

## Goal

The published GitHub Pages tool inventory (docs/tools.json -> docs/index.html)
had drifted from the package's own README: it listed /m but not its siblings
/effort and /true-defaults, listed Firecracker/Tendril but not xvfb/android, and
omitted pi-self-update, git-behind, copilot-auth-refresh, and
compaction-continue-guard — all README-documented repo extensions. This chunk
reconciles the public inventory with the README so operators/agents browsing the
docs site can discover every provided tool. Documentation-only; no behavior
change.

## Bead(s)

- `bd-4500b9` — Reconcile docs/tools.json inventory drift: add 8
  README-documented extensions missing from published docs (task; filed +
  claimed + landed).

## Before state

- docs/tools.json lastReviewed 2026-05-12; 26 inventory entries; 8
  README-documented extensions absent.
- JS suite: 764 tests passing; docs:check green.

## After state

- 8 concise, factual entries added to the "Repo-local tools" section (mirroring
  README wording, matching the name/command/audience/purpose/commonActions/
  sourceOfTruth schema); lastReviewed bumped to 2026-06-25; docs/index.html
  regenerated via npm run docs:build.
- tools.json diff is addition-only apart from the lastReviewed bump. JS suite:
  764 passing (unchanged); `npm run check` (lint:workflows + docs:check) green.

## Diff summary

- Code/content commit: `pending final squash SHA from reintegration receipt`.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: `docs/tools.json` (+8 entries, lastReviewed), `docs/index.html`
  (regenerated).
- Tests: +0 / -0 (docs-only; suite remains 764 green).
- Behavioural delta: none — public docs completeness only.

## Operator-takeaway

The docs site now advertises all 34 first-party/repo tools instead of 26; the
gap was drift (new extensions landed without updating the curated inventory),
evidenced by /m being listed while its siblings /effort and /true-defaults were
not. Entries are factual and concise, so trimming any the curator considers too
granular is a one-line edit. If future extensions are added, updating
docs/tools.json (and running npm run docs:build) should be part of that change.
