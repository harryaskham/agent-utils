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
It verifies the dotted request/selected ID and no restore warning or prompt replay.
It passed with both Pi 0.84.4 and 1.1.0; `PI_BIN` can select a runtime. The test
never connects to GitHub or uses operator credentials/history.
