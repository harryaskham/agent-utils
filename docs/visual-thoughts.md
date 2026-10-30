# Visual thoughts

`extensions/visual-thoughts.js` paints the agent's work. While the agent thinks, replies and calls tools, a fast model turns its latest output into an image prompt, an image model paints it, and the images crossfade as a soft backdrop behind Pi's screen. Text stays on top; the backdrop never blocks the agent.

```text
/thoughts                 status: on/off, what it is doing, images, last prompt and error
/thoughts on|off|toggle   for this session
/thoughts now             paint from the current output now
/thoughts next            crossfade to the next image
/thoughts clear           drop the images (the files stay)
/thoughts opacity 0.4     change a setting for this session (see below)
```

It is off by default. Enable it at startup with `agentUtils.visualThoughts.enabled` or `PI_VISUAL_THOUGHTS=1`. Incognito sessions (`PI_INCOGNITO=1`) never paint.

## How it paints

- **What feeds it.** The run's prompt, streamed reasoning and reply text, and tool calls (names and redacted arguments) go into a bounded digest. Secrets are redacted as for `/narrate`.
- **When it paints.** The first image of a run needs `firstChars` of new output, later ones `minChars`, at least `minIntervalMs` apart, at most `maxPerRun` per run, one at a time. When the run ends, what is left paints once more. Rate limits wait for the provider's reset; other failures back off (15 s doubling to 5 min) and warn once.
- **The prompt.** `promptModel` (default `github-copilot/gpt-6-luna`, through Pi's model registry) writes one 20–45 word visual metaphor for the work: no text, code, screens or literal values; soft, low-contrast and mostly dark so text stays readable; varied from the last few prompts. `style` is appended as a house style.
- **The image.** `provider: "litellm"` posts to an OpenAI-compatible `/v1/images/generations` (`LITELLM_BASE_URL`, key from `LITELLM_MASTER_KEY`); `provider: "mai"` posts to `<maiEndpoint>/mai/images/generations` with an Entra token from `az` (or `maiAuth: "key"`).
- **The rotation.** Each run's images form a batch. The backdrop cycles the newest batch (each held `holdMs`, crossfaded over `fadeMs`); while it has fewer than `minSet` images the latest earlier ones join, so there is always recent imagery and a new run's images take over one by one. A new image is shown once the current one has had `minShowMs`.
- **Where images go.** `~/.local/state/agent-utils/visual-thoughts/<session>/` keeps each PNG and an `index.jsonl` of prompts (the newest `keep`). A reloaded or resumed session starts from its recent images.

Measured on 2026-10-30 (sandbox deployments, ~30-word prompts): `gpt-image-2.5-flare` at 1536×1024 `quality=low` ~14 s through LiteLLM; `MAI-Image-2.5-Flash` / `2.6-Flash` ~10 s at 768×768 and ~13 s at 1344×768 (768 px minimum per side), limited to 2 requests a minute per deployment; `gpt-image-2` / `2.5-sunburst` ~22 s; `gpt-image-1.5` ~28 s. The prompt model adds 2–5 s.

## Display

TUI Pi in fullscreen mode (`tuiMode: fullscreen`) on a Kitty-graphics terminal (Kitty, Ghostty, WezTerm). The backdrop is one image placed over the whole screen under the text, double-buffered so crossfade steps never flicker. Pi deletes every placement when its own images change and frees images on full redraws; the extension watches Pi's output and puts the backdrop back inside the same frame. Frames go to the terminal as files when it runs on this machine, else inline. tmux is not supported yet (`PI_VISUAL_THOUGHTS_TMUX=1` to try).

## Settings

`agentUtils.visualThoughts` in `settings.json` (startup policy; `/thoughts <key> <value>` changes the running session only; `hold`, `fade`, `interval` and `min-show` take seconds).

| Key | Default | |
|---|---|---|
| `enabled` | `false` | paint from startup |
| `promptModel` | `github-copilot/gpt-6-luna` | `provider/id` from Pi's registry |
| `provider` | `litellm` | `litellm` or `mai` |
| `imageModel` | `gpt-image-2.5-flare` | MAI: `MAI-Image-2.5-Flash` |
| `size`, `quality` | `1536x1024`, `low` | MAI: `1344x768` |
| `style` | | appended to every prompt |
| `opacity` | `0.3` | backdrop alpha |
| `fit` | `cover` | `cover`, `contain`, `stretch` |
| `feather` | `0.12` | edge fade, fraction of the shorter side |
| `layer` | `auto` | `over` cell backgrounds (tints panels), `under` them; `auto`: `under` in tmux |
| `holdMs`, `fadeMs` | `18000`, `3000` | |
| `minIntervalMs` | `12000` | between paintings |
| `firstChars`, `minChars` | `160`, `600` | new output needed |
| `maxPerRun`, `maxImages`, `minSet` | `10`, `8`, `3` | |
| `keep` | `48` | stored images per session |
| `transport` | `auto` | `file` or `stream` |

Environment: `PI_VISUAL_THOUGHTS`, `PI_VISUAL_THOUGHTS_PROMPT_MODEL`, `PI_VISUAL_THOUGHTS_IMAGE_MODEL`, `PI_VISUAL_THOUGHTS_PROVIDER`, `PI_VISUAL_THOUGHTS_OPACITY`, `PI_VISUAL_THOUGHTS_DIR`.
