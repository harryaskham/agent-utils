# Goals (`/goal`) in pi-daemon sessions

`/goal` keeps an agent working toward a stated outcome until the agent itself says it is done. It is the smallest useful version of an "autonomous until finished" mode: a goal, a nudge whenever the agent stops, and a tool to end it.

| Command | Effect |
| --- | --- |
| `/goal all tests pass on main and CI is green` | Sets this conversation's goal (replacing any live one). |
| `/goal --max 20 ship the 3.6.5 release` | The same, with at most 20 nudges (default 50, up to 1000). |
| `/goal` | Shows the live goal: its number, nudges so far and how long it has run. |
| `/goal stop` (`off`, `clear`) | Ends it. `/loop stop N` with its number does too. |
| `/goal done` | Marks it done yourself. |

The agent ends a goal with the `goal_done` tool: `{ "summary": "…" }` once it is fully done and checked, or `{ "summary": "why", "blocked": true }` if it cannot be done.

## How it works

It lives in agent-utils' `loop.mjs` (pi-daemon profile extension), on the `/loop` machinery:

- A goal is an entry in the session's loops document, numbered with its loops, `/after`s and `/cron`s, so `/loop list` and `/loops` list it and the loops chip counts it. `/loop stop all` stops schedules but not goals.
- Each goal is a Durable background task of its conversation. It waits until the conversation is idle (the agent's own work and the operator's messages go first), then sends one nudge: the goal, and to call `goal_done` when it is done. It waits for that run to end, and repeats while the goal is live.
- A `goal` system prompt section names the live goal on every request, so the agent knows it between nudges and after a compaction.
- The task is durable: a daemon restart resumes it, and a nudge retried after a crash is the same submission, never a second one.

## Bounds

- **Nudge limit:** `--max` nudges at most (default 50). The goal then ends.
- **Interruptions:** aborting a nudged run (Esc in a client, `conversation.abort`) ends the goal rather than restarting the agent.
- **Failures:** a run that fails (a provider error, say) waits a minute before the next nudge; three failed runs in a row end the goal.

## Where to see goals

- In the session: `/goal`, `/loops`, and the loops chip.
- Across the fleet: `ag loops` and the `ag dash` **Loops** tab list every live goal with its nudges.

Needs pi-daemon 1.10 or later (1.14 or later for stored sleeps between failed nudges). TUI Pi has no `/goal`; its closest is `/endless`.
