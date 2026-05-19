# Session summary — Opt-in verbose Pi graphics chrome

## Goal

Respond to Harry's follow-up that the visible Pi kitty graphics mode was still mostly text and too busy, and make the default calm path avoid verbose startup diagnostics and large textual/proof chrome.

## Bead(s)

- `bd-c786d2` — Make Pi graphics verbose startup chrome opt-in

## Before state

- Failing tests: none observed.
- Relevant metrics: full package suite passed 218/218 before this slice.
- Context: Even after the first subtle-rail pass, calm mode could still auto-emit theme activation warnings, raw bootstrap proof text, ambient proof text, transcript/header chrome, footer branding, and a large ambient APNG scene. The current session also showed stale package/update notices and theme collision diagnostics from the old installed package.

## After state

- Failing tests: none; `node --test test/pi-graphics.test.js`, `npm test`, and `npm run check` all pass.
- Relevant metrics: full package suite passed 218/218; targeted Pi graphics tests passed 73/73.
- Context: Calm/default mode now keeps theme and terminal palette application enabled, keeps only the subtle editor surface rails by default, reduces the footer to tiny glyph accents plus branch, and moves raw bootstrap, ambient proof, ambient APNG scene, transcript chrome, and header chrome behind explicit opt-in/showcase settings. Theme activation details are still available through `/pi-graphics-theme-status` but no longer auto-notify unless showcase or `PI_GRAPHICS_THEME_STATUS_NOTIFY=1` is set.

## Diff summary

- Code/content commits: `752cae0`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics.js`, `extensions/pi-graphics/auto-widget.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`
- Tests: updated Pi graphics tests to assert opt-in defaults for ambient/raw/transcript/header surfaces and a minimal footer.
- Behavioural delta: Default Pi graphics calm mode no longer spams diagnostic/proof text or large automatic graphics; explicit commands and showcase/debug mode retain the verbose visual diagnostics.

## Operator-takeaway

The default mode is now much closer to Harry's requested direction: subtle accents first, diagnostics only on request. The running Pi session still needs an update/reload to pick up the landed package changes.
