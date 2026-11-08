# Goals (`/goal`) in pi-daemon sessions

`/goal` keeps an agent working toward a stated outcome until the agent itself says it is done. It is the smallest useful version of an "autonomous until finished" mode: a goal, a nudge whenever the agent stops, and a tool to end it.

| Command | Effect |
| --- | --- |
| `/goal all tests pass on main and CI is green` | Adds a goal to this conversation. A conversation can have several, as it can have several loops. |
| `/goal --max 20 ship the 3.6.5 release` | The same, with at most 20 nudges for this goal (default 50, up to 1000). |
| `/goal` (`list`) | Lists the open goals: number, nudges so far, how long each has run. |
| `/goal done N` | Marks goal N done yourself. `/goal done all` marks all of this conversation's goals done. With one goal open, `/goal done` is enough. |
| `/goal stop N` (`off`, `clear`) | Stops goal N, or `all`. With one goal open, `/goal stop` is enough; with several it asks which. `/loop stop N` also stops goal N. |

The agent ends a goal with the `goal_done` tool: `{ "id": N, "summary": "…" }` once it is fully done and checked, or `{ "id": N, "summary": "why", "blocked": true }` if it cannot be done. `id` may be left out when only one goal is open.

## How it works

It lives in agent-utils' `loop.mjs` (pi-daemon profile extension), on the `/loop` machinery:

- Each goal is an entry in the session's loops document, numbered with its loops, `/after`s and `/cron`s. `/loop list` and `/loops` list it, and the loops chip counts it. `/loop stop all` stops schedules but not goals.
- One Durable background task per conversation nudges for all of its goals. It waits until the conversation is idle (the agent's own work and the operator's messages go first), then sends one nudge listing every open goal as a to-do list, with their ids. It waits for that run to end, and repeats while any goal is open. A goal added while others are open joins the same task; the task ends once none is left.
- A `goal` system prompt section lists the open goals on every request, so the agent knows them between nudges and after a compaction.
- The task is durable: a daemon restart resumes it, and a nudge retried after a crash is the same submission, never a second one.

## Bounds

- **Nudge limit:** each goal has `--max` nudges at most (default 50). A goal at its limit ends; the others go on.
- **Interruptions:** aborting a nudged run (Esc in a client, `conversation.abort`) ends the conversation's goals rather than restarting the agent.
- **Failures:** a run that fails (a provider error, say) waits a minute before the next nudge; three failed runs in a row end the conversation's goals.

## Where to see goals

- In the session: `/goal`, `/loops`, and the loops chip.
- Across the fleet: `ag loops` and the `ag dash` **Loops** tab list every live goal with its nudges.

Needs pi-daemon 1.10 or later (1.14 or later for stored sleeps between failed nudges). TUI Pi has no `/goal`; its closest is `/endless`.
