# Session summary — Hide hardware cursor for styled Pi graphics cursor

## Goal

Respond to operator feedback that Pi's `showHardwareCursor` option should be disabled automatically when Pi graphics cursor styling is active, so the terminal's blinking hardware cursor does not compete with the custom vertical placeholder cursor.

## Bead(s)

- `bd-9cf120` — Disable Pi hardware cursor when graphics cursor styling is enabled
- Related: `bd-6f2fe8` — Make Pi graphics editor cursor steady in unicode placeholder mode

## Before state

- Failing tests: none known.
- Relevant metrics: full `npm test` passed 262/262 before this slice.
- Context: The styled cursor renderer was static, but Pi could still show the terminal hardware cursor when the user setting or `PI_HARDWARE_CURSOR=1` enabled it. That hardware cursor can blink over or near the styled placeholder cursor.

## After state

- Failing tests: none observed.
- Relevant metrics: targeted Pi graphics tests pass 114/114; `npm run docs:build` succeeds; `git diff --check` succeeds; full `npm test` passes 262/262.
- Context: Pi graphics now installs a TUI hardware-cursor guard when the custom editor surface is created. While graphics cursor styling is active, `setShowHardwareCursor(true)` is intercepted and the hardware cursor remains hidden; the user's intended setting is restored when cursor/editor styling is disabled or the session ends.

## Diff summary

- Code/content commits: `2e40560` (`bd-9cf120: hide hardware cursor for styled Pi cursor`)
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`, `.cacophony/agent/ms-mac-agent-utils-agnt-dev/summary/pending/summary.md`
- Tests: added source-level coverage for `PI_GRAPHICS_AUTO_EDITOR_CURSOR`, hardware-cursor guard installation, policy application, and restoration hooks.
- Behavioural delta: Styled Pi graphics cursors now suppress the terminal hardware cursor blink by default while preserving restoration and opt-out behavior.

## Operator-takeaway

The cursor graphic itself remains static; this change removes the separate terminal hardware cursor blink from the styled-cursor path. If blinking persists, it is likely Pi's fake-cursor render cadence rather than the hardware cursor, and `bd-6f2fe8` remains the follow-up to make that steady or smoothly animated.
