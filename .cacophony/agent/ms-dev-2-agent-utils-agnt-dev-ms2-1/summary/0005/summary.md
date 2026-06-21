# Session summary — kitty host passthrough probe

## Goal

Give operators a first-party way to diagnose the failure shape where
kitty-image-preview Unicode placeholders / pi-graphics primitives render as raw
glyphs or blank pixels inside caco/tmux. The suspected cause is the caco/Pi host
output path not forwarding raw kitty graphics escape sequences to the outer kitty
client. This session adds a passthrough probe command that emits a tiny labeled
kitty graphics test cell through each available terminal output path so the
operator can see, visually, which path actually reaches the kitty client.

## Bead(s)

- `bd-15374a` — Add caco host kitty passthrough probe for raw placeholder
  failures (promoted draft->open, claimed, implemented)
- builds on this session's earlier `bd-ded98d` (resolveGraphicsWriter writer
  resolution), filed originally via reflect-session from `bd-0395bf`

## Before state

- Failing tests: none (rebased base origin/main 4c9e48a).
- There was no first-party way to tell whether raw kitty graphics escapes reach
  the outer kitty client through a given output path; an operator hitting blank
  previews could not isolate the broken hop (widget render vs ctx.ui.write vs
  ctx.ui.terminal.write vs ctx.terminal.write) without ad-hoc instrumentation.
- `resolveGraphicsWriter` (landed in bd-ded98d) only resolves the FIRST working
  writer; nothing enumerated all candidate paths.

## After state

- Failing tests: none. Full `node --test` suite 696 pass / 0 fail. `docs:check`
  clean.
- New `/image-passthrough-probe` (alias `/kitty-passthrough-probe`) command:
  reports the detected passthrough mode (`detectKittyPassthroughMode`) and emits
  a tiny labeled magenta test cell through every available writer path, then
  notifies a summary. Whichever label renders a magenta cell is the working
  kitty output path; a blank cell or raw escape text isolates a non-forwarding
  host path. Soft-fails with an explanatory notice when no writer is reachable.
- New pure helpers, unit-tested without a terminal: `enumerateGraphicsWriters`
  (all reachable writers, in precedence order) and `buildPassthroughProbePlan`
  (deterministic one-command-per-writer plan, mode threaded into serialization).

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - `extensions/kitty-image-preview/passthrough-probe.js` — new module: embedded
    16x16 magenta `PROBE_PNG_BASE64`, namespaced `probeImageId`/`probePlacementId`,
    pure `buildPassthroughProbePlan`.
  - `extensions/kitty-image-preview/display-commands.js` — new
    `enumerateGraphicsWriters` (sibling to `resolveGraphicsWriter`).
  - `extensions/kitty-image-preview.js` — `passthroughProbeCommand` handler +
    `/image-passthrough-probe` registration; imports for the new helpers.
  - `README.md` — documented the probe command in both slash-command lists.
  - `test/kitty-passthrough-probe.test.js` — new file, 7 tests.
- Tests: +7 / -0 / flipped 0.
- Behavioural delta: adds an operator diagnostic command; no existing tool/render
  behaviour changed. Slash command (not a model tool), so no docs/tools.json edit.

## Operator-takeaway

When kitty previews show raw placeholder glyphs or blank cells inside caco/tmux,
run `/image-passthrough-probe`: it prints the detected passthrough mode and fires
a magenta test cell down each output path (ui.write / ui.terminal.write /
terminal.write). The path whose label shows a magenta square is the one that
reaches the kitty client; the rest are non-forwarding host hops. This is the
diagnostic slice of bd-15374a; the follow-on (auto-routing preview/pi-graphics
output through the discovered working path, or advertising a fallback) is a
separate, larger change and was intentionally not bundled here.
