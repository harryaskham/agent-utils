# Session summary — Cursor-anchored editor row background

## Goal

Follow up on operator feedback that the Unicode placeholder editor background only started after typed text. Use the known cursor position and editor render width to attach a row background to the graphical cursor without overwriting text cells.

## Bead(s)

- `bd-ebab69` — Anchor Pi editor background to cursor geometry

## Before state

- Failing tests: none known.
- Relevant metrics: previous full `npm test` passed 260/260.
- Context: Cursor chrome was mode-independent, and Unicode placeholder tails filled the trailing workspace after the cursor. However, already-typed cells could not show placeholder background because replacing those cells would overwrite text.

## After state

- Failing tests: none observed.
- Relevant metrics: targeted Pi graphics tests pass 112/112; `npm run docs:build` succeeds; `git diff --check` succeeds; full `npm test` passes 260/260.
- Context: The graphical cursor now anchors a low-z-index relative row background image. The background spans the rendered editor width and shifts left by the measured cursor column, so it can sit behind typed text while the placeholder tail remains a caco-compatible fallback for trailing space cells.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`, `.cacophony/agent/ms-mac-agent-utils-agnt-dev/summary/pending/summary.md`
- Tests: source assertions cover cursor-column measurement, relative background placement, low z-index layering, and row-width propagation.
- Behavioural delta: typing `abc` should no longer mean graphics only begin after `abc`; a row-wide relative background can be positioned from the cursor anchor to cover the full editor line beneath text.

## Operator-takeaway

The editor background is now cursor-aware: placeholder tails still work, but the richer background path is a relative placement centered on the cursor geometry, setting up the future heat/trail animation without idle ticking.
