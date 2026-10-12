# Named audio providers

Configure a connection once under `agentUtils.audio.providers`, then select its
name from each speech surface. A provider has a stable name and a transport
`type`: `azure`, `openai`, `daemon` or TTS-only `command`. `/stt provider=auto`
retains its existing automatic Azure/OpenAI selection.

```json
{
  "agentUtils": {
    "audio": {
      "providers": {
        "azure": {
          "type": "azure",
          "auth": "entra",
          "az": "az-token",
          "endpoint": "https://YOUR-RESOURCE.cognitiveservices.azure.com"
        },
        "azure-work": {
          "type": "azure",
          "auth": "entra",
          "az": "az-token",
          "tenant": "YOUR-WORK-TENANT",
          "endpoint": "https://WORK-RESOURCE.cognitiveservices.azure.com"
        },
        "openai": {
          "type": "openai",
          "endpoint": "https://api.openai.com/v1",
          "apiKeyEnv": "OPENAI_API_KEY"
        }
      }
    },
    "tts": { "provider": "azure" },
    "stt": { "provider": "azure", "model": "mai-transcribe-2" }
  }
}
```

**This is an example, not an automatic migration.** Existing settings files,
managed symlinks, legacy `tts.providers.azure` / `stt.providers.azure` fields,
environment configuration and saved session overrides continue to work. No
current Collective or Pebble configuration is rewritten by the extension.

## Selecting and changing providers

```text
/audio
/audio settings
/audio settings azure
/audio azure auth=entra az=az-token
/audio azure-work type=azure auth=entra az=az-token endpoint=https://WORK-RESOURCE.cognitiveservices.azure.com
/audio azure-work stt.deployment=my-mai-deployment
/audio azure-work reset
/audio reset

/tts provider=azure-work
/read provider=azure-work
/narrate provider=azure-work
/stt provider=azure-work
/ptt provider=azure-work
```

The `/stt` and `/ptt` commands retain their existing capture/start behavior—use
`/audio` to inspect or change connection settings **without opening a mic**.
`/audio settings` uses Pi's standard provider/field selector and text input;
Escape cancels without committing a partial new provider. It never calls an
upstream provider or acquires a token just to inspect configuration.

Choices use the named provider selected by the startup `agentUtils.tts.provider`
(or `PI_TTS_PROVIDER`), as before. Changes to that provider's connection through
`/audio` are seen by readback, TTS, narration, choices, cascade and STT on their
next request. Selecting another name on `/read` is local to readback; it does not
silently redirect other surfaces. Use the same name where shared configuration
is wanted. Voices, models, per-surface speed, playback mode, pan, Pulse routing,
queue policy, enable flags and `/narrate model=` retain their existing meanings.

`/audio` edits are session-only, stored as non-model-context
`audio-runtime-settings` entries; they survive reload/restart without writing
`settings.json`. Runtime `none` removes an override, exposing startup/env policy
again. `reset` removes provider overrides, not the provider's startup definition.
Use a new name to change transport type while surfaces are bound to an existing
provider. Runtime state is isolated per Pi event bus, shared across its extension
facades, and released with the session—not a process-global selection.

## Connection fields and precedence

Common connection fields:

- `type`, `endpoint`;
- Azure: `auth` (`entra` or `key`), `az`, `resource`, `tenant`, `subscription`,
  TTS `resourceId`, MAI STT `deployment`;
- OpenAI/key authentication: `apiKeyEnv`, naming an environment variable;
- daemon: `daemonUrl`, `daemonProvider`, `tokenFile`;
- command TTS: `command` (an operator-configured command, as previously supported).

Use `tts` and `stt` objects to override fields for one capability. For example:

```json
{
  "type": "daemon",
  "tts": { "daemonUrl": "http://helsinki:7633" },
  "stt": { "daemonUrl": "http://helsinki:7634" }
}
```

The command uses snake-case aliases (`api_key_env`, `resource_id`, `daemon_url`,
`daemon_provider`, `token_file`) and accepts `tts.<field>` / `stt.<field>`.
Provider and field validation is bounded; inline API keys, credential-bearing
URLs and unknown fields are refused. An explicit `apiKeyEnv` that is missing
fails rather than falling through to another account's global key. Status only
shows the variable name, never its value. OpenAI remains key-based; Azure can use
either key mode or Entra. Configuring Azure does not change OpenAI auth.

For built-in names (`azure`, `openai`, `daemon`, `command`), existing legacy
settings supply fallback connection values. Shared-provider fields override them;
existing per-surface/shared environment overrides retain their precedence;
`/audio` runtime edits win last. An unconfigured built-in name uses the original
legacy resolution path unchanged. A partial `/audio azure az=...` edit therefore
keeps the legacy endpoint and Entra policy rather than resetting them.

Custom names (`azure-work`, etc.) use their own connection definition and runtime
patches, not the default Azure connection/environment identity. A configured
provider is authoritative for connection fields: stale fields captured by another
surface do not override it. Legacy `/read az=...` and similar commands remain
valid for unconfigured legacy providers; when a shared provider owns that name,
those auth edits point to `/audio <name> ...` instead of creating a competing
per-surface override. Existing saved overrides are retained, not stripped.

Requests already admitted keep their resolved connection; later requests see
updates. No in-flight playback cancellation or implicit replay is introduced.

## Azure resource URLs and Pebble

A single Azure resource base URL works for both capabilities:

- TTS uses `/tts/cognitiveservices/v1` on the resource custom domain;
- MAI STT uses the corresponding `services.ai.azure.com` host and
  `/mai/v1/audio/transcriptions`.

For Azure resource hosts, the STT resolver also accepts `/stt`, `/tts`, and
`/tts/cognitiveservices/v1` suffixes, removing the surface suffix before deriving
the MAI URL. Non-Azure proxy prefixes are preserved. This fixes the prior
`/stt/mai/v1/audio/transcriptions` 404 without requiring a config rewrite.

Pebble and other direct callers of the Azure primitives retain their explicit
`auth`, `az`, endpoint and environment options. They are not forcibly enrolled in
Pi's provider registry. Named dispatch opts into it with `providerName` (or a
custom `provider` name). The existing shared Entra token broker still performs
bounded, expiry-aware acquisition; MAI always gets a raw bearer, not the Speech
`aad#resourceId#token` form. Full multimodal `/rt` WebSocket auth remains separate.

## Validation

`test/audio-providers.test.js` covers legacy fallbacks, named selection, separate
OpenAI keys and Azure Entra, request admission, shared TTS/read/choice controllers,
cascade, direct/Pebble calls, STT URL/deployment resolution, per-session isolation,
secret rejection, persistence and late-dialog cancellation. Run
`npm run test:audio-ui` for an isolated real Pi PTY test of settings select/input,
Escape, named edits, `/reload` restore, unchanged provider startup config and
terminal cleanup. No model, broker, mic or playback calls occur in the PTY test.
