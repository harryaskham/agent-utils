# Audio reel: explicit agent audio sharing

Agents can deliberately share audio — a song they made, a sound they are proposing, a before/after sample, a recording — with the operator. Shared clips land in a terminal **audio reel** player in the Pi session and in a durable per-machine archive that [`ag audio`, `ag sync` and the dashboard Audio tab](ag-audio.md) collect across the fleet.

This is a separate pathway from speech. `/tts`, narration, read-aloud and spoken choices never enter the reel or the archive, and the reel never touches the speech mute policy, the shared speech queue or the speech feed.

```text
♪ ▶ 2/5 Bossa riff in E minor (take 3)            ━━━━━━━━━━━●──────────────── 1:23 / 3:45
  1 intro sting  [2 Bossa riff in E m…]  3 rain loop  4 UI click  vol 100% · /audio-reel
```

## Sharing (agents)

`audio_share` takes exactly one source:

| Source | Parameters | Result |
| --- | --- | --- |
| File on disk | `path` (`~` and a leading `@` accepted) | Played and archived from the file; content-sniffed |
| Encoded bytes | `data` (base64 or `data:` URL), optional `mimeType` | WAV, MP3, OGG/Opus, FLAC, M4A/AAC, WebM/Matroska, AIFF, MIDI |
| Raw PCM | `data` + `pcm: {sampleRate, channels, encoding}` (or `mimeType: audio/L16`) | Wrapped as WAV. Defaults 24000 Hz, mono, `s16le`; also `s24le`, `s32le`, `f32le`, `u8`, 1–8 channels |

Optional `label`, `title`, `description` and `durationMs` are shown in the player and stored with the archive. `show` (default true) selects the clip in the widget; `play` (default **false**) starts it immediately, optionally with a one-off `output`. Inline data is limited to 64 MiB decoded and archived clips to 256 MiB. The tool result is a short text receipt; audio bytes never enter model context.

`audio_reel` controls the same player: `status`, `play [index, position]`, `pause`, `resume`, `toggle`, `stop`, `next`, `previous`, `seek (position, relative)`, `volume (0–150)`, `output`, `repeat (off|one|all)`, `show`, `hide`, `remove [index]`, `clear`. `index` is zero-based. Removing or clearing never deletes archive copies.

## Playing (operators)

`/audio-reel` (alias `/audio-player`) opens the interactive player docked at the bottom of the terminal. `/audio` itself belongs to the audio-providers configuration command.

| Key | Action | Mouse |
| --- | --- | --- |
| `↑`/`↓`, `j`/`k`, PgUp/PgDn, `g`/`G` | Select clip | Click a row to play it; click the playing row to pause; wheel scrolls |
| `Enter` | Play selected | |
| `Space`, `p` | Play / pause | `[▶ play]` / `[‖ pause]` |
| `←`/`→`, `h`/`l` | Seek ∓5 s | `[‹ 5s]` / `[5s ›]`; wheel over the progress bar |
| `H`/`L`, Shift-←/→ | Seek ∓30 s | Click anywhere on the progress bar |
| `[` `]` (or `<` `>`) | Previous / next clip | `[« prev]` / `[next »]` |
| `+`/`-` | Volume ±5 % | `[−]` / `[+]`; wheel over the controls row; click the level to mute |
| `m`, `s`, `r` | Mute, stop, cycle repeat | `[repeat …]` |
| `x`, Delete | Remove from the reel | |
| `Esc`, `q` | Close (playback continues) | `✕ close` |

Mouse input works in fullscreen and regular modes: in regular mode the overlay enables SGR mouse reporting only while it is open and restores the previous terminal mode afterwards. Kitty CSI-u keys are understood; key releases and pastes are ignored.

Slash commands cover everything without the overlay:

```text
/audio-play [n|name]      /audio-pause   /audio-resume   /audio-toggle   /audio-stop
/audio-next   /audio-prev /audio-seek 90 | 1:23 | +10 | -5 | 50%
/audio-volume 80 | +10 | -10 | mute      /audio-repeat [off|one|all]
/audio-output [backend=pulse|sox|ffplay|auto] [server=tcp:host:4713] [sink=name] | reset
/audio-add <path> [label]                 /audio-remove [n|name]
/audio-show   /audio-hide   /audio-clear  /audio-status
```

