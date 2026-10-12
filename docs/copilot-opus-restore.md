# Copilot Opus 5.5 restore identity

Pi 0.84.4 can warn:

```text
Could not restore model github-copilot/claude-opus-5-5. Using <default model>
```

This is not evidence that `enabledModels` or the chosen model is misspelled.
Copilot's catalogue uses `claude-opus-5.5`, while the Anthropic-format response
reports `claude-opus-5-5` in `message_start.model`.

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

For an existing session that has already fallen back, explicitly choose
`github-copilot/claude-opus-5.5` once after loading the fix. The next Opus reply is
stored with the resolvable ID. Old session files are not mass-migrated, and a
first resume from an old final hyphenated reply can still show the warning.

`test/copilot-model-identity.test.js` reproduces the original failure using Pi's
actual in-memory SessionManager, then passes the compatibility hook through the
actual ExtensionRunner and proves the resulting session projection restores the
canonical ID. Only synthetic messages are used; no Copilot request is sent.
