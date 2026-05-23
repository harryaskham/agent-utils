# Session summary — Realtime quick-start configs

## Goal

Document copy/paste quick-start configurations for the realtime Pi extension so operators can get Pulse/phone routing or local audio backends working without reverse-engineering the longer reference guide.

## Bead(s)

- `bd-d574ff` — Realtime: add quick-start configs for Pulse and local backends

## Before state

- Failing tests: none known.
- Relevant metrics: `docs/realtime-agent.md` described Pulse defaults and backend overrides, but did not have a compact quick-start section with expected device behavior and `/rt-doctor` validation steps.
- Context: The bead requested known-good Pulse and local backend examples plus a pointer to `/rt-doctor`.

## After state

- Failing tests: none observed.
- Relevant metrics: `npm run docs:check` passed; `git diff --check` passed.
- Context: The realtime guide now has a `Quick-start configs` section for Pulse/phone routing, local macOS CoreAudio/AudioToolbox testing, and local sox/ffplay fallback, each with expected behavior and diagnostics guidance.

## Diff summary

- Code/content commits: `398c8d8`.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files touched: `docs/realtime-agent.md`.
- Tests: +0 / -0 / flipped 0; documentation validation passed.
- Behavioural delta: No runtime behavior changed; operators now have clearer realtime setup examples.

## Operator-takeaway

Realtime setup now has a short operator-facing path: choose Pulse for the normal phone/remote route, CoreAudio for local Mac tests, or sox/ffplay as a fallback, then verify with `/rt-doctor` before starting audio.
