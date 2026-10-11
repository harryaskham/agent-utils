# Kitty preview reload lifecycle

## Crash and cause

An affected Pi exits with an uncaught exception at `flashDeleteWidget` in
`extensions/kitty-image-preview.js` (previously line 647):

```text
This extension ctx is stale after session replacement or reload.
```

The old `session_shutdown` hook called `flashDeleteWidget`, which installed a
100 ms timer to remove its temporary delete widget. The hook returned immediately.
Pi then invalidated the old extension context. When the timer fired,
`ctx.ui.setWidget(...)` read that stale context and threw outside Pi's awaited
hook/tool error boundary. Hide operations also had a separate untracked 120 ms
refresh timer. Several agents reloading the same affected extension could each
crash independently; this is not evidence that Paratenic, the model provider or
saved session data failed.

Optional chaining (`ctx?.ui?.setWidget`) would not fix this: `ctx.ui` is a guarded
getter and throws even when `ctx` is non-null.

## Repair

- A session-owned preview lifecycle cancels pending UI/stream timeouts and
  invalidates already-dequeued work before teardown begins.
- Shutdown performs the scoped owned-image data free (`d=I`) synchronously through
  a reachable terminal writer, then removes UI. It never schedules a new flash.
  Widget factories retain the current TUI solely to supply that terminal writer;
  it is released on shutdown. A hidden, never-mounted gallery uses a synchronous
  empty widget factory to obtain the writer during the hook, then removes the
  widget immediately. No global image clear is sent.
- Hide/clear flashes remain available during an active session, but their timers
  are tracked, unref'd and cancelled on teardown. They cannot clear the replacement
  generation's widget.
- Side-panel discovery, overlay rejection, runtime handoff, file preparation,
  animation/cycle error handlers and stream/description completions check their
  originating lifetime before accessing a captured context or publishing UI.
- Stream process/description signals are aborted on shutdown. A late completion
  that ignores cancellation cannot update UI or schedule another frame.

This fixes the demonstrated preview crash; it is not a claim that every extension
in the fleet has undergone a complete lifecycle audit.

## Updating already-running agents

Updating files on disk does **not** replace the old shutdown hook already loaded
in a Pi process. Avoid another bulk `/reload` as the first recovery action.

Update the Agent Utils package, then restart affected Pi processes through their
normal supervisor/terminal and resume their saved sessions. Fresh processes load
the fixed extension. This crash does not intentionally delete session transcripts.
Do not delete sessions, clear provider state, or weaken Pi's stale-context guard.
No live session is automatically restarted or reloaded by this fix.

## Validation

- `test/kitty-image-preview-lifecycle.test.js`: fake-clock regression reproduces
  the old failure at line 647/634, verifies zero stale-context accesses after
  shutdown, scoped synchronous graphics frees, successor-widget isolation,
  late capture/description/file completions, and Pi's real `ExtensionRunner`
  invalidation semantics.
- `npm run test:preview-reload`: runs an isolated real Pi 0.84.4 in RPC mode with
  only the fixture and preview extension. Three actual `ctx.reload()` calls use
  inline/side placement and pending hide work, then wait beyond the old timer
  deadlines and verify the process survives. No live model, microphone, capture
  process, account or production state is used. `PI_BIN` selects the tested Pi.
- `npm run test:preview-reload-pty -- --placement aboveEditor` (also `belowEditor`
  and `rightOverlay`): real Pi in a private PTY, five `/reload` commands per
  placement. Verified same PID, scoped `d=I` output, clean exit and restored
  terminal modes. The test-only harness was supplied by the paused audio-worktree
  agent; it tests this checkout's implementation, not the competing patch.
- Existing preview, graphics, stream and widget tests remain required.

RPC and TUI smokes create only isolated processes/state. The TUI harness also
accepts `--extension-entry` to compare another source revision without changing
any installed package or live agent.
