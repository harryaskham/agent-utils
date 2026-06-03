# Session summary — Headless-node display detection helper

## Goal

The operator hinted (broadcast) to "be creative" about headless nodes, naming
Xvfb and WSLg as options. agent-utils has several display-dependent extensions
(tendril-share capture, android emulator screenshots, app-automation browser,
kitty/pi-graphics) but no headless/DISPLAY awareness, so on headless Linux/WSL
nodes they fail silently. The goal was a bounded, valuable first slice: a
reusable helper that detects display availability and returns an actionable
Xvfb/WSLg remediation hint, so diagnostics can guide operators instead of
dead-ending.

## Bead(s)

- `bd-44d94e` — Headless-node display detection helper (Xvfb/WSLg awareness) for display-dependent extensions
- Follow-up drafts filed: `bd-ad742d` (wire detection into tendril/android/app-automation diagnostics), `bd-a0e836` (optional opt-in auto-Xvfb spawn)

## Before state

- Failing tests: none
- No DISPLAY/XVFB/WAYLAND_DISPLAY/WSLg awareness anywhere in extensions/ (grep returned nothing).
- Display-dependent tools fail silently on headless nodes.

## After state

- Failing tests: none (full suite green at 472)
- New pure helper extensions/lib/headless-display.js: detectHeadlessDisplay({env,platform}) -> { kind: native-display|wslg|headless-no-display, hasDisplay, display, waylandDisplay, isWslg, hint } plus headlessDisplaySummary() one-liner.
- 10 unit tests across env permutations (macOS/win always-display, linux DISPLAY, native wayland, WSLg via /mnt/wslg or WSL markers, headless Xvfb hint, whitespace DISPLAY).

## Diff summary

- Code/content commit: 776d5c3 (final landed squash SHA from reintegration receipt)
- Files touched: extensions/lib/headless-display.js (new), test/headless-display.test.js (new)
- Tests: +10; suite green at 472
- Behavioural delta: adds a tested foundation for headless-display awareness. Does NOT spawn Xvfb or mutate env — orchestration and diagnostic wiring are deliberately deferred to the follow-up drafts to keep this slice bounded and low-risk.

## Operator-takeaway

The headless-node gap was real: nothing in agent-utils knew whether a display
existed, so capture/screenshot/browser tools just failed on headless Linux/WSL.
This slice lands the detection + remediation-hint primitive (native vs WSLg vs
headless, with an Xvfb command to copy-paste). The next steps — surfacing it in
tendril/android/app-automation doctor output, and an opt-in auto-Xvfb spawn —
are filed as drafts bd-ad742d and bd-a0e836 so the capability can grow
incrementally without one big risky change.
