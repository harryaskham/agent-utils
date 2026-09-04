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
/tts --harry            # Harry embedding, retaining this session's stereo pan
/tts prefix='Agent: ' suffix=' End.'
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
playback key/value settings as `/read`. Optional `prefix` and `suffix` wrap only
the text sent to speech synthesis. They support safe shell-style environment
expansion, for example `/tts prefix="$AGENT_ID"`; command substitutions are never
executed. `PI_TTS_PREFIX` and `PI_TTS_SUFFIX` override durable values. Editor-only delay/on-send settings remain
owned by `/read` and are rejected by `/tts`.

The Pulse client/stream is named `/tts`. New synthesis aborts old synthesis and
terminates prior playback, so only one `/tts` voice is active and a newer agent
message always wins. Failures produce a warning but never block an agent turn.

`/tts` is off by default. Avoid enabling legacy `speak-replies` simultaneously,
since it is a separate historical auto-speech surface.

At `session_start`, `/tts`, `/narrate`, `/read`, and spoken interactive choices hash Pi's stable session ID to choose
one voice from `agentUtils.tts.voices` and one constant-power stereo position
within `agentUtils.tts.panRange` (default `-0.9..0.9`). The assignment remains
stable for the session and differs independently across sessions. The built-in
pool is the reviewed MAI-Voice-2-Flash list from Cacophony, excluding quarantined
aliases. `PI_TTS_VOICES`, `PI_TTS_PAN_MIN`, and `PI_TTS_PAN_MAX` override policy.
All four surfaces therefore retain the same audible identity for one session.

Start Pi with `--harry`, or run `/tts --harry` or `/narrate --harry`, to retain
the session's stereo position while selecting `MAI-Voice-2-Flash` with Harry's
`0daec43c-911f-4529-820a-16dab73630d3` embedding.

### Durable settings

Both modes support the standard `env > settings.json > default` precedence.
`settings.json` is immutable startup policy. Every `/tts` and `/narrate`
`setting=value` change—including voice, model, speed, affixes, and narration-text
policy—is a runtime-only override, just like `on|off`; commands never rewrite the
file. Environment overrides are also runtime-only, and API keys are never
persisted. To change the next startup, edit the corresponding `agentUtils` slice
explicitly.

```json
{
  "agentUtils": {
    "tts": {
      "enabled": true,
      "provider": "azure",
      "voice": "MAI-Voice-2",
      "voices": [
        "en-US-Harper:MAI-Voice-2-Flash",
        "en-US-Iris:MAI-Voice-2-Flash",
        "en-US-Jasper:MAI-Voice-2-Flash"
      ],
      "panRange": { "min": -0.9, "max": 0.9 },
      "lang": "en-GB",
      "speed": 2,
      "embedding": "0daec43c-911f-4529-820a-16dab73630d3",
      "style": null,
      "styleDegree": null,
      "backend": "pulse",
      "device": "@DEFAULT_SINK@",
      "prefix": "",
      "suffix": ""
    },
    "narrate": {
      "enabled": true,
      "model": "github-copilot/gpt-5.6-luna",
      "speed": 2,
      "style": "excited",
      "styleDegree": 1.6,
      "textEnabled": false,
      "reasoningSummaries": true,
      "prefix": "",
      "suffix": ""
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

The same `agentUtils.tts` slice is resolved by `/read`, automatic `/tts`,
realtime spoken replies, and spoken choices. Agent Utils does not expose an
agent-callable `speak` tool; speech is controlled by those explicit runtime
surfaces instead. `PI_CASCADE_*` / `PI_TTS_*` environment values override this
slice, followed by shared built-in defaults. These direct surfaces share
interruptible `/tts` playback where applicable; credentials are still never
read from settings.

## `/narrate`: tool batches

```text
/narrate
/narrate model=github-copilot/gpt-5.6-luna
/narrate style=excited styledegree=1.6
/narrate prefix="$AGENT_ID: " suffix=" done"
/narrate reasoning_summaries=true
/narrate text=false       # keep speech; omit retained text/context summaries
/narrate off
/narrate status
```

The default narration model is `github-copilot/gpt-5.6-luna`, overridable with
`PI_NARRATE_MODEL` or the runtime command. Narration normally inherits
`agentUtils.tts.speed`, but `agentUtils.narrate.speed`, `PI_NARRATE_SPEED`, or
`/narrate speed=2` applies a per-call speech-rate override without changing
verbatim `/tts` speed. `prefix` and `suffix` independently wrap narration speech
without changing retained summary text; `PI_NARRATE_PREFIX` and
`PI_NARRATE_SUFFIX` override settings. Inference goes through Pi's first-party
`ctx.modelRegistry.complete` surface, which owns provider authentication; the
extension does not import the removed legacy `pi-ai` top-level `complete` export.

When an assistant message contains one or more tool calls, all sibling calls in
that assistant message form one batch—even when Pi executes them in parallel.
Before tools run, narration uses this preference order:

1. The main model's native visible reasoning-summary `thinking` block when
   `reasoningSummaries` is enabled (the default).
2. The main model's plain-text tool preamble.
3. A non-blocking request to the configured narration model using the isolated
   sanitized tool-batch payload.

This lets GPT-5.6 Responses reasoning summaries benefit from the main agent's
full context and avoids a redundant before-model call. `/narrate
reasoning_summaries=false` disables only the first preference for the current
session; `PI_NARRATE_REASONING_SUMMARIES` overrides the immutable startup value.
Redacted thinking blocks are never narrated, and reasoning-summary reuse is
restricted to OpenAI/Azure Responses messages so raw thinking from other
provider protocols is never mistaken for a shareable summary. When `/tts` and `/narrate` are both
enabled, `/narrate` owns tool-batch preambles so they are spoken only once.

Pi executes tools normally; narration is never awaited by the tool lifecycle.
After every sibling emits `tool_execution_end`, one non-blocking request creates
a short natural outcome. Prompts ask for varied, non-formulaic sentence
structure rather than forcing every message to begin with “I am” or “I found.”
Each available narration is spoken immediately through the shared `/tts` speech
controller; newer speech interrupts older playback.

A newer tool batch or a final plain assistant answer aborts stale narration model
requests. Errors and unavailable narration models are warnings only.

### Optional conversation injection without a model turn

Set `agentUtils.narrate.textEnabled=false`, `PI_NARRATE_TEXT_ENABLED=0`, or run
`/narrate text=false` to keep spoken narration while omitting transcript and
next-turn context entries entirely. The setting uses `env > settings > true`;
the runtime setter changes this preference for the current session only.

When text is enabled, each completed narration is appended with `pi.sendMessage`
as a tagged custom message:

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
