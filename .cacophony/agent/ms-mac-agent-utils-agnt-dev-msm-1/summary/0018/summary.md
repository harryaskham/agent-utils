# Session summary — pi-wasm S8d: per-session exec-backend persistence coverage (S11.1)

## Goal

Lock aurora's S11.1 (per-session exec-backend selection) into CI. S11.1 added
`__PI_WASM_SESSIONS__.setBackend(id, backendId)` + a switcher dropdown, validated
by aurora with a one-off CDP check. As harness owner I added a durable Playwright
tier proving, in a real headless browser with no key, that selecting the JS-shell
backend gives a session a working `bash`/`exec` over the VFS, that the choice
persists across reload, and that `none` cleanly removes it.

## Bead(s)

- `bd-4dc11d` — pi-wasm S8d: exec-backend-persistence E2E tier.
- exercises `bd-36c379` (S11.1, aurora); builds on `bd-23ab90` (S8c) +
  `bd-caa275` (S8b seam). Parent epic `bd-f76cee`.

## Before state

- S11.1 (bd-36c379) landed (035207a): `setBackend(id, backendId)` selects one of
  the S13 exec backends (`none`/`js-shell`/`remote`/`microvm`) per session,
  persisted in IndexedDB; `js-shell` is dep-free (coreutils over the VFS).
  Validated by aurora over CDP — no landed automated test.
- e2e: 5 passing; vitest 156/156.

## After state

- `e2e/s8d-exec-backend.spec.ts` (new, no key → bare gate): on the active
  session, `setBackend("js-shell")` → the agent gains a `bash` tool and
  `__PI_WASM__.env.exec("echo hi")` returns `{ ok:true, value:{ stdout:"hi\n" } }`;
  **reload** → js-shell + bash persist and exec still works; `setBackend("none")`
  → bash removed and exec returns a `shell_unavailable` error.
- Harness seam (`e2e/harness.ts`) extended with `currentSessionId`,
  `setSessionBackend`, `execInSession`, `sessionToolNames` (+ the
  `__PI_WASM__.env.exec` / `session.agent.state.tools` / `setBackend` types).
- `npm run test:e2e` = 6 passed; vitest 156/156; typecheck clean. Surface-only.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - `pi-wasm/e2e/s8d-exec-backend.spec.ts` (new) — the backend-persistence tier.
  - `pi-wasm/e2e/harness.ts` — exec/backend helpers + types.
- Tests: +1 e2e tier (6 total). vitest/typecheck unaffected.
- Behavioural delta: none for product code; S11.1's per-session backend
  selection + persistence is now a landed CI assertion.

## Operator-takeaway

Every user-facing pillar of the in-browser agent is now regression-proof by
automated browser testing: streaming (S3/S8), tool→VFS loop (S8), keyed sessions
that survive reload (S8c), and now per-session exec-backend selection — pick the
in-browser JS shell, run `echo hi`, reload, and it's still there. The harness
seam (`e2e/harness.ts`) has grown into the fleet's shared browser-E2E substrate;
S14 (v86) and S15 (remote) drop their exec backends onto the same `exec` seam
this tier exercises. Tight aurora collaboration again: she exposed the hook and
confirmed the exact contract, I turned it into landed CI within the session.
