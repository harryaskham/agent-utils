# Session summary — pi-wasm S14 (increment 4a): real v86 microVM boots + runs shell in-browser

## Goal

S14 (bd-c6ffc3). inc1–3 landed the feasibility spike + tested MicrovmExecBackend
+ serial exec protocol (validated only against a MOCK guest). This increment
lands the **real v86 adapter** and proves the whole path against a REAL Linux
guest booting entirely in the browser. Bead stays **in_progress** (4b = the 9p
`/work` bridge is the last piece).

## Bead(s)

- `bd-c6ffc3` — pi-wasm S14 microVM exec backend (kept **in_progress**).

## Before / after

- Before: MicrovmExecBackend had only a mock `MicrovmMachine`; no real engine.
- After: `V86Machine` (`src/exec/v86-machine.ts`) implements the seam over
  copy/v86 (dynamic import → stays Node/vitest-safe) via `serial0_send` /
  `add_listener("serial0-output-byte")`; boots a vendored Buildroot bzimage with
  `filesystem:{}` (empty 9p — 4b adds `handle9p`) and a printf-arg readiness
  probe. Demo page `/microvm-demo.html` + `src/microvm-demo.ts` expose
  `window.__PI_WASM_MICROVM__ = { ready, exec, seedWorkFile, env }` +
  `#microvm-app[data-microvm-ready]`. E2E `e2e/microvm.spec.ts` (opt-in via
  `PIWASM_E2E_MICROVM=1`, uses msm-1's S8b harness page pattern) boots real v86
  and asserts `echo` stdout, `ls /no/such/path` stderr-separation + non-zero exit,
  and `uname -s`→Linux.

## Validation (all green)

- **Real-v86 E2E PASSED (3.6s)** in headless system-Chrome: v86 booted, ran three
  commands through the inc2/inc3 serial protocol — validating that protocol
  (incl. the inc3 stdout/stderr separation) against REAL v86, not just the mock.
- `tsc --noEmit` clean; vitest suite **149 green** (v86-machine not imported by
  unit tests). vite build bundles libv86 (349KB chunk). `nix build .#pi-wasm`
  succeeds with the updated `npmDepsHash` (recomputed via prefetch-npm-deps;
  needed `--fallback` locally only because the cluster binary caches were down).

## Diff summary

- New: `src/exec/v86-machine.ts`, `src/exec/v86-module.d.ts`, `src/microvm-demo.ts`,
  `microvm-demo.html`, `e2e/microvm.spec.ts`, `scripts/fetch-microvm-assets.mjs`.
- Modified: `vite.config.ts` (+microvm-demo entry), `.gitignore` (+public/microvm/),
  `package.json` (+v86 dep, +fetch:microvm script), `package-lock.json`,
  `flake.nix` (npmDepsHash bump), `src/exec/MICROVM.md`.
- Guest assets (~12MB: v86.wasm + buildroot bzimage + SeaBIOS/VGA BIOS) are
  **gitignored**, fetched on demand (pinned by size + sha256).

## Operator-takeaway

The in-browser agent now has a REAL Linux microVM exec backend: v86 boots a
Buildroot guest in the tab and runs actual bash/coreutils, proven by a passing
Playwright E2E. This is the milestone Harry flagged as a must-have. No interface
change — it plugs behind the landed `ExecBackend`/`MicrovmMachine` seam. The last
S14 piece (4b) is the `handle9p` 9p bridge sharing our IndexedDB VFS into the
guest so `cat /work/<f>` sees a tool-written file; the seam + demo hooks
(`seedWorkFile`, `env`) are already in place for it. Coordinated with msm-1 (S8/S8b
harness) throughout.
