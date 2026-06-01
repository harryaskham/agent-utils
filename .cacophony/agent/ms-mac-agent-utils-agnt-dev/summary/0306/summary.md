# Session summary — /gfx settings runtime-only unless saved (bd-a1853d)

## Goal
Operator (Harry): /gfx settings changes should be runtime-only unless Enter is
pressed in the /gfx settings dialog or `/gfx save` is run, so `pi '/gfx mode on'`
and similar can be used to try modes without mangling ~/.pi/agent/settings.json.

## Before
Every mutating /gfx subcommand persisted immediately: the main mutation loop ran
applyGfxSettingsAndReload() (saveSettings + ctx.reload), and /gfx debug, /gfx
preset, /gfx next|prev, and /eink also saved. Only the dialog Enter path was
already save-on-confirm.

## After
- Added an in-memory runtime overlay (runtimeSettingsOverride) plus helpers:
  readGfxSettingsBase, applyGfxSettingsRuntimeOnly (live apply, NO reload, NO
  save), hasUnsavedGfxChanges, saveGfxRuntimeOverride (flush + clear).
- Converted all /gfx CLI mutations (mode/editor/box/preset/next/prev/debug) and
  /eink to runtime-only; each notifies "(runtime only — /gfx save to persist)".
- Added `/gfx save` to flush the overlay to settings.json.
- Dialog Enter still persists (now via the same flush path); Esc/q closes without
  saving.
- /gfx status shows an `unsaved:` indicator; usage lists `/gfx save`.
- Successive runtime mutations compose via the overlay base.

## Diff
- extensions/pi-graphics.js: overlay state + helpers; mutation paths switched to
  runtime-only; status/usage updated.
- test/pi-graphics.test.js: new test asserting runtime-only-by-default, /gfx save
  flush, dialog-Enter persist, no eager applyGfxSettingsAndReload call sites,
  status indicator.
- docs/pi-graphics.md (+ rendered docs/index.html): documented the runtime-only
  vs save model.
- Full JS suite green (460), docs check valid.

## Operator-takeaway
`pi '/gfx mode on'` (and other /gfx mutations) now apply live without touching
home config. Persist deliberately with `/gfx save` or dialog Enter.
