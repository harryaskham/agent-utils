# Session summary — Pi graphics live visibility probe

## Goal

Harry still could not see Pi graphics differences. Now that the extension import failure was fixed, this slice adds an explicit live probe command/tool so the next invisible state can be diagnosed inside the live Pi runtime rather than inferred from package files.

## Bead(s)

- `bd-a1a29a` — Add Pi graphics live visibility probe command

## Before state

- Failing tests: none at start of this slice.
- Relevant metrics: installed package at `e3ee639`; direct import of installed `pi-graphics.js` succeeded after the loadability fix.
- Context: there were many visibility surfaces, but no single command that reported which Pi UI APIs exist in the current runtime while also re-emitting every calm-mode visible proof.

## After state

- Failing tests: none in targeted validation.
- Relevant metrics: `npm test -- test/pi-graphics.test.js test/kitty-graphics.test.js` passes 86/86.
- Context: added `pi_graphics_live_probe` and `/pi-graphics-live-probe`. The probe emits raw bootstrap, reapplies theme/header/footer/editor/status/ambient surfaces, and returns package version, configured theme/mode, reload sentinel, UI API availability (`setHeader`, `setWidget`, `setEditorComponent`, `notify`, etc.), settings-derived flags, theme sync counts, Unicode placement status, and whether emission succeeded.

## Diff summary

- Code/content commits: `9c3dde6`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched: `extensions/pi-graphics.js`, `test/pi-graphics.test.js`, `docs/pi-graphics.md`
- Tests: added source assertions for `buildLiveProbeText`, `emitLiveProbe`, live-probe tool/command registration, package version reporting, UI API diagnostics, and raw bootstrap invocation.
- Behavioural delta: the operator can now run one explicit probe after reload to prove whether the extension is loaded and which Pi UI surfaces are available.
- Validation: syntax check, targeted tests, and `git diff --check` passed.

## Operator-takeaway

If `/pi-graphics-live-probe` is available and visible, the extension is loaded and its report will identify missing UI APIs or disabled flags. If the command/tool is absent, the live Pi process still has not loaded the updated package.
