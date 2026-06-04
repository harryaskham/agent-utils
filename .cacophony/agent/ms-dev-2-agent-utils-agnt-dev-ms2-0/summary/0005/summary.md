# Session summary — document Pi extension capability boundaries

## Goal

Implement bd-37d77d: write a short, accurate "Pi extension capability
boundaries" note so future agent-utils extension authors don't have to
reverse-engineer (a) which builtin slash commands an extension can intercept
and (b) where extension `ctx` is unavailable.

## Bead(s)

- `bd-37d77d` — Document Pi extension interception boundaries (input event vs
  TUI-consumed builtins; completions have no ctx) (promoted draft -> open,
  claimed). P3 task, oracle 2/5 complexity, 2/5 risk.

## Before state

- Two boundaries were only discoverable by spelunking the Pi runtime in
  `node_modules`:
  1. Extensions cannot override a builtin slash command (`/model`) — the TUI
     submit handler consumes it before the extension `input` event fires; this is
     why `extensions/m.js` registers `/m` instead.
  2. `getArgumentCompletions(prefix)` gets no `ctx`, so the model registry must be
     captured at `session_start` and closed over.
- Neither was documented in the README or any docs page, though `extensions/m.js`
  already documents the completions/session_start pattern *in code comments*.

## After state

- New `docs/extension-capability-boundaries.md` covering both boundaries, with a
  summary table of which surfaces get `ctx` (`execute` yes, `getArgumentCompletions`
  no, `session_start` yes) and the builtin-interception rule. Verifiable claims
  are anchored to `extensions/m.js`; the slash-command interception boundary is
  framed as observed Pi TUI behavior with a "verify against current Pi runtime"
  caveat (since no in-repo extension currently uses `pi.on("input", ...)` to
  demonstrate it).
- README pointer added in the "Cacophony workflow notes" section next to the
  existing extension-tool-schemas pointer.

## Diff summary

- Final landed squash SHA: from the reintegration receipt.
- Files touched:
  - `docs/extension-capability-boundaries.md` (NEW, ~78 lines)
  - `README.md` (+2 lines: pointer paragraph)
- Docs-only. No `tools.json` change needed (those `.md` references are
  `sourceOfTruth` annotations, not a docs-page registry; `docs:check` validates
  `tools.json` -> `index.html` only). `docs:check` clean; full suite 529 pass
  (no test asserts on README/docs content).

## Operator-takeaway

Future extension authors now have a one-page reference for the two non-obvious
Pi extension boundaries (can't override builtins via `input`; completions are
ctx-less so capture state at `session_start`). Reflection-draft step skipped per
mixin guidance for a trivial docs-only change (narrated skip); no follow-up
needed. The slash-command boundary section carries a caveat to re-verify against
Pi core before relying on it for a new builtin, since it reflects observed TUI
behavior rather than an in-repo demonstrated seam.
