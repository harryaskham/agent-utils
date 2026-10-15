# Pi session forks

`/session-fork` (inside Pi) and `pi-session fork` (CLI) share one engine for
forking a conversation into another directory, worktree, or SSH host. Herdr can
open the prepared destination, start Pi there, and optionally focus it.

**History is never translated or redacted.** The whole JSONL tree, including
abandoned branches, provider signatures, images and unknown extension entries,
is copied byte-for-byte after the header. A new header, session name and visible
relocation message establish the new identity and environment. The source keeps
running and is never edited, stopped, reset or stashed.

This replaces the old `/session-export` and `/session-import` extension pair.
Those commands and their bundle importer are removed; old bundles are not a v1
input. Use an original Pi JSONL session. There is no automatic migration of old
bundles and no claim that already-translated history can be repaired.

## Quick start

Inside the active Pi session:

```text
/session-fork --name investigation --worktree investigation
/session-fork --remote aurora --name investigation --herdr --focus
/session-fork --remote aurora --repo ~/agent-utils --clone --name investigation
/session-fork --cwd ~/another-existing-checkout --name continued
/session-fork --help
```

The command waits until Pi is idle and captures the actual selected leaf. It
leaves the active process in place; it does not switch your current Pi session.
The new relocation message tells the destination model that old paths/processes
and host-specific extension state describe the origin, not the current machine.
It does not automatically submit a model prompt.

From a shell:

```sh
pi-session fork --session <pi-session-id-or-jsonl-path> \
  --remote aurora --name investigation --herdr --focus --json

# In an unpublished source checkout (no installation needed):
node scripts/pi-session.mjs fork --session /path/to/session.jsonl \
  --cwd /path/to/existing-directory --name continued --json
```

The ID is a **Pi session ID**, not a Cacophony agent ID or a Herdr pane ID. Lookup
uses the configured source session directory and Pi's default session tree;
ambiguous prefixes fail. Exact paths are preferred for unusual storage layouts.
The CLI snapshots the last persisted leaf, not an unsaved `/tree` navigation in
a running Pi process. Use the slash command when that distinction matters.

`--dry-run` resolves the source and destination without publishing a session,
creating a worktree, cloning, or opening Herdr. It can still contact the SSH peer
and run read-only Git inspection. Errors such as a missing repo explain the
required explicit option.

## Destination and Git behavior

| Choice | Behavior |
|---|---|
| `--cwd PATH` | Reuse that existing directory; never checkout/reset it. A Git target must be clean and at the source commit (except the same local source cwd). |
| No `--cwd`, Git source | Create a detached worktree at the captured source commit. |
| `--worktree NAME` | Set its directory name; single path component only. |
| No `--worktree` | Use a filesystem-safe form of the new session name. |
| No `--name` | Source session name, otherwise source branch, otherwise generated fork name. |
| `--repo PATH` | Explicit destination main repo; linked source worktrees resolve through Git's common directory. |
| Remote repo default | Reuse the source main repo's HOME-relative path under the destination HOME. Repos outside HOME need explicit `--repo`. |
| `--clone` | Permit cloning a missing repo from the recorded origin. No implicit clone, fetch from arbitrary refs, or push. |
| Missing committed objects | Send a bounded Git bundle containing the exact captured commit, including unpushed linked-worktree commits. No temporary source ref is created. |
| Dirty source | Refuse migration by default. `--dirty omit` explicitly leaves uncommitted/untracked files on the source and records that warning. An explicit same-local-`--cwd` fork shares those files and reports that instead. No patch or working-file transfer in v1. |
| Existing worktree path | Refuse unless it belongs to a replay of this same request. Choose another name, or deliberately reuse it with `--cwd`. |

Worktree roots default to `~/.pi/worktrees/<repo>/<name>`, or
`~/.herdr/worktrees/<repo>/<name>` with `--herdr`. Override with
`--worktree-root PATH`. Worktrees are **detached**; creating/moving development
branches is a separate Git action. The main checkout is not switched. A newly
cloned main repository is created with `--no-checkout`; the new worktree contains
the files at the exact captured commit.

For a non-Git HOME session, a remote fork defaults to the remote HOME. Other
non-Git remote directories require `--cwd`. `~` is expanded on the destination;
quote `~/...` in a **shell** command so your local shell does not expand it first.
The Pi command parser does not run a shell or expand `$variables`.

## SSH and installation

Both ends need `pi-session`, Node 22+ and Git. SSH uses the operator's normal SSH
config, host keys and identities, with batch authentication. It never disables
host-key checking, copies credentials, installs software remotely, or puts a
transcript in command-line arguments. A finite, versioned JSON request goes over
stdin; a receipt comes back on stdout. Transcript/Git-bundle checksums are checked
at the receiver. Do not add banners to noninteractive shell stdout.

Use `--remote-command PATH` if the peer executable is not on PATH. It is a single
executable path, **not a shell snippet**. For a source checkout on the other node:

```sh
pi-session fork --session <id> --remote aurora \
  --remote-command '~/agent-utils/scripts/pi-session.mjs' --name investigation
```

Delivery surfaces:

