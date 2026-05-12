# Session summary — bead dependency semantics

## Goal

Clarify how agent-utils workers should distinguish parent epic grouping from blocking dependency links when filing or claiming Cacophony beads.

## Bead(s)

- `bd-a31631` — Clarify bead dependency semantics when linking tasks to parent epics

## Before state

- Failing tests: none known.
- Relevant metrics: no repo-local note explained that `dependencies` are blockers rather than parent-epic links.
- Context: a prior workflow friction report described a ready task becoming unclaimable because an unresolved epic was used as a dependency.

## After state

- Failing tests: none; `npm run docs:check` passed.
- Relevant metrics: added one workflow note document and linked it from README.
- Context: operators/agents now have a concise repo-local convention for parent epics versus blocking dependencies.

## Diff summary

- Commits: `02c5740`
- Files touched: `README.md`, `docs/bead-workflow.md`
- Tests: docs inventory check passed.
- Behavioural delta: no runtime behaviour change; this is documentation to reduce bead-filing/claiming errors.

## Operator-takeaway

Use `dependencies` only for true blockers; put parent epic context in descriptions/labels until there is a first-class parent field.
