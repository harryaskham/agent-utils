# Summary — bd-a0e836

## Goal
Add opt-in, guarded Xvfb virtual-display orchestration so display-dependent
extensions can run on a headless Linux node, building on the landed display
detection helper.

## Bead(s)
- bd-a0e836 — Optional opt-in auto-Xvfb spawn for headless display-dependent
  actions. P3 feature, pulled from the draft backlog per Harry's "keep improving
  the project" directive. Direct follow-up to the closed bd-44d94e detection
  helper.

## Before state
- `extensions/lib/headless-display.js` (bd-44d94e) classified display
  availability (`native-display` / `wslg` / `headless-no-display`) and emitted an
  Xvfb hint, but explicitly did NOT spawn anything ("orchestration is a follow-up
  slice"). On headless nodes, display-dependent tools (Tendril capture, Android
  screenshots, app-automation browser) dead-ended with only a hint.

## After state
- **`extensions/lib/xvfb.js`** — pure, injectable layer (env / platform /
  commandPath / fileExists probes) so it is unit-testable without spawning or
  real FS:
  - `xvfbCommandPath` — PATH probe for the Xvfb binary (reuses the package's
    accessSync(X_OK) convention).
  - `pickFreeDisplay` / `displayInUse` — choose a unique `:N` by probing
    `/tmp/.X11-unix/XN` lock sockets, so concurrent agents on one host do not
    collide. Range `:99`–`:1099`.
  - `buildXvfbArgs` — `:N -screen 0 <WxHxD> -nolisten tcp`.
  - `planXvfb` — the opt-in policy gate. Refuses with a typed reason unless the
    node is genuinely headless (`display-present` unless `force`), if Xvfb is
    missing (`xvfb-missing`), if the session already owns one (`already-spawned`),
    or if no display number is free (`no-free-display`).
  - `spawnXvfb` — thin wrapper: spawns per a successful plan, exports `DISPLAY`,
    returns a handle with an idempotent `stop()` (SIGTERM → bounded SIGKILL) that
    only unsets a `DISPLAY` it owns.
- **`extensions/xvfb.js`** — opt-in tools `xvfb_ensure` / `xvfb_stop` /
  `xvfb_status` plus `session_shutdown` teardown, mirroring firecracker-vm.js's
  autostop lifecycle. `xvfb_ensure` is idempotent, supports `screen`, custom
  `command`, and `dryRun`. Imports `Type` from the local `lib/tool-schema.js`
  shim (like android.js) so the extension loads under `node --test` without the
  typebox peer dep.
- Registered in `package.json` `pi.extensions`; documented with a README bullet
  and a dedicated section.

## Diff summary
- New: `extensions/lib/xvfb.js`, `extensions/xvfb.js`, `test/xvfb.test.js`.
- Modified: `package.json` (+1 extension entry), `README.md` (bullet + section).

## Validation
- `node --test`: 553 pass / 0 fail (24 new). New test stable across 3 runs.
- `docs:check`: clean. `node --check` clean on all new files. `package.json`
  re-validated as JSON.
- No real Xvfb is spawned in tests — the spawn wrapper is exercised with an
  injected fake child; the pure layer is exercised with injected probes.

## Operator-takeaway
On a headless Linux node, an agent can now call `xvfb_ensure` to bring up a
virtual display (unique `:N`, `DISPLAY` exported) before Tendril/Android/
app-automation actions, and it is cleaned up on session shutdown. It is strictly
opt-in and guarded: it never spawns unprompted, refuses if a real/WSLg display
already exists (unless `force`) or if Xvfb is not installed, and avoids
colliding with other agents' displays. This closes the orchestration gap the
bd-44d94e detection helper intentionally left open.