`/audio-add` is an explicit operator share: the clip joins the reel and is archived like an agent share. Volume, repeat, output routing and operator edits persist in the session (custom entries); agent shares persist through their tool results. On restart the active branch's latest reel is restored without autoplay, preferring the durable archive copy when a scratch file has gone and dropping clips missing from both.

## Output routing

Default playback follows the standard output graph: **Pulse** (`pacat`) on Linux and whenever Pulse is routed, honouring `PULSE_SERVER` and `PULSE_SINK`; CoreAudio via `ffplay` on an unrouted Mac. Precedence, highest first:

1. a one-off `output` on `audio_share play=true` or `audio_reel action=play`;
2. the reel default from `/audio-output` or `audio_reel action=output`;
3. `PI_AUDIO_BACKEND`, `PI_AUDIO_SERVER`, `PI_AUDIO_SINK`;
4. `PULSE_SERVER`, `PULSE_SINK`, then the platform default.

`server=default`/`sink=default` explicitly select the local default (ignoring inherited `PULSE_*`); `inherit` removes an override; `reset` clears them all. Backends: `pulse` (also `pacat`, `paplay`, `pipewire`), `sox` (`play`, device via `AUDIODEV`) and `ffplay` (`coreaudio`). Each clip is a named Pulse stream (`pi audio reel` / clip label), so it can be moved or muted per stream in any mixer.

PCM16 mono/stereo WAV — including every raw-PCM share — streams natively with no extra dependency. Other formats need `ffmpeg` (decode) and, for duration display, `ffprobe`. Pause, seek, volume and routing changes restart the owned pipeline at the tracked position. Failures (missing binaries, refused Pulse servers, undecodable files) show the decoder or sink's own stderr in the widget and a warning; nothing retries in a loop.

## Archive and privacy

Archived clips follow the shared-image contract so `ag` can sync them with rsync and validate them without a remote `ag`:

```text
$XDG_STATE_HOME/agent-utils/audio/<agent>/aud-<share-id>.<ext>
$XDG_STATE_HOME/agent-utils/audio/<agent>/aud-<share-id>.<ext>.json   # commit marker
```

Sidecars are version 1 with `id`, `sha256`, `mimeType`, `bytes`, `timestamp`, `agent`, `session`, `host`, `cwd`, `source {kind, tool, eventId, index, path, label}` and optional `title`, `description`, `durationMs`, `sampleRate`, `channels`. Files are `0600`, published atomically, and idempotent per share event. `PI_SHARED_AUDIO_DIR` overrides the root; `PI_SHARED_AUDIO_ENABLED=0` disables archiving and `PI_INCOGNITO=1` always does. With archiving off the reel still works from a private session scratch copy (`$TMPDIR/pi-audio-reel-<uid>/<session>`, override `PI_AUDIO_REEL_SCRATCH_DIR`). `PI_AUDIO_REEL_PLACEMENT=aboveEditor` moves the widget above the editor.

No AHP capability is advertised: the current Paratenic bridge has no attachment/resource registration, so clips stay local to Pi until `ag` collects the archive.

## Source and tests

- `extensions/audio-reel.js` — tools, commands, widget, overlay and session persistence.
- `extensions/audio-reel/{playback,state,view}.js` — pipeline, pure state/parsing, rendering and hit-testing.
- `extensions/lib/shared-audio.js` — sniffing, PCM→WAV, WAV parsing, archive publication.
- `test/shared-audio.test.js`, `test/audio-reel-playback.test.js`, `test/audio-reel.test.js` — codecs and archive, pipeline lifecycles with scripted processes, widths/keys/mouse, restore, routing and the extension surface; `test/ag-artifacts.test.js` reads real extension output with the real `ag` binary (`AG_TEST_BIN`).
- Acceptance contract: [`ag/audio-acceptance.json`](../ag/audio-acceptance.json). Real-Pi captures: [overlay](assets/ag/audio/pi-reel-overlay-110x32.txt), [widget](assets/ag/audio/pi-reel-widget-110x32.txt).
