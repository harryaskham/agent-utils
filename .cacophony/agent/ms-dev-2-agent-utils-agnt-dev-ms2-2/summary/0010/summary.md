# bd-1acab6 — revert agent-utils CI: nix-devShell → ubuntu+rust-toolchain

Per Harry's directive (2026-06-29): REVERSE the nix-devShell CI approach
(bd-7eb473) — `nix develop` pulls ~5GB/job on the ephemeral runners. New plan:
ubuntu defaults + setup actions, plain cargo/npm, NO nix develop.

## Changes
- **ci.yml**: js → actions/setup-node@v4 (node 20) + plain `npm test`/`npm run
  check`; rust → dtolnay/rust-toolchain + Swatinem/rust-cache + plain
  `cargo fmt/clippy/test`; audit → dtolnay/rust-toolchain + taiki-e/install-
  action cargo-audit + plain `cargo audit`. runs-on [self-hosted,
  azure-ephemeral] kept.
- **pages.yml**: build → setup-node + plain `npm run docs:check`.
- flake.nix devShell (nodejs_22 + cargo-audit) left as-is — harmless for local
  dev, no longer used by CI.

## Validation
- actionlint OK on both workflows; `npm run check` OK; full suite 1084/1084
  keyless. Test-only fixes (bd-33c4d3 rt-peer, bd-d936b2 /rt-listen) intact.

## Landing
- Direct. Post-land: trigger ci.yml run to confirm green on ubuntu+toolchain
  (no nix). Relies on the azure-ephemeral image providing cc + the setup actions
  for node/rust; if a toolchain is still absent, surface via caco choices.
