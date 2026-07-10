# Session summary — pi-wasm S14 (increment 3): real stderr capture in the microVM backend

## Goal

S14 (bd-c6ffc3, epic bd-f76cee). inc1 landed the feasibility spike (recommend
v86); inc2 landed the tested MicrovmExecBackend + serial protocol but returned
`stderr=""` (a v1 shortcut). This increment completes the `ExecResult`
contract by capturing **real stderr**, separated from stdout — testable now
against the mock guest. Bead stays **in_progress** (real v86 adapter still gated
on the S8 harness + guest image).

## Bead(s)

- `bd-c6ffc3` — pi-wasm S14 microVM exec backend (kept **in_progress**).

## Before state

- `MicrovmExecBackend.exec()` returned `stderr: ""` — all command stderr was
  lost. Serial protocol used 2 markers (BEGIN/END). Suite: 100 tests.

## After state

- Failing tests: none. Full suite **101 passed** (+1); `tsc --noEmit` clean.
- Serial protocol upgraded to a **3-marker OUT/ERR/END scheme** with temp-file
  stderr replay: the command's stderr is redirected to `/tmp/.piwasm_err_<token>`
  and replayed between the ERR and END markers, so stdout (OUT→ERR) and stderr
  (ERR→END) are cleanly SEPARATED (matching Shell/Node exec semantics). Markers
  still carry the token as a printf argument (echo/prompt-robust).
- `parseSerialResult` now returns `{ stdout, stderr, exitCode, consumedTo }`;
  `exec()` returns the real `stderr` and streams it via `onStderr`. Exports:
  `OUT_RE`/`ERR_RE`/`END_RE` (replacing `BEGIN_RE`), updated in `src/exec/index.ts`.
- Tests: mock guest emits the 3-marker sequence; added a "separate stdout/stderr
  streams" case + `onStderr` streaming assertion (17→18 microvm tests).
- `src/exec/MICROVM.md` updated: documents the OUT/ERR/END framing and replaces
  the old `stderr=""` limitation with the (accurate) separated-streams note.

## Diff summary

- Files: `src/exec/microvm-backend.ts` (frameCommand/parseSerialResult/runOne),
  `src/exec/index.ts` (regex exports), `test/microvm-backend.test.ts` (+stderr),
  `src/exec/MICROVM.md` (docs).
- Tests: +1 (100→101), all green; typecheck clean.
- **No interface change** — still implements the landed `ExecBackend`; ms2-0's
  `createExecBackend` registry wiring (135/135) is unaffected (confirmed with ms2-0).

## Operator-takeaway

The microVM backend now returns real, separated stdout **and** stderr with the
exit code — completing the exec() contract so agent bash errors/diagnostics
surface instead of being dropped. Still no interface change; the only remaining
S14 piece is the real v86 `MicrovmMachine` adapter + a Buildroot guest image + 9p
bridge, which is gated on the S8 Playwright harness (ms2-0 will take S8 when S7
lands and design a scenario seam my v86 case drops into — coordinated this
session). Coordination cleaned up a false "take S14" hand-off; S14 is entirely
mine and no one is duplicating it.
