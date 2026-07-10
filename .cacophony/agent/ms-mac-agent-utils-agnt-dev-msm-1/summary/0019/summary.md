# Session summary — pi-wasm broken-on-main fix: guard microvm-demo behind v86 presence

## Goal

Fix a P1 broken-on-main: `npm run build` (and the S9 nix build, the S8 Playwright
harness, and any fresh checkout / CI) failed with "Rolldown failed to resolve
import 'v86' from src/exec/v86-machine.ts". Restore the default pi-wasm build for
everyone without the opt-in v86 assets, without touching msm-2's active S14 code.

## Bead(s)

- `bd-c9f4d5` — [broken-on-main] pi-wasm default build fails: microvm-demo.html in
  vite input needs v86 (not installed on clean checkout) — S14/4a 9d9e4df.
- parent epic `bd-f76cee`.

## Before state

- S14/4a (9d9e4df, msm-2) added `microvm-demo.html` unconditionally to
  `pi-wasm/vite.config.ts` `build.rollupOptions.input`. Its entry
  (`src/microvm-demo.ts`) is the ONLY importer of `src/exec/v86-machine.ts`, which
  `import`s the optional `v86` module — gitignored/opt-in via
  `scripts/fetch-microvm-assets.mjs`. So the default build (v86 absent) failed.
- Confirmed broken on clean main (392bf0e), build exit 1. (Also independently
  reproduced + fix-approach endorsed by aurora, the vite.config author.)

## After state

- `pi-wasm/vite.config.ts` now includes `microvm-demo.html` in the build input
  ONLY when `node_modules/v86` exists (`existsSync(fileURLToPath(new URL(...)))`),
  so the default build skips the demo page when the opt-in assets aren't fetched,
  and still builds it when they are. Main app path never statically imports
  v86-machine, so excluding the demo page is sufficient.
- `npm run build` rc=0 (microvm-demo skipped); `npm run typecheck` clean;
  `npm run test:e2e` = 6 passed / 1 skipped (e2e/microvm.spec correctly opt-in
  skipped when PIWASM_E2E_MICROVM unset / v86 absent). Harness restored.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: `pi-wasm/vite.config.ts` (conditional microvm-demo input).
- Tests: none added; the fix un-breaks the whole e2e/build path.
- Behavioural delta: default build/nix/harness/CI work again on clean checkouts;
  microvm demo/test path unchanged when v86 assets are fetched.

## Operator-takeaway

A microVM demo page was made a mandatory build input while its heavy `v86`
dependency stayed opt-in, silently breaking every clean build (nix, harness, CI,
fresh checkouts) even though pi-wasm sits outside the root gate so it still
landed. The one-line guard (build the demo only when v86 is installed) is the
same optional pattern the other demo pages should follow. Cross-agent handling:
msm-2's code stayed untouched (heads-up sent), and aurora — the vite.config
author — independently converged on the identical fix, so it's low-risk.
