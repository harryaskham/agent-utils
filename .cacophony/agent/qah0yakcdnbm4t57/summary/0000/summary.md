# Session summary: fork lanes (`focus=` and `mode=work|qa`)

## Goal

Harry asked for one command that forks a session into a lane. The fork should get a fixed role note (the original carries on with its own task; this is the lane; this is what it may change), the original should get a short notice, the fork's chip should show the mode, and a qa fork should refuse edits. Nothing should need typing by hand. The command had to work in TUI Pi and through pi-git in pi-daemon/pi-client.

## Bead(s)

- `bd-fd98a3`: Fork lanes: /git wt fork and /clone take focus= and mode=work|qa
- Follow-up drafts filed: `bd-0a9dfd` (pi-client /clone is not replaceable by plugins), `bd-bb6109` (pi-daemon qa forks keep bash)

## Before state

- `/clone` (TUI Pi) and `/git wt fork NAME` (pi-git) copied the conversation, with no lane, no notes and no edit restriction.
- Full suite: 2337 tests passing.

## After state

- TUI Pi: `/clone [NAME] focus=TEXT mode=work|qa` forks at the current position, writes the role note (no turn), appends the notice to the original's file, and names the fork. The chip shows `⑂ qa▌focus`. In qa, edit, write and plainly mutating bash are blocked.
- pi-daemon: `/git wt fork NAME focus= mode=` (local and `@node`) and the new `/git fork [NAME]` (same directory) create the fork. A qa fork is created with this session's built-in tools minus edit and write; `/git lane apply` then runs in it to write the role note and set the module-state lane. `/git lane` shows the lane.
- The `lane` editor chip field and the `lane` pi-client sidebar segment show the lane.
- Full suite: 2339 passing, 0 failing; `npm run check` is ok.
- Checked by hand against real Pi 1.7.0 (RPC and TUI) and an isolated pi-daemon 1.14.0. The fork's catalog row has `session_profile {"tools":["read","bash"]}`, and both conversations have their notes.

## Diff summary

- Code/content commit: ae5cf46e. The final landed squash SHA will come from the reintegration outcome.
- Summary artefact commit: intentionally omitted.
- New: `extensions/lib/fork-lane.js`, `extensions/lib/fork-lane-extension.js`, `extensions/fork-lane.js`, `docs/fork-lanes.md`, `test/fork-lane.test.js` (11 tests).
- Changed: `extensions/lib/fork-session.js` (lane/tools, apply in the fork, cross-node retry), `extensions/lib/durable-git.js` (`/git fork`, `/git lane`, lane args), `extensions/durable/git-client.js` (lane segment, opening the fork, conditional `/clone`), `extensions/lib/editor-chips*.js` (lane chip), `package.json`, `README.md`, `docs/durable-git.md`, `docs/editor-chips.md`, and two existing tests updated for the new chip and segment.
- Behaviour: forks are unchanged unless `focus=` or `mode=` is given.

## Operator-takeaway

In TUI Pi, `/clone ARGS` is handed to `/clone-lane`, because registering `clone` makes Pi 1.7 warn about a conflict at every start. In pi-client, `/clone` with a lane needs pi-daemon to make `/clone` replaceable (`bd-0a9dfd`); until then use `/git fork NAME focus=… mode=qa`. In pi-daemon, a qa fork has no edit or write tools but still has bash (`bd-bb6109`).
