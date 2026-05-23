# Session summary — Prompt Pi graphics bash chrome

## Goal

Continue Harry's Pi kitty graphics polish by giving bash/command-output panes their own shell-prompt motif that feels terminal-native while staying static, cached, and efficient.

## Bead(s)

- `bd-a0e88a` — Add efficient prompt Pi graphics bash chrome

## Before state

- Failing tests: none known.
- Relevant metrics: existing box chrome supported cached strip effects through `glass`, `aurora`, `scanline`, `circuit`, `sparkle`, `cloud`, `prism`, `veil`, `holo`, `lattice`, `contour`, `weave`, `badge`, `glyph`, `compass`, `blueprint`, `dendrite`, `braid`, `metronome`, `signal`, `halo`, `caret`, `chamfer`, `constellation`, `orbit`, `rune`, `fold`, `nebula`, `waveform`, `ribbon`, `aperture`, `caliper`, `mosaic`, and `keystone`.
- Context: Bash panes still shared the technical `blueprint` motif with tool panels, so command output lacked a dedicated shell visual language.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --test test/box-chrome.test.js test/pi-graphics.test.js` passed 95/95; full `npm test` passed 274/274; `npm run docs:check` passed; `git diff --check` passed.
- Context: Box chrome now includes a `prompt` effect for bash surfaces, built from shell rails and cursor-block marks using deterministic fixed-stride rectangle drawing.

## Diff summary

- Code/content commits: `fbd4628`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/pi-graphics/box-chrome.js`, `test/box-chrome.test.js`, `docs/pi-graphics.md`.
- Tests: extended box-effect variant coverage to include `prompt` / -0 / flipped 0.
- Behavioural delta: Bash chrome now gets shell prompt rails, while tool surfaces keep sparse blueprint drafting rules.

## Operator-takeaway

Command-output panes now feel more like kitty-rendered shell surfaces rather than generic technical boxes, without blinking cursors, streaming animation, or expensive redraw paths.
