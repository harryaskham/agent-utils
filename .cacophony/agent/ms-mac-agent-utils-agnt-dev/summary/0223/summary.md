# Session summary — Box chrome doctor guidance

## Goal

Add read-only `/gfx box doctor` guidance so operators can understand when to use box status, summary, preview, per-surface auto mappings, forced effects, and relative/unicode placement modes.

## Bead(s)

- `bd-c3ef66` — Add Pi graphics box chrome doctor guidance

## Before state

- Failing tests: none known.
- Relevant metrics: `/gfx box status` and `/gfx box summary` provided no-render audits, and `/gfx box preview` provided bounded visual strips, but there was no single box-focused diagnostic guide tying those commands and mode choices together.
- Context: The new guidance needed to be read-only, bounded, and aligned with the existing cursor doctor pattern.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 284/284; `npm run docs:check` passed; `git diff --check` passed.
- Context: Added `boxChromeDoctorLines()` and routed `/gfx box doctor`, `/gfx box help`, `/gfx box why`, and `/gfx box-doctor` to read-only guidance.

## Diff summary

- Code/content commits: `10a090d`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: extended source guards for doctor helper, no-render guidance, aliases, and settings overlay usage.
- Behavioural delta: Box chrome inspection now has a layered workflow: status for full mapping, summary for compact grouping, doctor for guidance, and preview for bounded visuals.

## Operator-takeaway

Use `/gfx box doctor` as the no-render explanation of the box chrome toolkit before deciding whether to inspect status, summary, preview, or reset to `/gfx box-effect auto`.
