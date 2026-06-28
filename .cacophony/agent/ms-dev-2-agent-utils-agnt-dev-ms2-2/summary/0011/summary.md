# bd-77f340 — link rust CI via nix-shell -p gcc (lightweight cc)

Follow-on to bd-1acab6 (rust-not-nix revert). Harry: self-unblock. The rust job
still failed `linker cc not found` — azure-ephemeral runners have no system C
compiler. Fix: provide ONLY gcc via `nix-shell -p gcc --run "cargo …"` for the
compiling steps (clippy/test) — hundreds of MB, not the rejected 5GB devShell —
so cargo can link. rustup cargo (dtolnay) stays; fmt stays plain; js/audit
unchanged. Validated locally: nix-shell -p gcc → cc gcc 15.2, cargo clippy
links/passes. Direct mode; CI run to confirm all three jobs green.
