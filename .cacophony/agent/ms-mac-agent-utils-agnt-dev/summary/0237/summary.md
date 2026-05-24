# Session summary — Box chrome opt-in default

## Goal

Make Pi graphics defaults sensible for live use by keeping editor/cursor visual flair while making the janky live box chrome opt-in, and tune the managed agent settings to match.

## Bead(s)

- `bd-245b05` — Make Pi graphics box chrome opt-in by default

## Before state

- Failing tests: none known.
- Relevant metrics: focused graphics checks and full `npm test` were passing before this change.
- Context: `piGraphics.boxChrome` defaulted on unless explicitly false, and the local managed settings forced `boxChrome: true`, `boxMode: "relative"`, and `boxEffect: "glass"`, which made the live box effects feel janky.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --check extensions/pi-graphics.js`; focused `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 102/102; full `npm test` passed 285/285; `npm run docs:check` passed; `git diff --check` passed.
- Context: box chrome now exports `PI_GRAPHICS_AUTO_BOX_CHROME=1` only when `piGraphics.boxChrome === true`; status/debug/doctor/settings text reports box chrome as off unless explicitly enabled, and defaults to `unicode` mode if enabled.

## Diff summary

- Code/content commits: `50ec43b`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`.
- Tests: updated source guards for opt-in box chrome defaults, default unicode box mode, and opt-in status text.
- Behavioural delta: live sessions keep Pi graphics editor/cursor flair but do not enable the janky box chrome unless the user explicitly opts in with `/gfx box on` or `piGraphics.boxChrome: true`.

## Operator-takeaway

The practical default is now calmer: editor/cursor graphics remain available, while box chrome becomes an inspection/opt-in feature rather than a default live decoration.
