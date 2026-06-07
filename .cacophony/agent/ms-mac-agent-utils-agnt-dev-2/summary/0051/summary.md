# Session summary — Native kitty preview defaults

## Goal

Fix `bd-903d89`, a kitty-image-preview papercut where native no-passthrough Ghostty sessions selected file transport and Unicode placeholder placement by default, producing Node fd-33 warnings and leaking placeholder/tofu glyphs into the TUI instead of rendering quietly.

## Bead(s)

- `bd-903d89` — kitty-image-preview defaults to file transport + unicode placement on no-passthrough Ghostty, causing fd-33 warnings + placeholder tofu

## Before state

- Failing tests: none known at claim time.
- Relevant metrics: reproducer notes showed `passthrough=none`, `transport=file`, and `placement=unicode` on native Ghostty.
- Context: `shouldUseInMemoryTransfer` only selected memory transfer for tmux or SSH, and kitty-image-preview auto placement forced Unicode placeholders for anchored preview rendering even when there was no tmux/SSH passthrough hop.

## After state

- Failing tests: none observed.
- Relevant metrics: `node --test test/kitty-graphics.test.js test/kitty-image-preview-widget.test.js` passed 34/34; `node --test test/kitty-*.test.js` passed 100/100.
- Context: native kitty-compatible terminals such as Ghostty, Kitty, and WezTerm now default to in-band memory transfer, and no-passthrough native Ghostty auto placement chooses cursor placement instead of Unicode placeholders unless explicitly forced.

## Diff summary

- Code/content commits: `287608a`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `extensions/kitty-graphics.js`, `extensions/kitty-image-preview.js`, `extensions/kitty-image-preview/placement.js`, `test/kitty-graphics.test.js`, `test/kitty-image-preview-widget.test.js`, `.cacophony/agent/ms-mac-agent-utils-agnt-dev-2/summary/pending/summary.md`.
- Tests: added native-terminal transfer detection assertions and a Ghostty no-passthrough placement regression test.
- Behavioural delta: auto transfer now uses memory for native kitty-compatible terminals, and auto placement suppresses Unicode placeholders for native no-passthrough Ghostty so the preview avoids raw fd churn and placeholder cell leakage while keeping tmux/forced anchoring behaviour intact.

## Operator-takeaway

The Ghostty image preview path now uses the safer native-terminal defaults Harry expected: memory transfer plus cursor placement when no passthrough hop exists, while tmux/SSH-compatible anchoring remains available where it is actually needed.
