# Session summary — Pi graphics raw bootstrap proof

## Goal

Harry still could not see Pi graphics/theme changes. This slice adds a visibility path below the Pi UI abstraction: a bounded raw truecolor terminal block written directly to stdout at session start, so the operator can tell whether the extension loads even if theme APIs, widgets, editor wrapping, transcript messages, kitty images, and OSC palette handling are all ineffective or too subtle.

## Bead(s)

- `bd-384b5a` — Add raw terminal bootstrap proof for Pi graphics visibility

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: targeted Pi graphics + kitty graphics tests passed 85/85 after editor-surface work.
- Context: prior work made theme files available, requested OSC palette changes, mounted rendered APNG/ANSI proof surfaces, added transcript rails, and wrapped the editor surface. The repeated visibility report suggests a need for a dependency-free proof that fires before/alongside Pi UI surfaces.

## After state

- Failing tests: none in targeted validation.
- Relevant metrics: `npm test -- test/pi-graphics.test.js test/kitty-graphics.test.js` passes 86/86.
- Context: calm mode now defaults `PI_GRAPHICS_AUTO_RAW_BOOTSTRAP=1`. On `session_start`, `pi-graphics` writes a three-line truecolor deep-Nordic block directly to `process.stdout` using `buildPiGraphicsRawBootstrapText()`. It includes the reload sentinel and explicitly labels the raw path as independent of theme/widget/editor/kitty dependencies. Opt out with `PI_GRAPHICS_AUTO_RAW_BOOTSTRAP=0`.

## Diff summary

- Code/content commits: `56bce44`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics/auto-widget.js`, `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`
- Tests: added raw bootstrap output tests for truecolor ANSI escapes, sentinel, deep-Nordic glyph rail, default/opt-out behavior, settings-to-env mapping, and extension source wiring for `process.stdout.write` at startup.
- Behavioural delta: if the extension is loaded, the next session start should show a direct raw truecolor bootstrap block, regardless of whether any Pi TUI surface applies the theme.
- Validation: syntax checks for modified JS modules, `git diff --check`, and targeted tests passed.

## Operator-takeaway

This is now a binary live diagnostic: if Harry cannot see the raw bootstrap after reload/startup, the installed extension is not running in that live Pi process or stdout is being suppressed. If he can see it but not the other chrome, the issue is specifically in Pi UI integration surfaces.
