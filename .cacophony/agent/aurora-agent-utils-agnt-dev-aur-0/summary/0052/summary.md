# Session summary — document PI_RT_AZURE_API_VERSION=none (bd-8783c1)

## Goal

Close the doc-accuracy gap from bd-cb74b5: the omittable api-version fix was in the
code comment but not the user-facing Azure/direct mode docs.

## Bead(s)

- `bd-8783c1` — docs: document PI_RT_AZURE_API_VERSION=none (task; landed).

## Change

Added a paragraph to docs/realtime-agent.md Azure/direct mode: set
PI_RT_AZURE_API_VERSION=none (or empty/ga) to omit api-version for a GA-only proxy
(gpt-realtime-2 / "only available on the GA API"), then reconnect. npm run check
green. Pure docs.

## Diff summary

- Files: docs/realtime-agent.md (+1 paragraph).
- Tests: none (docs); docs:check green.
- Behavioural delta: none.

## Operator-takeaway

The realtime-2 fix is now discoverable in the user docs, not just the code.
