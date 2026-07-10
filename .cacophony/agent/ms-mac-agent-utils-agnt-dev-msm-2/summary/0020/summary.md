# Session summary — pi-wasm S14 (increment 2): microVM exec backend + serial protocol

## Goal

S14 (bd-c6ffc3, epic bd-f76cee): the miniscule microVM-in-wasm `exec()` backend.
Increment 1 landed the feasibility spike (recommend v86). This increment lands
the **testable core**: the `MicrovmExecBackend` (implementing the landed
`ExecBackend` seam) + the v86-agnostic serial-console exec protocol, fully
unit-tested with a mock guest. The real v86 machine adapter (boot a Buildroot
image + 9p↔VFS bridge) is the next increment; bead stays **in_progress**.

## Bead(s)

- `bd-c6ffc3` — pi-wasm S14 microVM exec backend (kept **in_progress**).

## Before state

- `src/exec/` had `ExecBackend` (S13a), `NullExecBackend`, and the `remote` tier
  (`RelayExecBackend`, S15). No microVM tier. pi-wasm test suite: 83 tests green.

## After state

- Failing tests: none. Full suite **100 passed** (was 83; +17 microvm tests); `tsc --noEmit` clean.
- New `src/exec/microvm-backend.ts`:
  - `MicrovmMachine` seam (boot + serial duplex), mirroring the relay tier's `RelayTransport` so the backend is unit-testable without v86.
  - `frameCommand` / `parseSerialResult` (exported, pure): frame a command with BEGIN/END markers whose unique token is a printf **argument**, so the markers appear only in command OUTPUT (never in console echo) — robust stdout/exit-code extraction.
  - `MicrovmExecBackend implements ExecBackend` (id="microvm"): lazy boot, per-call serialization (shared serial line), `abortSignal` (Ctrl-C), `timeout`, `onStdout` streaming; never throws — maps to `ExecutionError` (shell_unavailable/aborted/timeout/spawn_error).
  - `createMicrovmExecBackend` factory; exported from `src/exec/index.ts`.
- New `test/microvm-backend.test.ts` (17 tests): pure framing/parsing (incl. echo-stripping, CRLF, quoting), plus backend behavior — ok/exit-code, streaming, unavailable, abort-before/mid (Ctrl-C, race-closed), timeout, call serialization, lazy-boot idempotency + boot-failure retry, dispose, never-throws.
- New `src/exec/MICROVM.md` documenting the seam/protocol + v1 limits (stderr="" for now) + next increments.

## Diff summary

- Files: `src/exec/microvm-backend.ts` (new), `test/microvm-backend.test.ts` (new), `src/exec/MICROVM.md` (new), `src/exec/index.ts` (+exports).
- Tests: **+17** (83→100), all green; typecheck clean.
- Behavioural delta: the microVM tier now exists as a selectable `ExecBackend`; the serial exec contract is locked by tests. No runtime wiring change to the Agent loop / default tool set.

## Operator-takeaway

The microVM backend is real and tested up to the machine boundary: command
framing, echo-robust stdout/exit-code parsing, serialized concurrency,
abort/timeout, and never-throw are all unit-covered against a mock guest. What
remains is the v86 `MicrovmMachine` adapter — boot a vendored minimal Buildroot
image and bridge `/work` to the S2 IndexedDB VFS via a 9p handler — after which
`bash -c 'cat /work/<file>'` should see files the S4 tools wrote. Consistent with
the S15 relay tier's shape; coordinated with S13a (ms2-0) and the S2 VFS (ms2-2).
