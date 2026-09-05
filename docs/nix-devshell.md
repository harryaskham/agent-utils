# On-demand Nix devshells

Agent Utils can activate a flake devshell only when a user or agent needs it,
without putting `use flake` in `.envrc`.

## Session-wide mode

```text
/nix devshell
/nix devshell ci
/nix devshell status
/nix devshell off
```

`/nix devshell` synchronously evaluates the current flake and captures the
default devshell environment with `nix develop --command env -0`. A named shell
uses `.#NAME`. Once initialization succeeds, later model-facing `bash` calls run
with that captured environment through Pi's native Bash spawn hook. Commands keep
their original working directory and do not pay for another `nix develop`
evaluation. User `!` commands are also routed through the selected devshell.

Activation is session-local and fail-closed: a failed evaluation leaves ordinary
Bash untouched. `/nix devshell off` restores ordinary Bash immediately. The
footer shows `nix:default` or the selected shell while active.

The extension merges the captured devshell environment over Pi's command
environment. This preserves Pi's per-call session variables while applying the
Nix `PATH` and package variables. Captured values are held only in memory and are
never returned in tool results or persisted into the transcript.

## Agent tools

- `nix_devshell_enable({ devshell? })` initializes and enables session-wide
  routing. Agents should not manually prepend `nix develop` afterward.
- `nix_devshell_disable()` restores ordinary Bash.
- `bash_devshell({ command, devshell?, timeoutMs? })` performs one command with
  `nix develop` without changing session-wide routing.

The one-shot tool uses an argv-based process launch, validates named shells, is
abortable and timed, and bounds captured output. It benefits from the shared Nix
store and evaluation caches after the first call.

## Removing automatic direnv activation

After installing/reloading Agent Utils, repositories can remove `use flake` from
`.envrc`. Keep any unrelated environment setup there. Enter the shell explicitly
with `/nix devshell` or let an agent call `nix_devshell_enable` when repository
commands require it.
