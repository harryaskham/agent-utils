# Copilot Opus 5.5 restore identity

Pi 0.84.4 can warn:

```text
Could not restore model github-copilot/claude-opus-5-5. Using <default model>
```

This is not evidence that `enabledModels` or the chosen model is misspelled.
Copilot's catalogue uses `claude-opus-5.5`, while the Anthropic-format response
reports `claude-opus-5-5` in `message_start.model`. A direct, bounded probe against
**GitHub's** `/v1/messages` endpoint on 2026-10-13 confirmed: request
`claude-opus-5.5`, HTTP 200, response `message_start.model = claude-opus-5-5`.
The catalogue advertised only the dotted ID. No credential/response text was
logged. The hyphenated wire name is therefore not exclusive to connections made
directly to Anthropic.

The installed Pi adapter (`pi-ai/dist/api/anthropic-messages.js`) assigns that
wire value to `output.model`. Session projection
(`pi-coding-agent/dist/core/session-manager.js`, `getSessionContextSettings`)
then lets an assistant message replace the preceding `model_change` identity.
SDK restore (`core/sdk.js`) performs an exact provider/id lookup. The hyphenated
Anthropic ID does not exist in Copilot's catalogue, so Pi uses the configured
default. Metadata-only inspection confirmed correctly dotted `model_change`
entries followed by hyphenated Copilot assistant entries.

`extensions/copilot-model-identity.js` supplies a narrowly scoped compatibility
hook: **only new finalized assistant replies** from
`github-copilot/claude-opus-5-5`, while the selected model is exactly
`github-copilot/claude-opus-5.5`, are assigned the canonical catalogue ID before Pi
persists them. It uses the documented `message_end` replacement API. Contents,
thinking signatures, response IDs and usage are unchanged. Other providers,
models, genuine fallback responses and already canonical replies are untouched.
The extension never selects a model or rewrites settings/history.

## Preferred recovery: upgrade and select the model once

No Pi source patch or model alias is required. With **stock Pi 1.1.0 or newer**:

1. Exit the old Pi process and launch the installed newer Pi in the same working
   directory with `pi --continue`.
2. If the old entry causes an initial fallback, run
   `/model github-copilot/claude-opus-5.5` (or select that entry in `/model`).
   Ordinary selection saves the choice for this session; **Ctrl+S is not needed**
   and would change the default for new sessions.
3. Subsequent plain `pi --continue` restores Opus. No prompt or model request is
   needed to record the one-time selection.

This workflow was verified against unpatched Pi 1.1.0 with the Agent Utils
compatibility hook disabled: reproduce the old fallback, perform one standard
`set_model` operation (the RPC equivalent of `/model`), exit, continue without
model flags, generate a new reply, and continue again. Both continues retained
the dotted ID, emitted no restore warning, preserved the old message metadata,
and left the default model unchanged. `--session <file>` was verified too.

The proposed Collective/Pi lookup patch was withdrawn; do not reintroduce it.
Installing a new executable does not upgrade already-running processes. Do not
start a second Pi writer against a live session file or blindly bulk-restart
agents whose ownership/work state is unknown.

## Runtime version and restart boundary

Pi **1.1.0** now preserves the requested ID in `message.model` and puts the wire
name in `responseModel`; the compatibility hook becomes a no-op on that path.
An isolated real Pi 1.1.0 process confirmed this through a local Anthropic-format
SSE fixture. Installing the new Pi executable or updating extension files does
not replace old code already loaded in running processes.

The earlier message hook alone did **not** cover a first restart from an old
hyphenated entry: model selection happens before `session_start`. `/restart` now
passes the currently selected provider and model explicitly, replacing stale
launch-time model flags. It takes that snapshot after the session is idle and
continues suppressing startup prompts/file arguments. This preserves the current
selection without rewriting historical messages or changing default settings.
`/restart --dry-run` shows the exact executable and selected-model arguments.

For an existing session that has already fallen back, explicitly choose
`github-copilot/claude-opus-5.5` once after loading the fix. The next Opus reply is
stored with the resolvable ID. Old session files are not mass-migrated, and a
first resume from an old final hyphenated reply can still show the warning.

`test/copilot-model-identity.test.js` reproduces the original failure using Pi's
actual in-memory SessionManager, then passes the compatibility hook through the
actual ExtensionRunner and proves the resulting session projection restores the
canonical ID. Only synthetic messages are used in the regression tests.

`PI_RUN_MODEL_RESTORE_SMOKE=1 node --test test/copilot-restore-process.test.js`
exercises an actual Pi process, local SSE response with the hyphenated wire ID,
session persistence, and restart planning against a synthetic pre-fix session.
The restart case verifies the dotted request/selected ID and no restore warning
or prompt replay; that case passed on Pi 0.84.4 and 1.1.0. The continue/session
cases verify the preferred one-time-selection recovery on **stock Pi 1.1+** with
no compatibility hook. `PI_BIN` can select the installed runtime. The test never
connects to GitHub or uses operator credentials/history.
