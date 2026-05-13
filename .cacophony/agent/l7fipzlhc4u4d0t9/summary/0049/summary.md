# Session summary — preserve defaults during realtime mode

## Goal

Stop `/rt` from persisting its temporary switch to `openai-realtime/gpt-realtime-2` into Pi settings, which was producing unwanted diffs in settings files and changing future session defaults.

## Bead(s)

- `bd-4afe9c` — Prevent /rt temporary model switch from persisting defaults

## Before state

- Failing tests: none in repository; operator observed `standalone/pi/settings.json` changing `defaultProvider/defaultModel` from `litellm-openai/gpt-5.5` to `openai-realtime/gpt-realtime-2` after using `/rt`.
- Relevant metrics: full suite was 111/111 before this patch.
- Context: Pi's public `setModel()` persists model selection as the default model. The realtime extension used `pi.setModel()` to enter realtime mode, so the temporary audio-mode model leaked into durable settings.

## After state

- Failing tests: none observed.
- Relevant metrics: after rebase, `npm test -- test/realtime-agent.test.js` passed 39/39.
- Context: the extension snapshots the current default model settings before switching to realtime and restores `defaultProvider/defaultModel` immediately and on short delayed retries after the `setModel()` write queue. `/rt off` also restores and clears the snapshot.

## Diff summary

- Commits: `72e732b`
- Files touched: `extensions/realtime-agent.js`, `test/realtime-agent.test.js`
- Tests: +1 regression test that simulates `setModel()` persisting settings and asserts `/rt start nolisten` restores the original defaults.
- Behavioural delta: `/rt` remains a session-mode switch, but no longer changes the user's saved default model/provider.

## Operator-takeaway

You should be able to use `/rt` repeatedly without dirtying settings files or making future Pi sessions start on the realtime model by accident.
