# Session summary — release agent-utils v1.1.0

## Goal

Operator (Harry) authorized cutting the version bump. Release agent-utils
v1.1.0, capturing the 688 additive commits landed since v1.0.3 (skill-server /
mcp-cli / web-search agent tooling and pi-graphics modularization across both
overnight agents). No breaking changes, so a minor bump.

## Bead(s)

- `bd-c648b4` — Release agent-utils v1.1.0

## Before state

- package.json at 1.0.3 (tracking the latest tag v1.0.3). 688 commits unreleased.
- Verified release mechanics: agent-utils has NO `caco release` config (not wired
  into the multi-node release system), so its established pattern — per the
  v1.0.2/v1.0.3 history — is a manual package.json bump + git tag on the
  resulting main commit. CI (ci.yml) only runs tests/clippy/audit, no release
  automation. flake.nix version "0.1.0" is the skill-server Nix package
  derivation version, NOT the project version, so it is intentionally left
  unchanged. Cargo crate versions are independent of the release tag.

## After state

- package.json bumped 1.0.3 -> 1.1.0 (single-line change).
- Landed on main; main commit tagged v1.1.0 and pushed (see receipt/tag below).

## Diff summary

- Files touched: `package.json` (version 1.0.3 -> 1.1.0).
- Tests: none affected (version metadata only).
- Behavioural delta: none — release metadata + tag.

## Operator-takeaway

agent-utils v1.1.0 is cut, capturing all overnight tooling work since v1.0.3.
flake.nix/crate versions deliberately untouched (they version the skill-server
package, not the project release).
