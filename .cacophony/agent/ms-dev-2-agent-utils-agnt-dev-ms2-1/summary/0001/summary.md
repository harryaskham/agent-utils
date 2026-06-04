# Summary — bd-28e9b4

## Goal
Collapse the inline Tendril source-machine resolver in tendril-share.js onto the
shared `tendrilSourceMachine()` helper so there is one source of truth for "which
machine produced this capture".

## Bead(s)
- bd-28e9b4 — Dedupe Tendril source-machine resolver to shared
  tendrilSourceMachine helper. P3 task. Pulled from the draft backlog per Harry's
  "keep improving the project" directive.
- bd-ac2045 — closed as an exact duplicate of bd-28e9b4 (both filed by
  reflect-session from the bd-a4f693 session ~90 min apart).

## Before state
- `extensions/tendril-command.js` exported a shared
  `tendrilSourceMachine(env, overrides)` returning
  `{ machine, remote, isRemote, wslTunnel, source }`.
- `extensions/tendril-share.js` kept its own inline
  `resolveSourceMachine(override, env)` that re-derived the bridge identity via
  `tendrilBridgeConfig()` and returned a different shape
  `{ host, remote (boolean), source }`. Two parallel resolvers for the same
  concept (landed independently to stay reintegrable during a beads outage:
  bd-a4f693 + bd-668a82).

## After state
- `resolveSourceMachine()` now delegates resolution to the shared
  `tendrilSourceMachine()` and adapts the result to the
  `{ host, remote, source }` shape the tendril-share call sites and tests expect
  (`host = machine` when remote else "local"; `remote = isRemote`;
  `source = source`). One source of truth for the actual bridge resolution.
- No behavior change: every tendril-share call site (`sourceMachineLabel`,
  capture-history suffix, "Source machine:" context line, artifact filename
  namespacing, describe inference attribution) sees the identical shape and
  values as before.
- `tendrilBridgeConfig` import retained: still re-exported on the
  `__tendrilShareTest` surface (out of scope to prune here).

## Diff summary
- `extensions/tendril-share.js` (~+15/-6): import `tendrilSourceMachine`; rewrite
  inline `resolveSourceMachine` to delegate + shape-adapt; doc comment.
- No test changes required — the existing
  `resolveSourceMachine derives source machine ...` and
  `tendril_describe associates inference result ...` assertions already pin the
  `{host, remote, source}` contract and still pass.

## Validation
- `node --test`: 516 pass / 0 fail.
- Targeted `test/tendril-share.test.js` + `test/tendril-command.test.js`: 32 pass
  / 0 fail, including the source-machine shape assertions and the concurrent
  remote-capture disambiguation test.
- `node --check` clean.

## Operator-takeaway
There is now a single Tendril source-machine resolver
(`tendrilSourceMachine` in tendril-command.js); tendril-share.js delegates to it
behind a thin shape adapter, so adding a new bridge-identity field only needs one
edit. Pure refactor, no behavior change, all tests green. Also closed the
duplicate bead bd-ac2045. (The sibling tool-result-builder cleanup bd-e8a473 /
its own duplicate bd-5d65ef remain open as separate follow-ups.)
