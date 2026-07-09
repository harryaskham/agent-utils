# Session summary — pi-wasm S9: nix build/serve wiring

## Goal

Wire a reproducible nix build + local serve path for the in-browser Pi agent
bundle (the `./pi-wasm` subproject), so the browser bundle can be built
deterministically and served with a single documented command — aligned with how
the `web-search` and `linear-extra` subprojects are wired into the agent-utils
root flake. This is slice S9 of the pi-wasm epic (fully in-browser Pi agent loop).

## Bead(s)

- `bd-82b969` — pi-wasm S9: nix subflake + build/serve wiring for the pi-wasm browser bundle
- (parent epic: `bd-f76cee` — pi-wasm: fully in-browser Pi agent loop)

Also this session (lifecycle hygiene, not part of this diff):
- Closed `bd-7c6790` (multi-participant /rt + /cascade epic) — all phases already landed on main.
- Filed then closed-as-duplicate `bd-be8e6b` (→ S11 `bd-0dc0bc`) and `bd-b36b5b` (→ S13 `bd-6ebbf6`): two beads I filed off Harry's broadcast that duplicated existing slices; cleaned up promptly.

## Before state

- Failing tests: none.
- `./pi-wasm` scaffold (S1) existed with a standard Vite build (`npm run build` → `dist/`) and npm lockfile, but no nix wiring; the root flake had no pi-wasm output. Serving relied on an ad-hoc `python3 -m http.server` on the dist dir.
- Root flake exposed web-search-mcp / linear-extra-mcp / skill-server only.

## After state

- Failing tests: none. `nix build .#pi-wasm` succeeds (vite build ~5.6s) and produces a static web root (`index.html` + `assets/` at `$out`). `nix run .#pi-wasm-serve` serves it; smoke-verified: `/` → 200, hashed JS asset → 200 `text/javascript` (correct module MIME).
- New `pi-wasm/flake.nix` subflake: `buildNpmPackage` (deterministic via pinned `npmDepsHash`) → static bundle package `pi-wasm`; a `pi-wasm-serve` writeShellApplication (python3 static server, default port 4319, `--bind 127.0.0.1`); a `serve` app; a devShell (nodejs_22 + python3).
- Root `flake.nix` wires `pi-wasm` as a `path:./pi-wasm` input (follows nixpkgs + flake-utils) and exposes `packages.<sys>.pi-wasm`, `packages.<sys>.pi-wasm-serve`, and `apps.<sys>.pi-wasm-serve`. Intentionally kept OUT of the `default`/`all` symlinkJoin (it is a web bundle, not a bin) so it does not affect the root build/test gate.
- Existing root outputs still evaluate unchanged (`default` → agent-utils, skill-server → skill-server-0.1.0).

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched:
  - `pi-wasm/flake.nix` (new) — subflake: buildNpmPackage bundle + serve app + devShell.
  - `flake.nix` (root) — pi-wasm input + package/app wiring.
  - `flake.lock` — added the pi-wasm path-input node (follows nixpkgs/flake-utils).
  - `pi-wasm/README.md` — documented `nix build .#pi-wasm` / `nix run .#pi-wasm-serve` + npmDepsHash refresh command; marked S9 done in the roadmap.
- Tests: +0 / -0 (build-tooling slice; validated by an actual `nix build` + serve smoke).
- Behavioural delta: the pi-wasm browser bundle now has a first-class reproducible nix build and a one-command local serve, wired into the root flake.

## Operator-takeaway

pi-wasm now builds and serves as a proper nix output (`nix build .#pi-wasm`,
`nix run .#pi-wasm-serve`), pinned via `buildNpmPackage` + lockfile hash, and it
stays out of the root build/test gate so it can't break unrelated CI. The
bleeding-edge toolchain (vite 8 / typescript 7 with per-platform native tarballs)
builds cleanly under `buildNpmPackage`. If the lockfile changes, recompute
`npmDepsHash` with the documented `prefetch-npm-deps` command. The heavier
downstream slices (S7 chat UI, S11 session mgmt, S13 pluggable exec backend incl.
wasm-microvm + ssh-localhost) are owned/tracked by other workers.
