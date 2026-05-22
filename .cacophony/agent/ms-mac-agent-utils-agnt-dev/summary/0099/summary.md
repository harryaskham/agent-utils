# Session summary — PID-salted Pi graphics ids

## Goal

Fix the operator-reported cross-window kitty graphics bleed where multiple live Pi instances in tmux reused the same configured Pi graphics namespace and one process's images appeared in another pane/window.

## Bead(s)

- `bd-a2cc54` — Avoid Pi graphics kitty ID collisions across live tmux instances

## Before state

- Failing tests: none known.
- Relevant metrics: previous full `npm test` passed 261/261 after the unicode box width fix.
- Context: `piGraphicsIdScope()` included the process id only when no explicit `PI_GRAPHICS_ID_NAMESPACE` / `PI_KITTY_GRAPHICS_NAMESPACE` was configured. In real managed/home Pi setups that configured namespace can be shared by multiple live Pi processes in the same tmux terminal, causing terminal-global kitty image/placement id collisions.

## After state

- Failing tests: none observed.
- Relevant metrics: targeted Pi graphics/kitty tests pass 99/99; `npm run docs:build` succeeds; `git diff --check` succeeds; full `npm test` passes 261/261.
- Context: Pi graphics id scope now appends `:pid:<pid>` even for configured namespaces. Tests/debugging can opt into exact historical namespaces with `PI_GRAPHICS_ID_NAMESPACE_EXACT=1` or `PI_KITTY_GRAPHICS_NAMESPACE_EXACT=1`.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics/id-space.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`, `.cacophony/agent/ms-mac-agent-utils-agnt-dev/summary/pending/summary.md`
- Tests: scoped-id test now asserts configured namespace plus pid salting and the exact override behavior.
- Behavioural delta: two live Pi processes sharing a namespace should allocate disjoint kitty graphics ids, reducing stale/cross-pane image pop-in.

## Operator-takeaway

The tmux collision root cause was configured namespaces overriding the pid salt. The default is now safe for many live Pi instances; exact namespaces are explicit debug-only behavior.
