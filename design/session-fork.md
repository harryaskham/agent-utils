# Session fork v1 contract

Replacement for the retired portable-session export/import pair. This is a fork,
not process migration, sync, redaction, or transcript translation.

## Authority and interfaces

One dependency-free JavaScript engine serves `/session-fork` and `pi-session`.
JavaScript is intentional: Agent Utils is already a Pi JS package and sharing the
same implementation with its extension avoids a second Rust session parser. The
CLI has JSON receipts and a versioned, bounded stdin/stdout peer protocol; no
resident daemon, UI, updater, telemetry service or separate MCP server is needed.
Pi/AHP transports may invoke the registered slash command through their ordinary
input path. No domain-specific Paratenic API or capability is introduced.

## Invariants

- SF-01: All existing JSONL entry bytes are unchanged, including signatures,
  images, custom payloads and abandoned branches. Only the header is replaced;
  a session name and visible relocation message are appended. Source untouched.
- SF-02: New session identity, source host/HOME/cwd/session/leaf/hash provenance.
  The relocation message is parented at the chosen source leaf. CLI defaults to
  the last persisted entry; Pi captures its actual leaf after waiting for idle.
- SF-03: Source reads are bounded and reject partial/changing files, malformed
  trees and unsupported session versions. No provider credentials are copied.
- SF-04: Local and SSH forks share a receiver. SSH uses configured host keys and
  batch authentication; never disables host verification. No transcript in argv.
- SF-05: Destination paths expand HOME there, never by rewriting history. Explicit
  cwd reuses a directory; otherwise create a detached worktree at exact HEAD.
  Resolve linked worktrees via Git's common directory. Transfer missing committed
  objects with a bounded Git bundle. Clone only with explicit --clone.
- SF-06: Dirty source trees are refused for migration unless --dirty omit is
  explicit. Omitted changes are recorded in the relocation note/receipt. No
  stash, reset, clean, branch overwrite, auth copy, or implicit push.
- SF-07: Persist an immutable source request/snapshot before transport. Retry uses
  that snapshot and identity, not the advancing source. Destination publication
  is private, atomic, no-clobber and content-verified. Same request, same fork.
- SF-08: Per-request locks exclude concurrent execution. Ordinary failures release
  locks; positively dead local owners are atomically quarantined with evidence.
  Live/unverified/ownerless locks are reported, never blindly removed. Publication
  recovers if its receipt was lost. Status verifies the published prefix.
- SF-09: Herdr is optional and only presents prepared Git/session state. Always
  target an explicit returned pane and explicit destination Herdr session. Focus
  is opt-in. Persist admission before non-idempotent workspace/agent actions;
  ambiguous outcomes are reported and never blindly replayed. Session readiness
  survives Herdr failure; the exact resume command remains available.
- SF-10: Standalone CLI and extension parsing agree, including quotes, tilde,
  spaces, errors and JSON receipts. Names never enter an unquoted shell command.
- SF-11: Real Pi RPC resumes a synthetic fork with intact context/signatures;
  real Git/CLI and SSH protocol boundary tests use disposable homes/repos.
- SF-12: npm bin and Nix package expose the same CLI. No imperative installation,
  live operator session manipulation, or implicit remote deployment.

## State and failure semantics

State under `$PI_CODING_AGENT_DIR/session-forks/{outgoing,incoming}/<request>` is
owner-private. A request ID binds a fixed snapshot and intent. Receipts contain
paths/identity but never transcript bodies. Retry resolves transport uncertainty
by querying/replaying the same receiver request. Session publication and Herdr
presentation are separate outcomes. A Herdr timeout may have started a process;
return `indeterminate` and inspect its saved pane instead of launching twice.

Supported v1 hosts: Unix-like Node 22+ (Linux, macOS, Android with Node/Git/SSH).
Native Windows is not claimed. Transcript and Git-bundle bounds are 64 MiB and
128 MiB. Process calls have finite deadlines and bounded output. Tests preserve
only synthetic evidence. Native macOS/Android and real cross-node/Herdr launches
must be reported separately from local process/fake-peer coverage.
