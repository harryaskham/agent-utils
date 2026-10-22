# ag 0.7 dashboard review (pi-daemon sources, health, media controls)

Captured 2026-10-22 from a local `ag dash` (debug build of this change) against four
live nodes (ms-mac, aurora, sonance, sgu24), with temporary image/audio caches. Only
the agent's own test questions were answered.

| File | What it shows |
| --- | --- |
| `health-1300.png` | Health cards with the new `pi-daemon` and `pi-bridge` rows (version from `/readyz`, sessions/TUI Pis, waiting). Paratenic is optional: `○ … optional` when not running (ms-mac timed out, sgu24 not listening). sonance's pi-daemon 1.10 bridge has no `/ahp` and says which version fixes it; sgu24's configured bridge is not listening. Image and audio rows read the dash's own caches; nodes that never archived audio are synced and empty. |
| `choice-answered-1300.png` | A pi-daemon session's `async_choice`, answered by clicking an option in Chromium: "Answered", and the agent received the answer. |
| `images-paused-1300.png` | Images with **Resume auto-refresh** pressed and **Load new images** offered while a newer sync waits; the framed gallery kept its search. Per-node sync status collapsed by default. |
| `images-paused-390.png` | The same at 390 px: the status wraps above the buttons. |
| `audio-paused-1300.png` | Audio paused the same way; the pi-daemon session's `audio_share` clip (`pi-daemon-agent-utils`) is listed. |

Checks performed:

- Pause: the iframe `src` stayed on the old sync while two newer syncs completed; the
  status read "auto-refresh paused · newer images waiting"; Resume framed the newest sync.
- Sticky collapse: opening the node list stored `ag.gallery.nodes.open=1`; the re-framed
  gallery opened it again. Filters (`search`, node, agent) survived the re-frame
  (sessionStorage, per tab).
- No console errors.
