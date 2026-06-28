# Session summary — realtime status: render live audio input level (show audio input)

## Goal

Deliver the final consumer wiring for Harry's "show audio input" ask. In the
coordinated multi-agent realtime/STT display effort, the data side
(session.inputLevel) and the shared meter formatter landed from peers, and both
peers explicitly handed the realtime-status.js render to me so the live input
level would actually appear in the rt/STT status panel rather than being
computed but never displayed.

## Bead(s)

- `bd-65cbbd` — (earlier this session, landed 84bf9bb) connection/reconnect +
  error visibility in the status panel.
- This slice's bead — render live audio input level in micCaptureSummary.
- Peer deps consumed: ms2-2 `bd-421f65` (session.inputLevel data, dd4c091),
  msm-2 shared meter `realtime-audio-meter.js` (e28e1c1).

## Before state

- Failing tests: none (full suite green at slice start).
- micCaptureSummary showed only `<mode> active · <N> bytes` — a raw byte count,
  never an actual audio LEVEL. session.inputLevel was being written every mic
  chunk by the capture path but had no consumer in the status panel.

## After state

- Failing tests: none. realtime-status 20/20; full suite 1074/1074, EXIT 0.
- micCaptureSummary now appends `· level:[████░░░░] NN%` (via the shared
  formatLevelLabel) whenever session.inputLevel is a finite number — so the
  operator sees live mic input level in the status panel. Defensive: absent /
  non-finite level falls back to the byte-only summary, so synthetic and
  pre-capture sessions are unchanged.

## Diff summary

- Code/content commit: pending final squash SHA from the reintegration receipt.
- Files touched: `extensions/lib/realtime-status.js` (import formatLevelLabel;
  defensive level render in micCaptureSummary), `test/realtime-status.test.js`
  (+1 test).
- Tests: +1 / -0. Behavioural delta: live input level now visible in the status
  panel; no change to the data path (ms2-2) or cascade widget bar (msm-2).

## Operator-takeaway

This closes the loop on "show audio input": the smoothed mic level a peer
computes per chunk now renders as a live bar+percentage in the realtime/STT
status panel, so you can see at a glance that audio is actually being captured
(and how loud). The whole feature came together cleanly across three agents by
splitting strictly by file — data (capture path), formatter (shared meter), and
render (status panel) — with no collisions.
