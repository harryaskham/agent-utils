# Session summary — Generic checkout-behind-default-branch warning Pi extension (bd-27072e)

## Goal

Restore, in a generic and reusable form, the safety net that Cacophony's
git-check mixin used to provide: nudge an agent to rebase when its checkout has
fallen significantly behind the shared default branch. That nudge was lost when
managed Pi moved to the pi-home-override path. This session built a new
agent-utils Pi extension that warns ANY Pi agent — managed or not — when its
checkout is significantly behind the origin default branch, decoupled from
daemon-checkout specifics so it works in any git repository.

## Bead(s)

- `bd-27072e` — Generic checkout-behind-default-branch warning guard
  (async/throttled Pi extension with settings) [feature, P2]

## Before state

- Failing tests: none.
- agent-utils test suite: 560 `node --test` tests passing.
- No git-freshness/behind-warning surface existed in the agent-utils package;
  the only prior art was Cacophony's daemon-coupled git-check mixin, which
  managed Pi no longer loads.

## After state

- Failing tests: none.
- agent-utils test suite: 595 `node --test` tests passing (+35), plus
  `npm run docs:check` clean.
- New `git-behind-warning` Pi extension is registered in `package.json` and
  documented in the README. A real-repo integration check against this very
  checkout auto-detected `main` via `origin/HEAD` symbolic-ref, fetched, and
  correctly reported the live behind-count.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - `extensions/lib/git-behind.js` (new) — pure, injected-probe logic: config
    resolution (env > settings.json > defaults), default-branch detection
    (symbolic-ref → abbrev-ref → main/master probe → explicit override),
    behind-count parsing, fetch-cache + warn-cooldown + turn-cadence throttle
    decisions, the `runGitBehindCheck` orchestrator, a non-throwing real
    `makeGitRunner`, and message/summary formatting.
  - `extensions/git-behind-warning.js` (new) — thin wiring: fire-and-forget
    checks on `tool_call` (bash `git ...` pre-git hook) and `turn_end` cadence,
    advisory surfacing via status line + UI notification + a throttled
    non-interrupting follow-up rebase nudge, and a `/git-behind`
    [status|check|on|off|reload] command. Settings loaded from global + project
    `settings.json` under `agentUtils.gitBehindWarning`.
  - `test/git-behind-warning.test.js` (new) — 35 unit tests over the pure logic
    (config precedence, branch detection, every status path, fetch caching,
    warn cooldown, fetch-failure fallback, the real runner's ENOENT/exit
    mapping) and the extension wiring (trigger gating, surfacing, nudge toggle,
    command).
  - `package.json` — registers `./extensions/git-behind-warning.js`.
  - `README.md` — feature bullet + a "Checkout-behind warning Pi extension"
    section with the full config table.
- Tests: +35 / -0 / flipped 0.
- Behavioural delta: agents on any git checkout now get an async, throttled,
  graceful-on-failure advisory (with a rebase nudge) once they drift past a
  configurable threshold behind the origin default branch. Never blocks a tool
  call; never a hard error.

## Operator-takeaway

The behind-warning is intentionally advisory and heavily throttled (cached
fetches, warn cooldown, turn cadence) so it informs without nagging. It is fully
configurable per-agent via `AGENT_UTILS_GIT_BEHIND_*` env vars or
`settings.json` `agentUtils.gitBehindWarning`, and disabled cleanly with
`AGENT_UTILS_GIT_BEHIND_WARNING=0`. Defaults: warn at 25 commits behind, check
at most every 10 turns, 10-minute warn cooldown, 3-minute fetch cache. If we
later want this to actively rebase managed agents rather than just nudge, that
is a deliberate follow-up — this slice stays advisory by design.
