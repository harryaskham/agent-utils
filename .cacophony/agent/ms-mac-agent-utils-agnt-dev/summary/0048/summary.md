# Session summary — Pi graphics calm header chrome

## Goal

Harry still reported no visible Pi theme/graphics difference. This slice makes the top-level Pi header itself change in calm mode by default, using the existing high-tech `buildPiGraphicsHeaderComponent` through `ctx.ui.setHeader` outside showcase mode.

## Bead(s)

- `bd-261eb2` — Enable persistent Pi graphics header chrome in calm mode

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: targeted Pi graphics + kitty graphics tests passed 86/86 after raw bootstrap work.
- Context: prior visibility paths covered raw stdout, editor surface, transcript rails, theme files, OSC palette, widgets, and proof strips. The persistent header remained gated behind showcase widgets, so calm mode did not necessarily change the stable top frame.

## After state

- Failing tests: none in targeted validation.
- Relevant metrics: `npm test -- test/pi-graphics.test.js test/kitty-graphics.test.js` passes 86/86.
- Context: calm settings now default `PI_GRAPHICS_AUTO_HEADER_CHROME=1`. `applyThemeCues()` installs `buildPiGraphicsHeaderComponent` through `ctx.ui.setHeader` and reports `pi-gfx-header`; shutdown clears the status/header. Showcase widgets remain separate.

## Diff summary

- Code/content commits: `fb8a61c`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics/auto-widget.js`, `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`
- Tests: added default/opt-out checks for header chrome, settings-to-env source validation, and extension source wiring assertions for `shouldAutoShowHeaderChrome`, `setHeader`, and status cleanup.
- Behavioural delta: the top persistent Pi frame should now show the branded deep-Nordic high-tech header whenever the extension loads in calm mode, without requiring showcase mode.
- Validation: syntax checks for modified JS modules, `git diff --check`, and targeted tests passed.

## Operator-takeaway

After reload, the top header is another always-on visibility proof. If Harry sees neither the raw bootstrap nor the header chrome, this strongly indicates the live Pi process has not reloaded or is not loading the updated extension package.
