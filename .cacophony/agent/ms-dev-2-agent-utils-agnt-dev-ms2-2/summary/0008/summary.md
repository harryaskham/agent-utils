# bd-7eb473 — agent-utils CI: Nix devShell toolchains on azure-ephemeral runners

Follow-on to bd-37d130 (CI → azure-ephemeral self-hosted runners). Per Harry's
directive (2026-06-28): the azure-ephemeral runners have Nix+flakes but **no
system toolchains** — I empirically reproduced `error: linker \`cc\` not found`
failing the rust CI job (run 28333809751), and the bare runner has no node
either. Fix is to enter the flake's Nix devShell for toolchains rather than add
a custom runner image.

## Changes
- **flake.nix** devShell: added `pkgs.nodejs_22` (JS jobs + pages docs:check)
  and `pkgs.cargo-audit` (audit job). The devShell already provided
  cargo/rustc/rustfmt/clippy + `cc` (via stdenv mkShell) + actionlint.
  (CI used node 20, but `nodejs_20` is EOL/insecure in nixpkgs; node 22 LTS is
  API-compatible for the node:test suite.)
- **.github/workflows/ci.yml**: js / rust / audit jobs now run each toolchain
  step via `nix develop --command …`, removing `actions/setup-node`,
  `dtolnay/rust-toolchain`, `Swatinem/rust-cache`, and `taiki-e/install-action`.
- **.github/workflows/pages.yml**: build job's `npm run docs:check` runs via
  `nix develop --command`.

## Validation (all in the devShell, locally with nix 2.34)
- devShell provides: node v22.22.3, npm 10.9.8, cargo 1.95, **cc gcc 15.2**,
  cargo-audit 0.22.1, actionlint 1.7.12.
- `actionlint` OK on both reworked workflows; `npm run check`
  (lint:workflows + docs:check) OK; `cargo fmt --all -- --check` OK.
- **cc-proof**: `cargo clippy --workspace --all-targets -- -D warnings`
  compiles + **links** the workspace cleanly in the devShell (Finished in
  ~24s) — the exact step that failed "linker cc not found" on the runner.

## Known separate (NOT this bead, NOT toolchain-related)
- The `js` job will still red on CI for two pre-existing reasons surfaced by
  the live runner, both unrelated to toolchains: (a) `/rt listen …` errors
  "No OpenAI API key" because it reads the key at runtime (non-hermetic; passes
  locally with a key, fails keyless on CI); (b) 4 rt-peer/rt-multi tests
  (`runPeerTurn`/`makeInjectAndRespond`) fail on main — msm-2's cascade tests.
  Flagged to msm-2 / for a separate test-hermeticity bead.

## Landing
- Landed via **direct** (not pr_auto_merge): the PR's own CI would block on the
  pre-existing js test failures above, unrelated to this toolchain change.
  ci.yml triggers on PR/tags only, so direct queues no CI on the main push.
- Post-land: trigger a ci.yml workflow_dispatch to confirm rust + audit + pages
  go green (js red on the known pre-existing tests).
