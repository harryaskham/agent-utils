# TTS dashboard review — ag 0.5

Direction: compact, technical, quiet. Retain the existing dashboard's green/neutral palette and compact navigation. Speech is a full-height list: metadata rail, plain message, subtle divider; no cards, playback controls, or explanatory subtitle.

Baseline: `../fleet/choices-dark-1440x900.png` (existing dashboard styling).

| Capture / test | Finding | Action / result |
|---|---|---|
| 1440×900 dark | Existing neutral surfaces and green accent carry across; mono timestamp/host/kind and bold agent stay distinct from plain body text. | Retained shared tokens; no component-specific colors or external fonts. |
| First 320×480 pass | Header minimum width exceeded the viewport by 14 px after adding the fourth tab. | Constrained the grid column and reduced compact tab padding; recaptured, no horizontal overflow at 320 or 390. All tabs and theme/refresh controls remain reachable. |
| Paused 1440×600 | Older rows remained at their scroll position while a new event arrived. | Verified DOM content stays unchanged, “Live · 1 new” appears, and the button restores the tail. |
| Offline browser | Existing HTTP stream could outlive Chromium's simulated offline transition, leaving the status falsely live. | Added browser offline/online lifecycle handling. Offline closes the EventSource; online resumes with the last event ID. Verified no duplicate entry. |
| 390×844 light | Filters wrap deliberately, search gets its own line, all nodes/kinds/follow actions fit. Long speech wraps naturally. | Retained the compact layout; metadata remains readable and body reaches the lower scroll edge. |
| 320×480 and 1440×420 light | Short working viewport still has a reachable final row and focused controls; the top edge may show the remainder of a scrolled message. | Expected scroll clipping, not hidden/unreachable content. Independent TTS scrolling remains intact. |
| Hostile-text fixture | Literal HTML/script-looking speech is visible as text. | No image/script elements or executed payload; ordinary DOM `textContent` only. |
| Keyboard / reconnect | Arrow navigation works through all four tabs. Filters, paused state and cursor survive leaving the TTS tab. | Verified subscriber release and resumed history, while backend collection continued with zero viewers. |

## Evidence

`receipt.json` is from the isolated actual ag binary plus headless Chromium. Twelve real file-append-to-visible samples: p95 (nearest-rank maximum for 12 samples) **287.4 ms**, all below the 1,500 ms budget. Render invalidations are batched at 100 ms. No browser page errors; SIGTERM returned cleanly and the listener closed.

Screenshots are entirely synthetic. No operator feed, token, live node or account was used. The browser bootstrap token was exchanged before capture and is not persisted in the artifacts. The separate Rust boundary tests cover both local and SSH-backed tails, file rotation, replay, reset, 32-client limits, byte/count bounds, unauthorized requests, stalled viewers and child-process cleanup.

Intentional limits: this is request-text monitoring, not audio playback or proof of audible completion; the view is bounded recent history rather than an archive. Server resets and per-entry shortening are visible, and full original feeds remain on their source nodes.
