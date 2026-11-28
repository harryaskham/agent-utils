# Fork lanes: `focus=` and `mode=work|qa` (bd-fd98a3)

A fork made by `/clone` or `/git wt fork` can be told what it is for and what it may change, so
nobody types it by hand:

- `focus=TEXT` is the fork's lane. Quote it when it has spaces: `focus="harbour-qs Q&A"`.
- `mode=work` lets the fork edit. It is the default when only `focus=` is given.
- `mode=qa` makes the fork read-only: it answers questions and refuses edits.

One command then does three things:

1. **The fork gets a fixed role note** in its conversation, written with no turn, so it waits for
   the next message. The note says that this is a fork of the named session, that the original
   carries on with its own task and the fork must not continue it, what the lane is, and what the
   fork may change. A fork that shares the original's directory is told to touch only its lane's
   changes and commit only its own; a qa fork is told not to edit, write, move or delete files or
   change git state.
2. **The original gets a short notice** that a copy of the conversation continues as session NAME
   in that lane, so it carries on with its own task. The notice is written after the fork's copy,
   so the fork never sees it.
3. **The fork's editor chip shows the lane**: `⑂ qa▌harbour-qs` in the warning colour, or
   `⑂ work▌docs` in green ([editor chips](editor-chips.md), field `lane`). pi-client's sidebar rows
   can show it too, as the segment `lane`.

Without `focus=` or `mode=`, the commands behave as before.

## Where each command is

| Where | Command | What it makes |
| --- | --- | --- |
| TUI Pi | `/clone [NAME] [focus=TEXT] [mode=work\|qa]` | A duplicate of the session at its current position, as Pi's own `/clone` makes, in the same directory, named `NAME`, else the focus, else `<name> (<mode>)` |
| pi-daemon (any client) | `/git wt fork NAME [focus=TEXT] [mode=work\|qa] [@node] [--rebase[=BASE]]` | A worktree and branch `NAME`, and a session there with this conversation ([pi-git](durable-git.md)) |
| pi-daemon (any client) | `/git fork [NAME] [focus=TEXT] [mode=work\|qa]` | A session in this same directory with this conversation, as `/clone` makes in TUI Pi |
| pi-daemon | `/git lane` | This session's lane, if it has one |

Pi's `/clone` with no arguments stays Pi's own. With arguments, TUI Pi has no command of that
name, so agent-utils' `input` handler takes it and runs `/clone-lane` with the same arguments.
`/clone-lane` is the real command: an extension command named `clone` would be reported as a
conflict with Pi's built-in at every start.

In pi-client, `/clone` is pi-client's own command, which only pi-client can hand to a plugin.
Until it does, use `/git fork NAME focus=… mode=…` there. pi-git's client part registers `/clone`
only where pi-client lists `clone` in `pi.replaceableCommands`. Its `/clone` with `focus=` or
`mode=` runs `/git fork`; without them it copies the conversation as pi-client's own does,
`/clone [@host] [NAME]`.

## How a qa fork refuses edits

- **TUI Pi:** a `tool_call` hook blocks `edit` and `write` with a reason the model sees. It also
  blocks `bash` commands that plainly change files or git state: output redirected to a file,
  `tee FILE`, `sed -i`, `perl -i`, `rm`, `mv`, `cp`, `touch`, `mkdir` and the like outside `/tmp`,
  and git commands that change the work tree, index or refs (`commit`, `checkout`, `reset`,
  `stash`, `push` and so on). Reads, builds and tests pass. This check is best effort: a command
  that writes in a way it does not recognise gets through, and the role note covers the rest.
  The lane is the latest role note on the session's branch, so a later work lane on the same
  branch lifts it.
- **pi-daemon:** the fork's session is made with its own built-in tools: this session's, without
  `edit` and `write` (`sessions.create`'s `tools`, pi-daemon 1.14 or later). The model cannot call
  them, and code mode cannot either. `bash` stays, so the fork can read and run read-only
  commands; the role note tells it not to change anything. A host that does not take a session's
  own tools makes the fork with its profile's tools; then the role note alone keeps it read-only,
  and the command says so.

## pi-daemon: how the lane reaches the fork

`/git wt fork` and `/git fork` make the fork's session themselves ([pi-git](durable-git.md#the-forks-session)):

1. With `mode=qa`, the session is created with this session's built-in tools less `edit` and
   `write`.
2. Once it exists, pi-git sends it its own command, `/git lane apply LANE`. That command runs in
   the fork, instead of a turn: it writes the role note (a user message with no turn) and keeps the
   lane in pi-git's module state (`pi-daemon.module-state`, key `git`, value `lane`). pi-client's
   chips and sidebar read it from there. The command is sent only when the fork's session lists
   pi-git's `git` command; anywhere else the text would be a prompt.
3. On another node (`@node`), the role note ends the conversation imported there. `/git lane apply`
   then keeps only the lane there.
4. The original's notice is written in this conversation, with no turn (while it works, it lands
   when its turn ends). The command's own message says the lane, whether the fork has its role
   note, and whether its edit tools were taken away.

The lane travels as JSON: `{ mode, focus?, from: { sessionId, title, cwd }, cwd, branch?, host?,
shared?, restricted?, at }`. `shared` means it shares the original's directory; `restricted` means
its host took its edit tools away.

## TUI Pi: where the lane lives

The role note is a custom message (`agent-utils.fork-lane`) whose `details` is the lane. The
guard and the chip read the latest one on the branch. The original's notice is a custom message
(`agent-utils.fork-notice`) appended to its session file once the fork exists; it is never a lane.
Pi has already switched to the fork by then, so the original reads the notice when it is resumed.