- Pi package: `extensions/session-fork.js` in the normal extension list.
- npm bin: `pi-session` → `scripts/pi-session.mjs`.
- Nix: `.#pi-session`, also in the Agent Utils CLI aggregate/overlay; runtime
  Node, Git and OpenSSH are wrapped in. Pi and Herdr are optional external programs.

A Pi package reload enables the slash command; it does **not** put npm bin links
on the shell PATH. Use the Nix package/Collective installation or the source CLI.
A build alone does not install or advance Collective's lock. Native Windows is
not supported in this version; Linux/macOS/Android Unix environments are intended.

## Herdr

`--herdr` uses `worktree open` for a prepared worktree, or `workspace create` for
an existing directory, always with `--no-focus`. It reads returned workspace and
pane IDs, then calls `agent start ... --kind pi --pane <returned-id> -- --session
<exact-file> --name <name>`. Herdr's successful start means interactive readiness,
not completion of any model turn.

`--herdr-session NAME` explicitly selects the **destination server session**;
the default is `default`. Start that server yourself if it is not running. An
SSH destination does not inherit the source's pane/server identity. Saved Herdr
machine profiles are not resolved by this tool: `--remote` is an SSH alias.

`--focus` is a separate opt-in. Before focus, the adapter checks the named live
occupant, pane, terminal identity, and native session identity when Herdr supplies
one. It does not assume pane handles survive server restarts. Focusing the remote
server does not move a local client to that machine; attach the appropriate Herdr
client yourself. No UI mode or desktop is changed behind your back.

Herdr has no idempotency key on create/start. The adapter records admission before
calling each. A lost response produces **indeterminate**, never a blind second
workspace or Pi process. The session file and resume command remain valid even if
Herdr is unavailable or blocked. Inspect the saved pane/agent with the named
server before manually completing a failed launch. Retrying a completed request
does not start or focus the same agent again.

## Receipts, retries and recovery

```sh
pi-session status <request-id> --json
pi-session retry <request-id> --json
```

Or inside Pi:

```text
/session-fork status <request-id>
/session-fork retry <request-id>
```

A generated request ID is returned; pass `--request YOUR-ID` to choose one before
starting. Once admitted, it binds the source snapshot, intent and new session ID.
`retry` works even after the source session advances. Reusing a request ID with
different options fails. `status` is read-only and checks the destination through
the original transport. To inspect a remote incoming request without source state:

```sh
pi-session status <request-id> --remote aurora --json
```

The receipt provides `resume.onDestination` (exact `cd ... && pi --session ...`)
and `resume.fromSource` (SSH form when applicable). These resume the existing fork,
not a fresh copy. Do not manually launch concurrent writers to the same Pi session.

State is under `$PI_CODING_AGENT_DIR/session-forks/{outgoing,incoming}/<request>`
(default `~/.pi/agent`). Private source snapshots/Git bundles are retained for retry;
receipts never include transcript bodies. This is not a sync service and there is
no automatic deletion. Delete a completed request's private outgoing/incoming
journal directories only when no operation is running and retries are no longer
needed; this does not remove the published session or worktree.

Session writes are `0600`, atomic, durable and no-clobber. Replays verify the
published prefix, permitting new entries appended after resume. Changed/truncated
prefixes are a conflict, not permission to overwrite. Per-request locks keep
unrelated requests independent. A positively dead local PID's lock is quarantined
with its owner evidence; live, foreign-host, permission-denied or ownerless locks
are not removed. An ownerless lock after a crash during admission requires manual
inspection. Herdr ambiguity remains indeterminate even after lock recovery.

JSON envelope: `{version:1, ok:true, result:...}` or
`{version:1, ok:false, error:{code,message,details}}`. Exit codes: `0` success/readable
status, `1` operation failure, `2` argument/source-path error, `3` indeterminate
Herdr presentation after successful session publication. The internal `_peer`
protocol returns logical errors as JSON with exit 0 so SSH transports preserve
the structured error. There is no public arbitrary-command endpoint.

## Bounds and exclusions

- Session snapshot: 64 MiB. Git bundle: 128 MiB. Oversized data fails; never drops
  images/history silently. Peer wire input is bounded and has a deadline.
- Source must be saved Pi v3 JSONL with complete records, unique IDs and backward
  parent references. Unsupported/newer versions fail, rather than being guessed.
- No auth, MCP settings, packages, external attachment files, sockets, devices,
  browser profiles, running processes, or dirty working files are migrated.
- Destination Pi supplies its own tools, resources, auth and models. Preserved
  unknown extension payloads are historical data; their owners must reinitialize
  host-specific runtime state. History cannot make external resources portable.
- This tool does not manufacture `/home/agents` symlinks or rewrite usernames.

## Validation

```sh
node --test test/session-fork*.test.js
PI_SESSION_TEST_PI_BIN=/absolute/path/to/pi \
PI_SESSION_TEST_HERDR_BIN=/absolute/path/to/herdr \
  node --test test/session-fork*.test.js
```

The opt-in tests start their own private Herdr server and real Pi processes with
disposable HOME/config/runtime directories. They do not use operator accounts,
credentials, live workspaces or provider calls. The SSH-adapter test crosses an
actual shell/process/receiver boundary in two disposable homes via an SSH shim;
it is not proof of cross-machine SSH authentication/network behavior.

Contract and acceptance IDs: [design/session-fork.md](design/session-fork.md).
