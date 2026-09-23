# Choice layout review

Direction: compact, legible, keyboard-first. Reuse Pi's theme, numbered rows and selected marker; align wrapped text under its first line. Use line ranges for scroll position, not explanatory subtitles.

## Rendered evidence

The final captures replay **real Pi 0.84.4 PTY output** in xterm.js 6.0.0 inside an isolated Playwright browser. They are not HTML approximations of the layout. The before image renders the prior choice component through the same terminal renderer. All content is a deterministic public fixture; no operator session, model call, speech service or production configuration was used.

| State | Evidence | Finding / correction |
| --- | --- | --- |
| Before, 80×30 | [Image](assets/choices/before-80x30.png) | Question and descriptions ended in hard ellipses. Longer text was unreachable. |
| Expanded, dark 80×30 | [Image](assets/choices/expanded-80x30.png) | Complete visible lines wrap under aligned option numbers. Five-row regions show ranges for hidden text. Initial review exposed the suspended editor below the modal; final rendering covers the viewport and anchors controls at the bottom. |
| Narrow, 40×20 | [Image](assets/choices/narrow-40x20.png) | Wrapped text stays inside the terminal; list viewport follows the selected option. Shortened footer keeps `? help` visible rather than truncating it. |
| Short, 40×10 | [Image](assets/choices/short-40x10.png) | Question height yields to option content. Question, option text and list ranges show independently reachable remaining content. No line overflows the terminal. |
| Light, 80×30 | [Image](assets/choices/light-80x30.png) | Same geometry with theme-owned colors. Descriptions now use the normal text role rather than low-contrast dim text. |
| Scrolled description | [Image](assets/choices/scrolled-80x30.png) | Reading later description lines preserves the selected option and question offset. |
| Compact | [Image](assets/choices/compact-80x30.png) | Intentional abbreviated titles/descriptions; `v` restores full readable text. The preference survives the next choice without changing selection. |

## Reproduce

```sh
npm run test:choice-ui -- --out /tmp/choice-ui-evidence
npm run test:choice-ui -- --theme light --out /tmp/choice-ui-light
npm run test:choice-ui -- --tui-mode regular --out /tmp/choice-ui-regular
node --test test/choice-layout.test.js test/choice-preferences.test.js \
  test/choice-audio-cache.test.js test/incognito-artifacts.test.js test/choice.test.js
```

`PI_BIN` or `--pi` selects the installed Pi executable. The PTY harness uses a temporary HOME/config/state directory and an owner-private Unix inspection socket. It exercises real keyboard navigation, independent question/detail scrolling, view persistence, mouse wheel, resize, freeform return and final selection. It verifies process/socket/terminal-mode cleanup and writes bounded ANSI streams plus semantic frame receipts. This ran in dark/light fullscreen and dark regular mode (six captured states each).

The inspection fixture calls the real extension tool and its modal; it does not maintain another choice reducer. The ordinary runtime exposes no QA socket. Pure tests cover tiny/zero geometry, Unicode/graphemes, stale mouse hitboxes, end-of-content reachability, managed preference symlinks and a cached-redraw p95 budget of 10 ms for a nine-option long-text fixture.

Intentional tradeoffs: long text uses bounded independent regions rather than expanding off screen; compact mode abbreviates content by explicit operator choice. Command-provider speech remains uncached because those commands do not return PCM to Pi. Native choice audio is RAM-only and expires with the choice.
