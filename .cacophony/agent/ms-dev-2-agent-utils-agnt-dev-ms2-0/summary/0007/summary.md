# Session summary — kitty preview ID namespace and diagnostics

## Goal

Harden the kitty image preview path after Harry observed raw Unicode placeholder glyphs/blank images inside caco/tmux. The session aimed to remove image/placement ID overlap as a confounder by reusing the pi-graphics scoped namespace, while adding status diagnostics that make caco host passthrough failures distinguishable from Unicode/ID bugs.

## Bead(s)

- `bd-0395bf` — Harden kitty image preview ID namespace and passthrough diagnostics
- Reflection draft: `bd-15374a` — Add caco host kitty passthrough probe for raw placeholder failures

## Before state

- `kitty-image-preview` image IDs were derived from absolute path, mtime, and size via `stableKittyImageId`.
- The preview placement ID was a static global `stableKittyImageId("agent-utils-kitty-image-preview-placement")`, then effectively reduced to a 24-bit underline-color placement selector in Unicode mode.
- `kitty_image_preview_status` reported only coarse `passthroughDetected`, `ssh`, and `memoryAuto` booleans, without the resolved transport/placement path or numeric IDs.
- Harry's live caco/tmux preview showed raw placeholder glyphs, leaving ID overlap and host passthrough as competing hypotheses.

## After state

- Added `extensions/kitty-image-preview/id-space.js`, delegating preview ID allocation to the pi-graphics scoped session/pid namespace.
- Static preview items now use `kittyPreviewImageId(kittyPreviewItemName(...))`.
- The default preview placement now uses `kittyPreviewDefaultPlacementId()`, backed by `piGraphicsPlaceholderPlacementId`, so Unicode placements are 24-bit placeholder-safe and session-scoped.
- `kitty_image_preview_status` now reports resolved `transport`, `passthrough`, `placement`, numeric image/placement IDs, Unicode 24-bit placement color, ownership count, guard count, and current command payload/file-path state.
- Validation: `npm test` passed, 563/563 tests.

## Diff summary

- Code/content commits: `0d530a8` (`bd-0395bf: scope kitty preview ids and expose diagnostics`)
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched:
  - `extensions/kitty-image-preview/id-space.js`
  - `extensions/kitty-image-preview.js`
  - `extensions/kitty-image-preview/state.js`
  - `test/kitty-image-preview-id-space.test.js`
- Tests: added 3 focused ID-space assertions; full suite remained green (`npm test`, 563/563).
- Behavioural delta: image preview no longer uses a static/global placement ID by default, and status output now exposes enough transport/ID state to tell whether failures are likely ID/Unicode issues or caco host passthrough issues.

## Operator-takeaway

The image-preview side is now hardened against stale/colliding kitty IDs and has better diagnostics, but if forced cursor-mode previews still render blank then the likely remaining bug is below image-preview: caco/Pi host passthrough is not delivering kitty graphics escape sequences to the outer kitty client. That follow-up is captured as draft `bd-15374a`.
