# Session summary — /fleet models: find and switch the fleet's sessions by model

## Goal

Give Harry one command that answers "is gpt-6-astra still in use anywhere?" and "switch every Astra agent over to Fable". It should list the live sessions on every node with their runtime model, filter by glob, switch the matches through Chord or Cacophony, and flag the config defaults still naming the old model without editing them. It has to run in TUI Pi, pi-daemon sessions, pi-client and a shell.

## Bead(s)

- `bd-1da117` — /fleet models: fleet-wide model inventory, glob filter, switch, config-default flags
- `bd-4fb00c` (draft, filed from reflection) — module notices render as Markdown; share a plain-text notice helper

## Before state

- No surface listed sessions by model across hosts. Finding Astra sessions meant `sessions.list` per node by hand, and Cacophony's agent metadata does not reflect runtime models.
- Fleet, read during this session over the default 30-day window: 1,534 sessions on 21 of 22 hosts (ms-mac-nixos offline). 60 were on `github-copilot/gpt-6-astra`; over all time, including archived, there were 89 on 15 hosts. Fable 5.2 had 48 sessions.

## After state

- `/fleet models [PATTERN…] [--switch provider/model]` is in TUI Pi (`extensions/fleet.js`), in pi-client as a client extension, as a pi-daemon module (`durable-extensions/fleet.mjs`), and as the `pi-fleet` CLI.
- Acceptance: one `/fleet models '*astra*' --since all --archived --switch github-copilot/claude-fable-5.2 --direct` in TUI Pi switched 88 sessions. The 89th had already moved in a single-host check of the caco path. Read back: 0 Astra sessions on the 21 reachable hosts, and Fable 5.2 is at 137.
- The 57 Cacophony agents among them were finished runtimes and were switched over /chord (`--direct`), because an agent's own caco is refused `agent_model_control` for other agents. Their Cacophony records still name gpt-6-astra.
- Config defaults still naming Astra were flagged, not changed: `settings.json` `enabledModels[2]` (gpt-6.2-astra) and, in Cacophony config, `providers.openai.models[0]`, `providers.pi.github-copilot.models[gpt-6.2-astra]` and `interactive_defaults.codex.model`.
- Tests: `npm test` 2,292 pass, 0 fail; `node --test test/fleet-models.test.js` 27 pass. `npm run check` is OK. `nix build .#pi-fleet .#durable-extensions` succeeded.
- Collective PR harryaskham/collective#315 is merged. It loads fleet.mjs in the personal and cacophony profiles (pathExists-guarded), adds fleet.js to `client.extensions`, and adds step 9 on retiring a model to the pi-daemon-model-rollout skill.

## Diff summary

- Code/content commits: f97e88b5 (feature), a81364b8 (docs); final landed squash SHA comes from the reintegration receipt.
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA.
- Files: `extensions/lib/fleet-models.js` (shared engine), `extensions/fleet.js`, `extensions/durable/fleet.mjs`, `scripts/pi-fleet.mjs`, `test/fleet-models.test.js`, `docs/fleet-models.md`, `README.md`, `package.json`, `flake.nix` (`pi-fleet` package/app/check, `fleet.mjs` in durable-extensions).
- Tests: +27 (fake multi-host Chord fleet, caco exec stub).
- Behaviour: patterns without `/` match the model id, so `*astra*` does not match the `astra` provider's models. `--switch` checks the target against each session's own catalog. Cacophony agents (the session whose id is its checkout's agent id) go through `caco agent set-model` and fall back to /chord when the runtime is not resident. Every other session gets `conversation.configure`. Afterwards the touched hosts are read again. Module notices are plain-text blocks so globs survive Markdown rendering.

## Operator-takeaway

The fleet no longer has Astra sessions on the hosts it could reach. ms-mac-nixos was offline, so run `/fleet models '*astra*' --since all` again when it is back. Cacophony's model catalog does not list claude-fable-5.2, so `caco agent set-model` refuses `model_not_available` for running agents until cacophony-config adds it. Finished agents fall back to /chord, but their records keep the old model. Run from an operator shell (not an agent), `/fleet` goes through caco for Cacophony agents without needing `--direct`.
