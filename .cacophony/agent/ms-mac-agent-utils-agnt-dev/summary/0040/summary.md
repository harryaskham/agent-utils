# Session summary — Visible Pi kitty TUI surface renderer

## Goal

Harry reported that Pi kitty graphics still did not look visibly different enough and asked for better TypeScript-side rendering/validation inspired by the Cacophony Rust visual implementation. This slice makes calm mode visibly graphical again without returning to transcript spam: it adds an efficient APNG-rendered Pi TUI surface that mirrors real UI structure and strengthens tests so they inspect generated pixels, animation chunks, and theme deltas.

## Bead(s)

- `bd-09c76e` — Improve Pi kitty graphics visibility with rendered TUI validation

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: prior targeted Pi graphics + kitty graphics suite passed 77/77.
- Context: the previous calm-mode fix hid most loud graphics by default, but that made the operator-visible theme/gfx delta too subtle. Existing validation covered individual component/card/terminal-scene pixels, but not a full Pi-like TUI surface with transcript cards, tool lane, editor input chrome, footer/status beacons, and efficient default animation.

## After state

- Failing tests: none in targeted validation.
- Relevant metrics: `npm test -- test/pi-graphics.test.js test/kitty-graphics.test.js` passes 80/80.
- Context: calm mode now auto-applies the selected `kitty-graphics-nord` theme and mounts a compact APNG-rendered TUI surface above the editor by default. The surface is a TypeScript-rendered pixel mirror of Pi UI chrome: user/assistant/tool cards, input/editor box, footer beacons, deep Nordic vertical gradients, radial cyan/violet/aurora glow, scanlines, and pulse waveform. The APNG default is bounded to four frames / 90ms delay for one efficient kitty upload. The full scene is also available through `/pi-graphics-tui-surface-scene` and `pi_graphics_render_tui_surface_scene`.

## Diff summary

- Code/content commits: `0859625`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics/components.js`, `extensions/pi-graphics.js`, `extensions/pi-graphics/auto-widget.js`, `test/pi-graphics.test.js`, `themes/kitty-graphics-nord.json`, `docs/pi-graphics.md`
- Tests: added full TUI surface PNG validation, APNG chunk/size validation, validation-report checks for the TUI surface, ambient chrome default tests, and stronger Nord theme displacement checks.
- Behavioural delta: users should now see an obvious high-tech rendered graphics panel in normal calm mode, while debug/showcase transcript fireworks remain opt-in.
- Validation: syntax checks for modified JS modules, `git diff --check`, and targeted tests passed.

## Operator-takeaway

The important change is that Pi graphics mode now validates and displays a real TypeScript-rendered TUI surface, not just a theme palette or source-wiring claim. If it still looks unchanged after package reload, the remaining problem is likely theme/extension reload or kitty placeholder delivery rather than the renderer failing to produce visible pixels.
