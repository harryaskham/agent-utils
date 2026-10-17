# Deferred compaction: `/compact-next`

Queue one compaction without interrupting the model response or tools already running:

```text
/compact-next
/compact-next Preserve the current task, test failures, and next steps
/compact-next resume=continue
/compact-next resume=none
/compact-next resume=off
/compact-next status
/compact-next cancel
```

The command returns immediately. A footer status shows `queued` or `compacting`.
It waits for **the whole assistant turn and tool batch**, not the first tool to
finish. On Pi with actionable `turn_end` boundaries (tested with 1.3.0), the
summary is applied before the next model request, inside the same agent run.
It does not abort the agent, replay a slash command as chat, or terminate tools.

## Resume modes

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Resume with no new message when the retained context/queued input allows it. Otherwise add one hidden `Continue.` checkpoint. |
| `none` | Never add a resume message. Continue only if the boundary is runnable; if the retained context ends with an assistant answer and no queued input, leave it settled and report why. |
| `continue` | Add one visible `Continue.` checkpoint and resume. |
| `off` | Do not request an extra model turn. Normal tool-loop continuation and already-queued work still proceed; this is not a stop command. |

Checkpoints are custom messages, converted to user-role context by Pi. Empty
prompts are deliberately not sent: they are not a portable continuation API.
`none` means **no new resume message**, not “stop”.

Text after the options focuses the **summary**, not the continuation. There is
no minimum-usage guard for this explicit operator request.

## Lifecycle and failures

- One pending request per session; repeats report the existing request. Cancel
  first to change options. `status`, `help`, and `cancel` do not wait for work.
- Cancel aborts boundary summarization only, not the underlying task. If legacy
  manual compaction already started, cancel suppresses its resume and lets that
  compaction finish.
- Escape/aborted or failed turns do not get automatically restarted.
- Session replacement, branching, reload/shutdown invalidate pending callbacks.
  Requests are runtime-only, not restored after restart.
- If another normal compaction satisfies a queued request first, it is cleared.
- Summary failure or a branch mutation while summarizing leaves the original
  context/work untouched and reports an error. There is no retry loop.

## Host compatibility

On older Pi versions without actionable boundaries, the command waits for
`agent_settled`, exits the event dispatcher, and rechecks that the session is
idle with no pending input before invoking `ctx.compact()`. New work wins that
race. Auto/continue resumes only after success. `none` cannot resume an idle
host: the extension API has no prompt-free idle continuation method.

Idle RPC/AHP sessions must use their controller's compaction operation; a
standalone extension must not manufacture a replacement client-owned run.
**Active actionable boundaries work through the same command/controller in RPC
and standalone Pi**, without importing or requiring Paratenic. No additional AHP
capabilities or device-specific transport events are advertised.

## Summary behavior

The boundary path uses Pi's public `generateSummaryWithUsage` through the
current session's model registry. It summarizes the finalized, context-edited
projection (including any previous summary), retains a recent suffix according
to the file-backed Pi `keepRecentTokens` setting/model override, and always
retains the completed assistant message with all of its tool results. It never
starts the retained suffix at a tool result. Usage is saved on the compaction
entry. A session too small to have an older prefix is left unchanged.

This is an **extension-provided boundary compaction**, not Pi's aborting manual
compaction API. It uses a single prefix summary rather than Pi's separate
split-user-span summaries. Pi's manual `session_before_compact` and
`session_compact` hooks do not run for boundary drafts (including the separate
compaction-continue guard). Runtime-only SDK settings overrides are not visible
to the extension's file-backed settings reader. Use normal `/compact` while idle
if you need another extension's custom summarizer or those hooks. The legacy
idle fallback uses normal manual compaction and its hooks.

## Validation

```sh
node --test test/compact-next.test.js
npm run test:compact-next-runtime
npm run test:compact-next-ui
```

The real-Pi test runs an offline fixture provider in a disposable config/cwd,
holds two tools open, submits the actual slash command, and proves both finish
before summarization, exactly one compaction occurs, and the next request sees
the summary plus both results without a new prompt or replacement agent run.
It also checks final-assistant continuation with hidden and visible checkpoints.
The PTY test types the commands into the actual TUI at 120×35, checking the queued
notice and the same non-aborting lifecycle. Set `PI_COMPACT_NEXT_PTY_LOG` to save
its terminal output. These tests need Pi 1.3.0 or a compatible actionable-boundary
host on PATH (`PI_BIN` overrides it). No live provider credentials or operator
sessions are used.

Acceptance IDs `CN-01`–`CN-06` are covered in the two test files: command parsing
and deduplication; same-run boundaries; cancellation/failure/session isolation;
legacy idle fallback; projection and tool-pair retention; real runtime behavior.
