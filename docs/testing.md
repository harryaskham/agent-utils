# Testing conventions

How tests are written and run in `agent-utils`. The suite is deliberately
dependency-free and fast so every contributor (and every agent) can run it the
same way.

## Running

```bash
npm test                       # full JS suite (node:test)
npm run test:coverage          # suite + per-file line/branch/function coverage
npm run test:coverage:summary  # ranked report of the lowest-covered modules
npm run check                  # lint workflows + verify docs/index.html is in sync
cargo test                     # Rust crates (crates/mcp-cli, crates/skill-server)
```

The JS suite uses Node's built-in test runner (`node --test`) and
`node:assert/strict` — there is **no** external test framework, mock library, or
transpile step. Tests are plain ES modules under `test/*.test.js`, one file per
module or concern.

## What CI gates

`.github/workflows/ci.yml` runs `npm test`, `npm run check`, and the Rust suite on
every change — so a red test or an out-of-sync `docs/index.html` blocks the merge.
The coverage commands (`test:coverage`, `test:coverage:summary`) are **local
developer aids only**: they are not wired into CI and enforce no coverage
threshold, so they never gate a merge.

## Conventions

### 1. Extract pure logic into testable submodules

Extensions keep their hard-to-test surface (Pi `ctx`, live processes, the
terminal) thin and push real logic into pure submodules under
`extensions/<area>/` that both the extension and the tests import. For example
`extensions/pi-graphics/*.js`, `extensions/kitty-image-preview/*.js`, and
`extensions/app-automation/*.js` are imported directly by `test/*.test.js`. When
you add behaviour, put the logic in a pure function that takes its inputs as
arguments and returns a value, and unit-test that function.

### 2. Render-smoke tests for image output

Functions that produce PNG/APNG bytes are tested structurally — assert a valid
PNG signature and the IHDR width/height, never a visual diff. See
`test/affordances-smoke.test.js` for the `assertPng` helper:

```js
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// IHDR width/height are big-endian u32 at byte offsets 16 and 20.
```

This catches crashes and dimension/frame-count regressions without a live
terminal or any human judgement.

### 3. Make IO injectable

Functions that must touch the outside world accept their effects as parameters so
tests can pass fakes — e.g. `executePiRestartPlan(plan, { execve, spawnImpl, exit })`
in `extensions/pi-self-update.js`, or an injected `env` / `now` for determinism.

> **Gotcha:** a destructuring default (`{ execve = process.execve } = {}`) only
> applies when the property is `undefined`. To exercise a fallback path, pass
> `null` (or another non-`undefined` value), not `undefined` — otherwise the
> default silently runs the real effect.

### 4. Keep tests deterministic

Inject `now`/`Date` rather than reading the wall clock, and avoid locale- or
timezone-dependent output in assertions (`toLocaleTimeString()` differs across
environments — assert that a time portion is *present*, not its exact text).

## Coverage philosophy

Use `npm run test:coverage:summary` to find the lowest-covered modules
worst-first (it builds on Node's stable lcov output; `--threshold N` and `--all`
adjust the view). Then **verify, don't assume**: open the flagged module and check
whether the uncovered code is genuinely testable before dismissing it.

Aim to cover:

- **pure logic** — parsers, formatters, builders, math, serializers; and
- **injectable IO** — functions whose effects are passed in and can be faked.

The following are intentionally *not* unit-tested, because they need a harness,
mock, or live context that unit tests cannot provide cheaply:

- **ctx-coupled handlers** — code driven by a live Pi `ctx`/session (e.g. command
  handlers, `createRealtimeControls`);
- **subprocess IO** — functions that spawn real processes (`/bin/sh`, playback
  commands);
- **render pixel internals** — the inner pixel loops of the chrome renderers
  (the public render functions get render-smoke coverage instead).

A module sitting at high line coverage but low branch coverage usually has
untested optional/conditional paths; prefer one test that exercises a meaningful
*contract* (e.g. "the persisted manifest preserves every diagnostic field") over
mechanically toggling each branch.

## Adding tests for a new extension

1. Put the real logic in a pure function (new `extensions/<area>/<name>.js` or an
   exported helper) that takes inputs and returns a value.
2. Add `test/<name>.test.js` importing it; assert behaviour with
   `node:assert/strict`.
3. Run `npm test`, then `npm run test:coverage:summary` to confirm the module is
   no longer flagged and to spot any remaining genuine gap.
4. Keep effects injectable and assertions deterministic (see above).
