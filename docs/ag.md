# Durable agent artifacts and the `ag` CLI

The [ag guide](../ag/README.md) documents the producer storage contract, image provenance, speech migration, SSH fleet configuration, commands, MCP schemas, failure handling, tests and Nix delivery.

Source entrypoints:

- `extensions/lib/artifact-state.js`: shared durable state paths and agent/session identity.
- `extensions/lib/tts-feed.js`: request feed appends and non-destructive legacy migration.
- `extensions/shared-images.js`: explicit Pi tool/message sharing hooks.
- `extensions/lib/shared-images.js`: private atomic image copies and provenance sidecars.
- `ag/src/`: one Rust domain core consumed by CLI, MCP and SSH peer protocol.
- `ag/flake.nix`: independently buildable CLI; root `flake.nix` exports `ag` and adds it to the binary bundle.
- `ag/acceptance.json`: contract/test inventory.
- `scripts/benchmark-ag.mjs`: isolated end-to-end startup/history/image-list latency budgets (set `AG_TEST_BIN`).

Explicit `kitty_image_preview_show` calls also preserve the shown image, including an image restored from an older session. Hide/clear/status operations and background animation/stream ticks do not generate archive copies.

## Validation (2026-09-22, macOS ARM64)

- Rust: locked build, formatting, warning-free Clippy, and 9 integration tests; CLI/MCP parity, managed config symlinks, real peer subprocess framing, quoted paths, timeout isolation, reconnect/cursors, stdin EOF and Ctrl-C cleanup.
- Extensions: 39 focused tests passed, including a real JS-writer → Nix-built Rust-reader boundary check and concurrent legacy-feed migration.
- Both root `.#ag` and standalone `./ag#ag` built with tests. Linux ARM64/x86-64 derivations evaluated; Linux execution was not tested on this host.
- Nix binary approximately 3.9 MiB. Isolated 10-sample p50/p95: startup 17/694 ms, 100 speech records from 1000 17/19 ms, 100 images from 200 32/866 ms. Budgets: p95 1s/2s/5s respectively. This measures actual process/filesystem boundaries, not network latency.
- Full JS suite: 1705 passed, 5 failed, 1 cancelled, 4 skipped. The same five failures and cancellation reproduce from the pre-change commit: missing local `pi-mcp-adapter`, devshell environment/hint assumptions, old `session_end` graphics expectations, shell-setting environment assumptions, and an opaque TTS queue test's pending promise. These unrelated failures are not masked or changed here.

## SSH transport follow-up (2026-09-23)

`ag` 0.1.1 launches peers through the remote account's noninteractive login shell, rather than assuming SSH's command PATH includes user packages. Startup chatter is routed away from protocol stdout; JSON, binary image downloads and live streams retain exact argument quoting and stdin/EOF cleanup. The 11-test Rust integration suite includes login-only PATH, noisy profiles, missing binaries, downloads, reconnects and cancellation.

A read-only probe of `ms-mac` found that its SSH/login PATH already included the Nix profile locations, but `ag` was not installed there. Login initialization cannot deploy a missing executable: each target needs the updated Collective package installed, or an explicit `hosts[].command` pointing to an installed binary. Running `cltv-run ag` on the collector alone does not install its peers. The transport now reports that distinction explicitly and never builds or switches a remote system automatically.

The archives are intentionally **not caches**. Session shutdown, preview cleanup and PCM queue maintenance never delete them. Archive retention/backups are operator-owned. No daemon or automatic remote upload is introduced; the explicit `ag` invocation reads selected configured nodes using existing SSH authentication.
