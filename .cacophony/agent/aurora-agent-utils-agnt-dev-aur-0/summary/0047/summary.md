# Session summary — local-vad real-time segmentation + re-draft pump (bd-71d4fb)

## Goal

Fix the bug Harry found in LIVE mic validation of /rt stt local-vad: multi-segment
turns (speaking with short gaps) grew the partial forever and never committed.

## Bead(s)

- `bd-71d4fb` — local-vad: multi-segment turns never commit; transcribe blocked
  frame ingestion (bug; landed).

## Root cause

LocalVadController awaited the batch transcribe INSIDE the serialized frame
ingestion path. The slow per-insert transcribe blocked frame intake, so the
segmenter silence clock lagged real time and the un-awaited capture backlog meant
the commit's 3s-silence never arrived -> stranded turn + huge delay.

## Fix

- pushFrame synchronous: re-frame + VadSegmenter only, never blocked (race stays
  fixed since sync ingestion cannot interleave).
- Single-flight async transcription pump OFF the ingestion path: insert re-drafts
  the WHOLE turn (latest-wins coalescing) not delta stitching; commit prioritized
  so the turn sends promptly; opt-in "…" placeholder in the startLocalVad wiring;
  flush() drains the pump.

## Verification

- New regression test: multi-segment turn + slow transcribe reaches commit
  synchronously, sends once, single-flight, coalesced (6 gaps -> 2 transcribes).
- Real end-to-end pipeline (synth speech -> rewritten controller -> real stt
  mai-transcribe-1.5) returns clean partial + commit.
- 4 existing tests updated for the new semantics. Suite 1012 green; check green.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted.
- Files: extensions/lib/realtime-local-vad.js (controller rewrite),
  extensions/realtime-agent.js (placeholder opt-in), test/realtime-local-vad.test.js
  (+1 regression, 4 updated).
- Behavioural delta: multi-segment turns now commit/send correctly in real time.

## Operator-takeaway

Speaking in multiple bursts now commits and sends correctly after your pause, with
the partial firming up in real time and no growing-forever stall.
