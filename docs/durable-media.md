# Media sharing in pi-daemon sessions

`extensions/durable/media.mjs` is a pi-daemon extension module that lets agents in
Durable sessions share images and audio with the operator, as interactive Pi agents do
with Agent Utils' sharing tools:

| Tool | What it does |
| --- | --- |
| `image_share` | Shares an image file or base64 image with the operator. |
| `audio_share` | Shares an audio file, base64 audio or raw PCM (wrapped as WAV), and can also play it on the host. |
| `tendril_capture` | Captures a Tendril window or display, returns it to the model to look at, shares it with the operator, or both. |

Shared media is stored with the session and shown by every client: Culture, `/web` and
caco TUI's Culture embed show images inline and play audio. The model sees only the
tool's text, except for a capture it asked to look at.

## Installing

The flake exports the module beside [`tts.mjs`](durable-tts.md):

```sh
nix build github:harryaskham/agent-utils#durable-extensions
ls result/media.mjs
```

List `${pkg}/media.mjs` under a pi-daemon profile's `extensions:`:

```nix
services.pi-daemon.profiles.work = {
  cwdRoots = [ "~/work" ];
  extensions = [
    "${inputs.agent-utils.packages.${system}.durable-extensions}/tts.mjs"
    "${inputs.agent-utils.packages.${system}.durable-extensions}/media.mjs"
  ];
};
```

Sharing needs pi-daemon with session media (AHP-MEDIA). The module is plain JavaScript
over Agent Utils' shared libraries and needs only Node built-ins. It never imports a Pi
TUI API.

## How sharing works

Each tool returns the media in its result's `details.media`:

```js
{
  content: [{ type: "text", text: "Shared image \"Chart\" (image/png, 41 KiB) with the operator." }],
  details: { media: [{ path: "/work/chart.png", mimeType: "image/png", title: "Chart", description: "…" }] },
}
```

pi-daemon stores each item in the session's media, shows it to AHP clients as a
`contentRef` response part readable with `resourceRead`, and sends ACP clients a
`resource_link`. A file is shared by its absolute path; inline data is shared as base64.
One item holds at most 2 MiB. A larger item is refused, and the result says why.

## The tools

### `image_share`

```text
image_share { path: "chart.png", title: "Weekly totals", description: "…" }
image_share { data: "<base64 or data: URL>", label: "render" }
```

Give exactly one of `path` or `data`. A relative path is resolved from the session's
directory, and `~` and a leading `@` are accepted. The type is detected from the bytes
(PNG, JPEG, GIF, WebP, BMP), falling back to `mimeType` or the file extension (for
example SVG). The title is `title`, then `label`, then the file name.

### `audio_share`

```text
audio_share { path: "mix.mp3", title: "Draft mix" }
audio_share { data: "<base64 PCM>", pcm: { sampleRate: 24000, channels: 1, encoding: "s16le" } }
audio_share { path: "sample.wav", play: true, output: { sink: "desk" } }
```

The parameters match the interactive `audio_share` tool:

- Files can be WAV, MP3, OGG/Opus, FLAC, M4A/AAC, WebM, AIFF or MIDI.
- `data` holds encoded file bytes, or raw PCM when `pcm` is set or `mimeType` is
  `audio/L16`. Raw PCM is wrapped as WAV, so clients receive a playable file.
- `play: true` also plays the clip on the session's host through the
  [audio reel](audio-reel.md)'s playback engine. Output follows `output`, then
  `PI_AUDIO_*`, then `PULSE_SERVER`/`PULSE_SINK`. On Linux the package records an
  absolute `pacat`. Formats other than 16-bit WAV need `ffmpeg` on the worker's
  `PATH`. A playback failure is reported in the result, and the clip is still shared.

There is no reel in a Durable session. Clients play what is shared.

### `tendril_capture`

```text
tendril_capture {}                                   # look at the first capture-capable display
tendril_capture { target: "Firefox", mode: "share", title: "Login page" }
tendril_capture { kind: "display", target: "2", mode: "both", maxWidth: 1200 }
```

- `mode: "look"` (the default) returns the screenshot as image content for the model.
  pi-daemon also shows a result's image content to clients.
- `mode: "share"` returns it only in `details.media`, so it reaches the operator and not
  the model's context.
- `mode: "both"` does both.

With a target, `kind` defaults to `window`. Without one, the tool captures the first
capture-capable display. Targets resolve as they do for the interactive `tendril_pi_*`
tools, through the same capture core. Captures are limited to 1600 px wide unless
`maxWidth` is set, so a shared screenshot stays under the 2 MiB item limit.

The worker's `AGENT_UTILS_TENDRIL_COMMAND`, `AGENT_UTILS_TENDRIL_REMOTE` and
`AGENT_UTILS_TENDRIL_WSL_TUNNEL` choose the bridge, and `remote` and `wslTunnel`
override them for one call. Tendril itself runs through the session's environment, in
its directory, so `PATH` and other values from the profile's and the session's env files
apply to it. Screenshots are written under
`$TMPDIR/pi-durable-media/`, or `TENDRIL_SHARE_SCREENSHOT_DIR` when it is set
(resolved from the session's directory).

## Archive receipts

As in interactive Pi, every share is also archived on the machine for `ag gallery`,
`ag audio` and `ag sync`:

- images, including captures, under `~/.local/state/agent-utils/images/<agent>/`
  (`PI_SHARED_IMAGES_DIR`);
- audio under `~/.local/state/agent-utils/audio/<agent>/` (`PI_SHARED_AUDIO_DIR`).

Each file has a provenance sidecar written last. The result's `details.sharedImages` or
`details.sharedAudio` lists the receipts. `PI_INCOGNITO=1`,
`PI_SHARED_IMAGES_ENABLED=0` or `PI_SHARED_AUDIO_ENABLED=0` turns archiving off, and
media is still shared with the session.

The agent name comes from the worker's environment (`CACO_AGENT_NAME`,
`CACO_SHORT_NAME` or the Cacophony identity), else `pi-daemon-<directory name>`.
pi-daemon does not tell a tool which session called it, and every session's root chat
is conversation `1`, so a receipt's `session` is `<directory>-<hash of its path>:<conversation>`
and its `cwd` is the session's directory. Sessions in different directories are filed
apart; sessions sharing a directory share a folder.

## Testing

`test/durable-media.test.js` runs the tools against a fake Durable host. It checks
`details.media` and the model's text, PCM-to-WAV conversion, archive receipts,
capture image content, and Tendril through a fake ExecutionEnv. It also checks that the
module graph imports only Node built-ins.
