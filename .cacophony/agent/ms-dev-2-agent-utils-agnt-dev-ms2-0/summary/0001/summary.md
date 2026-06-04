# Session summary — transmit-once + placement-only-on-repaint for kitty image preview

## Goal

Implement bd-d6fa1b (P2 feature, complexity 5/5): decouple image transmission
from placement in the kitty image preview's unicode-placeholder path so the
base64 PNG payload is uploaded once per render signature instead of on every
repaint. This fixes wasteful SSH bandwidth and the tmux-over-SSH failure where
an image emitted before a kitty client attaches is lost (tmux stores text cells,
not graphics).

## Bead(s)

- `bd-d6fa1b` — kitty image preview: transmit-once + placement-only-on-repaint
  retransmission guard (with reattach re-transmit). Follow-up to bd-9b5b18
  (landed by peer ms2-2 at commit 3230057).

## Before state

- `buildCurrentDisplayCommand` (extensions/kitty-image-preview/display-commands.js)
  rebuilt the full `a=T` virtual-placement upload — including the base64 PNG —
  on every repaint in unicode mode. The `rendered` memo only cached the escape
  string; Pi still wrote the whole payload each frame.
- Consequences: re-sent the PNG per repaint over SSH; under tmux passthrough,
  payloads emitted before a kitty client attached were dropped, leaving
  unresolved placeholder cells on later local attach.
- Failing tests: none (this was a feature/perf-correctness gap, not a crash).

## After state

- Unicode mode now transmits the payload exactly once per (image id + signature)
  via a `state.transmittedSignatures` guard; repaints at the same signature emit
  an empty command prefix while the placeholder cells (emitted every frame) carry
  the placement.
- Re-transmit triggers: new signature (id/transport/geometry/config), content or
  transport change (prepareCurrentImage drops the stale per-image guard entry),
  and `session_start` fresh attach/restore (resetTransmissionGuard clears the
  guard so a new terminal re-receives the payload).
- Cursor (non-virtual) mode is unchanged.
- Failing tests: none. Full suite 499 pass (was 493 + my 6 new), docs check
  clean, pi-graphics/tmux/animation smokes green.

## Diff summary

- Final landed squash SHA: provided by the reintegration receipt (agent commit
  3702971 pre-squash).
- Files touched:
  - `extensions/kitty-image-preview/display-commands.js` (+guard, transmit-once
    logic, `resetTransmissionGuard` export)
  - `extensions/kitty-image-preview.js` (wire reset on `session_start`; drop
    stale per-image guard entry in `prepareCurrentImage`)
  - `test/kitty-display-commands.test.js` (new; 6 tests)
- Tests: +6 / -0 / flipped 0.
- Behavioural delta: steady-state repaint bandwidth in unicode mode drops to
  placement-only; a simulated reattach re-uploads so the image reappears.

## Operator-takeaway

The deeper tmux-over-SSH fix Harry and ms2-2 discussed is in: the image preview
no longer re-uploads unchanged images on every repaint, and it re-transmits on a
fresh terminal attach so images survive attach-after-emit. The pattern mirrors
the existing pi-graphics/runtime transmit-once guard, keeping the two graphics
paths consistent. No follow-up required; if a more end-to-end widget-level tmux
smoke for the preview path (vs. the pi-graphics path) is wanted, that could be a
small future bead.
