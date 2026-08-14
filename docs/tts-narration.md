# Automatic assistant TTS and tool narration

Agent Utils separates two voice-output modes:

- `/tts` reads finalized plain assistant text verbatim.
- `/narrate` uses a cheap model to produce one-line first-person summaries before
  and after complete tool-call batches.

Neither mode requires the agent to call the `speak` tool.

## `/tts`: verbatim assistant messages

```text
/tts                 # enable
/tts off
/tts status
/tts voice=MAI-Voice-2 speed=2 style=hopeful styledegree=1.5
```

The extension listens to Pi's `message_end` lifecycle and joins only assistant
content blocks whose type is `text`. Thinking/reasoning blocks and tool-call
arguments are never spoken as verbatim assistant text. Each finalized message is
spoken exactly once.

Synthesis and playback reuse the same first-party direct Azure library, settings,
and defaults as `/read`:

- provider `azure`
- voice `MAI-Voice-2`
- embedding `0daec43c-911f-4529-820a-16dab73630d3`
- language `en-GB`
- speed `2`
- optional style/styledegree
- `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_API_KEY`
- Pulse output through `$PULSE_SERVER` and `$PULSE_SINK` / `@DEFAULT_SINK@`

The command accepts the same voice, embedding, language, endpoint/key, and
playback key/value settings as `/read`. Editor-only delay/on-send settings remain
owned by `/read` and are rejected by `/tts`.

The Pulse client/stream is named `/tts`. New synthesis aborts old synthesis and
terminates prior playback, so only one `/tts` voice is active and a newer agent
message always wins. Failures produce a warning but never block an agent turn.

`/tts` is off by default. Avoid enabling legacy `speak-replies` simultaneously,
since it is a separate historical auto-speech surface.

### Durable settings

Both modes support the standard `env > settings.json > default` precedence.
Explicit `/tts` and `/narrate` setters persist non-secret values by updating only
their own `agentUtils` slices. Environment overrides are never written back, and
API keys are never persisted.

```json
{
  "agentUtils": {
    "tts": {
      "enabled": true,
      "provider": "azure",
      "voice": "MAI-Voice-2",
      "lang": "en-GB",
      "speed": 2,
      "embedding": "0daec43c-911f-4529-820a-16dab73630d3",
      "style": null,
      "styleDegree": null,
      "backend": "pulse",
      "device": "@DEFAULT_SINK@",
      "speakToolEnabled": false
    },
    "narrate": {
      "enabled": true,
      "model": "github-copilot/gpt-5.6-luna",
      "speed": 2
    }
  }
}
```

Credentials remain in `AZURE_SPEECH_ENDPOINT` / `AZURE_SPEECH_API_KEY`; Pulse
server/sink environment overrides remain available. `PI_TTS_BACKEND` overrides
the TTS backend specifically; `PI_RT_AUDIO_BACKEND` no longer leaks into `/read`
or `/tts`. If TTS backend is `auto`, configured Pulse routing selects `pacat`,
otherwise it resolves to a local platform backend instead of erroring. Persisted `enabled: true`
activates the corresponding hook immediately when the extension loads.

The same `agentUtils.tts` slice is resolved by `/read`, automatic `/tts`, the
agent-callable `speak` tool, realtime speak-replies, and spoken choices.
`agentUtils.tts.speakToolEnabled=false` disables explicit speak-tool playback;
the tool is also automatically refused whenever `/tts` mode is on, preventing
duplicate speech. Per-call
`speak` overrides win, then `PI_CASCADE_*` / `PI_TTS_*` env, then this slice, then
the shared built-in defaults. These direct surfaces share interruptible `/tts`
playback where applicable; credentials are still never read from settings.

## `/narrate`: tool batches

```text
/narrate
/narrate model=github-copilot/gpt-5.6-luna
/narrate off
/narrate status
```

The default narration model is `github-copilot/gpt-5.6-luna`, overridable with
`PI_NARRATE_MODEL` or the runtime command. Narration normally inherits
`agentUtils.tts.speed`, but `agentUtils.narrate.speed`, `PI_NARRATE_SPEED`, or
`/narrate speed=2` applies a per-call speech-rate override without changing
verbatim `/tts` speed. Inference goes through Pi's first-party
`ctx.modelRegistry.complete` surface, which owns provider authentication; the
extension does not import the removed legacy `pi-ai` top-level `complete` export.

When an assistant message contains one or more tool calls, all sibling calls in
that assistant message form one batch—even when Pi executes them in parallel:

1. A non-blocking model request creates one short first-person preface beginning
   with “I am …” for the complete batch.
2. Pi executes tools normally; narration is never awaited by the tool lifecycle.
3. After every sibling emits `tool_execution_end`, one non-blocking request
   creates a short first-person outcome beginning with “I found …”, “I completed
   …”, or “I learned …”.
4. Each available narration is spoken immediately through the shared `/tts`
   speech controller. Newer speech interrupts older playback.

A newer tool batch or a final plain assistant answer aborts stale narration model
requests. Errors and unavailable narration models are warnings only.

### Conversation injection without a model turn

Each completed narration is appended with `pi.sendMessage` as a tagged custom
message:

```text
[tool summary][before] I am checking the configuration and current process state.
[tool summary][after] I found the service healthy and the configuration valid.
```

Delivery uses:

```js
{ deliverAs: "nextTurn", triggerTurn: false }
```

This is intentionally **not** a user message. It cannot steer or trigger the
in-flight agent, does not impersonate operator input, and becomes context only
with the next genuine user prompt. The explicit `[tool summary]` tag prevents the
next model from confusing narration with original tool output.

Tool arguments/results are bounded and common credential/token/secret fields are
redacted before they reach the narration model. The narration system prompt also
treats all tool data as untrusted and forbids literal secrets, raw URLs, code, or
long values.
