# Session summary — pi-wasm S11.1 per-session exec-backend selection

## Goal

Complete the per-session exec-backend story on top of S11 keyed multi-session:
let each keyed session choose its shell backend (none / js-shell / remote /
microvm) over ms2-0's landed S13 selection registry, persist that choice
in-browser, wire it on activate, and add the bash tool so a working backend
gives the agent a real in-browser shell.

## Bead(s)

- `bd-36c379` — pi-wasm S11.1: per-session exec-backend selection + bash wiring
  on the S13 registry (filed + owned by this agent; ownership blessed by ms2-0,
  the S13 registry author). Parent epic `bd-f76cee`; follows S11 (bd-0dc0bc).

## Before state

- Failing tests: none. S11 (bd-0dc0bc) on main gave keyed multi-session
  persistence, but every session used the default null exec backend — the bash
  tool was absent and `env.exec` returned `shell_unavailable`. The S13 registry
  (bd-6ebbf6, `createExecBackend`) was landed but not yet consumed per session.

## After state

- Failing tests: none. `npm run typecheck` clean; `npm run build` green (4 pages);
  a deterministic headless CDP check passes the S11.1 acceptance: default `none`
  (6 file tools, no bash, `exec`→shell_unavailable) → select `js-shell` (bash
  tool appears + `echo` runs for real over the session VFS) → **reload persists**
  the js-shell choice (bash still works) → `remote` without relay config returns
  a graceful notice + falls back to unavailable → back to `none` removes bash.
  S11 multi-session + S7/S8 regression checks still green.
- Each session persists a `backendId`; `SessionManager.activate()` narrows it
  defensively (vs IndexedDB junk), calls `createExecBackend(id,{env,relay})`,
  `env.setExecBackend(ok ? value : NullExecBackend)` surfacing the error as a
  session notice, and installs the bash tool when the backend is active. A shell
  dropdown on the active switcher row (and `__PI_WASM_SESSIONS__.setBackend`)
  drives it; the status line shows `shell:<id>`.

## Diff summary

- Files changed: `pi-wasm/src/sessions/registry.ts` (SessionMeta.backendId +
  update patch), `pi-wasm/src/sessions/session-manager.ts` (activate wiring +
  setBackend + ActiveSession.backendId/backendNotice), `pi-wasm/src/sessions/switcher-ui.ts`
  (per-session backend dropdown + change handler), `pi-wasm/src/main.ts`
  (`__PI_WASM_SESSIONS__.setBackend` + status shell indicator),
  `pi-wasm/index.html` (dropdown styles), `pi-wasm/README.md`.
- Tests: validated via typecheck + vite build + a dedicated S11.1 CDP check
  (backend select/persist/exec) + S11 and S7/S8 regression checks. No new unit
  tests (UI/wiring slice); msm-1's S8c harness covers the multi-session surface
  and can add a setBackend-persist tier.
- Behavioural delta: sessions can now run a real in-browser shell (js-shell
  coreutils over the VFS) per session, opt-in via the dropdown; default stays
  `none` so nothing changes unless selected.

## Embedded artefacts

- None. Runtime proof is the CDP check output (select→bash+exec→reload-persist→
  remote-graceful→none) captured in the session log.

## Operator-takeaway

Per-session shells are now a first-class choice: pick a backend from the shell
dropdown on any session and it sticks (persisted in IndexedDB) — `js-shell` turns
on a real in-browser shell (coreutils over that session's own files) so the agent
can actually run commands with no server, while `remote`/`microvm` are wired for
their tiers and degrade gracefully with a notice when unconfigured. It consumes
ms2-0's S13 registry exactly as designed (selection/persistence stays in the S11
layer) and is fully additive — the default `none` preserves prior behavior, and
msm-0's S12 shell reuse of `src/sessions` is unaffected (stable public API).
