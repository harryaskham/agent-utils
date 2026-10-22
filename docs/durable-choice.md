# Choices in pi-daemon sessions

`extensions/durable/choice.mjs` gives pi-daemon sessions agent-utils' choice tools, and
`extensions/durable/choice-client.js` is their part in pi-client. Needs pi-daemon 1.14.

## The daemon plugin: `choice.mjs`

List it in a pi-daemon profile's `extensions:`. The agent gets:

- `interactive_choice`: ask, and wait for the answer (as `ask_user`).
- `async_choice`: ask one or more questions and keep working; each answer arrives later as a
  steering message (`[async_choice answer] …`).
- `async_choice_status` and `async_choice_cancel`.

Questions are pi-daemon's question documents on their tasks (non-blocking ones marked so), so
they survive restarts and need no client open. Every client sees them: pi-client, `/web`, and
AHP clients such as Culture's choice inbox. When the session has a Cacophony identity (a managed
agent's `session.env`, or a visiting registration), each question is mirrored to Cacophony too,
both ways: the first answer wins.

## The client part: `choice-client.js`

List it in pi-client's `client.extensions`. Questions that wait without blocking show behind a
line, `◇ N questions for you · /choices`, in the focused pane; `/choices` lists every waiting
question (blocking ones first) and asks the one picked; Escape leaves it pending. It replaces
pi-client's built-in `/choices`. In TUI Pi it does nothing.
