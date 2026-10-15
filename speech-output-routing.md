# Focus and solo speech routing

Focus and solo are **temporary, session-wide local output overrides** shared by `/tts`, `/narrate`, `/read`, and spoken choices. They also cover native speak-replies, native force-speech, and cascade's local speech. They do not change synthesis providers, voices, startup settings, microphone routing, the full Realtime model's audio/chimes, or another Pi session's routing.

```text
/tts focus               # toggle
/tts focus on
/tts focus off
/tts focus status
/tts solo                # toggle
/tts solo on
/tts solo off
/tts solo status
```

These commands do **not** enable TTS/narration or change their on/off state. Precedence is **solo → focus → normal**. Turning solo off returns to focus if focus is still on, otherwise normal output. Turning focus off restores each surface's current normal settings, including changes made while focus was active.

Both modes require effective `backend=pulse` (Pulse aliases and `auto` resolving to Pulse also work). Focus may explicitly select Pulse over a different normal backend. Daemon-owned playback is excluded; use `provider=daemon playback=local` to synthesize remotely but route local PCM. Unsupported output fails explicitly rather than bypassing focus or secretly changing the provider. Pulse-aware `provider=command` clients receive `PULSE_SERVER`/`PULSE_SINK`; custom commands must honor those variables and wait for their playback to finish.

## Focus configuration

Configure an immutable startup overlay in `settings.json`:

```json
{
  "agentUtils": {
    "tts": {
      "backend": "pulse",
      "server": "sgu24:4713",
      "device": "vsink_voice",
      "focus": {
        "backend": "pulse",
        "server": "phone:4713",
        "sink": "vsink_focus",
        "pan": 0
      }
    }
  }
}
```

Supported focus fields are `backend`, `server`, `sink`/`device`, and `pan`—output routing, not model/voice controls. `sink` and `device` are aliases; if both are present they must agree. Omitted fields inherit the normal route; the default focus device is `vsink_focus`. Explicit `server: null` uses the local/default Pulse connection instead of inheriting `PULSE_SERVER`. `pan: null` omits stereo panning.

On focus activation, `pactl` checks the selected server and creates a missing named sink using `module-null-sink` (24 kHz stereo). Existing sinks are reused without modification. Concurrent creators reconcile the exact-name winner; if Pulse auto-suffixes our losing allocation, only that uniquely marked duplicate is rolled back. If another surface inherits a different server, its focused sink is checked on that server at playback admission. **Focus sinks are never unloaded**, including at focus-off, reload or shutdown: they may be shared. A solo sink deliberately reused as focus is likewise retained.

These are routing destinations, not automatically connected speakers. You configure your phone's/Pulse graph to send `vsink_focus` to the desired speaker. Agent Utils creates no loopbacks and never issues `set-default-sink` or moves unrelated streams.

## Solo identity and ownership

Solo uses the currently selected Pulse server when enabled (the focus server when applicable), and pins that server/sink until solo is disabled. Its display description is `pi - <agent name or session identity>`. Its internal ID resembles:

```text
pi_android_improvements_0123456789
```

The normalized readable stem is followed by a short hash of host/session/name to avoid collisions between similarly normalized names or distinct sessions. The sink name is bounded and Pulse-safe; display descriptions preserve printable names, including quotes and Unicode.

If the target already exists, solo borrows it and **never unloads it**. If Agent Utils creates it, the controller retains the returned module ID and a unique `agent.utils.solo.owner` property. Cleanup checks the sink name, owner marker, module ID, `module-null-sink` type and absence of active sink inputs before unloading that exact module. A replaced sink, reused index or foreign stream is not deleted. Only one solo allocation is retained per controller; unconfirmed old cleanup must be reconciled before changing its target.

## Switching and cleanup boundaries

Routing is selected when local playback is admitted. **Already-playing or machine-queued clips retain their selected route.** In-flight synthesis that has not yet requested playback uses the new route. Modes do not move streams between Pulse servers or cut off a clip mid-sentence.

An owned solo sink stays alive while any admitted playback lease references it, including a machine-queue job played by a peer process. `/tts solo off` changes the route for new requests immediately and reports cleanup pending until old leases settle. Last release triggers cleanup. If Pulse still reports streams, a short bounded reconciliation allows child/peer teardown to finish; otherwise the sink is retained with a warning. `/tts solo off` can retry pending cleanup. Focus remains untouched.

Reload/session shutdown stops the owning speech controllers before releasing their shared router and cleaning up solo. Modes start **off** in the new extension runtime; they are not written to `settings.json` or restored by automatically creating audio devices on startup. An abrupt process kill or unreachable Pulse server can leave a solo module behind. Unconfirmed create/unload responses are reconciled by reads, never by blindly repeating mutations or unloading an unverified ID.

## Implementation and validation

All Pulse operations use the installed `pactl` (with JSON listing support) with explicit argv, bounded time/output and the selected server. There is no shell interpolation or package installation. Module/property quoting is tested against actual PulseAudio. Module identity uses `pactl list short modules`, because PulseAudio 17's JSON module listing omits indices; IDs are never guessed from row order. Pulse 17 also emits `(null)` for non-ASCII JSON strings, so ownership relies only on ASCII IDs/markers and the integration test verifies Unicode descriptions through the text listing.

The shared session controller lives in `extensions/lib/speech-output-routing.js`; Pulse resource operations live in `extensions/lib/pulse-sinks.js`. Routing objects and credentials never enter the machine queue; only resolved output options do. See [acceptance](speech-routing-acceptance.json).

```sh
node --test test/speech-output-routing.test.js
# Hardware-free private Pulse server, unique Unix socket; no live audio graph:
PI_RUN_PULSE_ROUTING_SMOKE=1 node --test test/pulse-routing-integration.test.js
```
