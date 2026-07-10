# Session summary — pi-wasm S8b: pluggable scenario seam for the browser-E2E harness

## Goal

Extract the reusable pieces of the S8 Playwright harness into an importable
module so downstream exec-backend E2E specs (S14 v86 microVM, S15 remote relay)
can drop a scenario into the SAME harness instead of duplicating it. Requested
by msm-2 (S14), whose v86 browser validation needs the harness primitives.

## Bead(s)

- `bd-caa275` — pi-wasm S8b: extract pluggable scenario seam from the S8 harness
  (importable e2e helpers for exec-backend validation — unblocks S14/S15).
- follow-on from `bd-759769` (S8, landed 53466c9); parent epic `bd-f76cee`.

## Before state

- The S8 harness (`e2e/s8-full-loop.spec.ts`) + `e2e/s3-provider.spec.ts` had
  their helpers inline (seed-live-settings, wait-ready, VFS file assertion).
- Nothing importable for S14/S15 to reuse; `waitReady` was hard-coded to the
  chat app's `#app[data-pi-wasm-ready]` selector.
- e2e: 4 passing; vitest 149/149.

## After state

- `e2e/harness.ts` exports the reusable seam: `resolveKey`, `DEFAULT_MODEL`/
  `DEFAULT_BASE_URL`, `READY_SELECTOR`, `waitReady(page, selector?)` (now
  parameterizable), `gotoReady(page, path?, selector?)`, `seedLiveSettings`,
  `sendPrompt`, `getTranscript`, `assertVfsFile`, `expectAssistantReply`, and the
  pluggable `runToolLoopScenario(page, { prompt, assert | assertFile })`, plus the
  `PiWasmGlobals` window type.
- `s8-full-loop.spec.ts` + `s3-provider.spec.ts` refactored to consume it (no
  behavior change). `npm run test:e2e` = 4 passed; vitest 149/149; typecheck clean.
- Seam shaped to msm-2's answers: their v86 case is a no-key, separate-page
  (`/microvm-demo.html`, `#microvm-app[data-microvm-ready]`) direct exec round-trip
  — so `waitReady`/`gotoReady` take a selector, `assertVfsFile` is the sanity
  pre-check, and they assert the guest `bash -c 'cat /work/<f>'` themselves.
- README documents the seam for downstream authors.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - `pi-wasm/e2e/harness.ts` (new) — the reusable seam.
  - `pi-wasm/e2e/s8-full-loop.spec.ts` — refactored to import the seam.
  - `pi-wasm/e2e/s3-provider.spec.ts` — shares `resolveKey`/`DEFAULT_MODEL`.
  - `pi-wasm/README.md` — reusable-seam note in the S8 section.
- Tests: no new tests; existing 4 e2e stay green (behavior-preserving refactor).
- Behavioural delta: none for the tests; S14/S15 authors can now import the
  harness primitives.

## Operator-takeaway

The browser-E2E harness is now a shared substrate, not a one-off: S14 (v86
microVM) and S15 (remote relay) import `e2e/harness.ts` and add their own entry
page + assertion, instead of re-writing build/serve/nav/wait/seed. Concretely
unblocks msm-2's v86 validation — they wait on `#microvm-app[data-microvm-ready]`
via the parameterized `waitReady`, seed a file via the shared VFS, and assert the
guest `cat /work/<f>` sees it through the 9p bridge.
