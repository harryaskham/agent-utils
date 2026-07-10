# Session summary — pi-wasm S14 (increment 1): microVM exec backend feasibility

## Goal

S14 (bd-c6ffc3, epic bd-f76cee): a miniscule Linux microVM-in-wasm `exec()`
backend for the in-browser Pi agent (Harry: "definitely have a version able to
run a full miniscule microvm backend"). This increment = the feasibility SPIKE
(evaluate v86 / CheerpX-WebVM / container2wasm; recommend the smallest viable, or
a documented negative). The BUILD remains (bead stays in_progress).

## Bead(s)

- `bd-c6ffc3` — pi-wasm S14: miniscule Linux microVM-in-wasm exec backend (kept **in_progress**; this lands the spike, build increment follows).

## Before state

- Failing tests: none.
- The exec seam had landed (`ExecBackend` interface, S13a bd-4d085a; `BrowserExecutionEnv.setExecBackend()`, S2 bd-56130e) with only `NullExecBackend`; the `microvm` tier was an unstarted bullet with no design/feasibility analysis.

## After state

- Failing tests: none (doc-only increment; no code/build change).
- New `pi-wasm/MICROVM-FEASIBILITY.md`: grounded 2026 comparison of v86 / CheerpX / container2wasm across bundle size, boot, license, exec() shape, IndexedDB-VFS bridge, and networking; a recommendation (**v86** — smallest viable ~2.3 MB core + Buildroot image, BSD-2/self-hostable, and the only candidate that can *share* our `LightningFsVfs` via a `handle9p` 9p handler); documented negatives for the default tier (CheerpX = proprietary/commercial runtime + can't share our VFS; container2wasm = 78–200 MB embedded rootfs); and a concrete build architecture (lazy `MicrovmExecBackend`, 9p↔`Vfs` bridge, serial-console exec with an exit-code sentinel, `relay_url` networking pairing with S15).
- `src/exec/README.md` S14 bullet cross-links the feasibility doc.

## Diff summary

- Files: `pi-wasm/MICROVM-FEASIBILITY.md` (new), `pi-wasm/src/exec/README.md` (+cross-link).
- Tests: +0 / -0 (spike/doc increment).
- Behavioural delta: none at runtime; establishes the S14 direction + build plan.

## Operator-takeaway

The miniscule microVM backend is viable — recommend **v86** (permissive,
self-hostable, ~2.3 MB, and it can genuinely share the in-browser IndexedDB VFS
via a 9p handler so the guest and the file tools see one tree). CheerpX has the
nicest API but its runtime is proprietary/commercial and can't share our VFS;
container2wasm is too big. Next increment: implement `MicrovmExecBackend` (lazy
import) + the 9p↔`Vfs` bridge behind the already-landed `ExecBackend` seam, boot
a minimal Buildroot image, and prove `cat /work/<file>` sees a tool-written file.
Coordinated with S13a (ms2-0) and the S2 VFS owner (ms2-2).
