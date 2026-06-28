# Session summary — force-agent-speech (bd-9c9877)

## Goal

Close the hands-free voice loop Harry raised during local-vad validation: speak the
assistant's reply aloud (a short precis) so the conversation is heard, not just shown.

## Bead(s)

- `bd-9c9877` — force-agent-speech hook: speak a short spoken reply after the text
  response (feature; promoted from draft and landed).

## Change

New opt-in extension extensions/force-agent-speech.js: hooks Pi's turn_end, extracts
the assistant text, reduces it to a short markdown/code-stripped precis, and speaks
it via caco msg speak. Best-effort (never breaks a turn); tool-only turns skipped.
Enable with PI_FORCE_AGENT_SPEECH=1 / PI_FORCE_AGENT_SPEECH_MAX_CHARS (default 240) or
/force-speech [on|off|status|env]. Pure, tested helpers + an injectable speak runner.

## Verification

- +8 tests (env gating, max-chars, text extraction, precis stripping/truncation,
  the turn_end hook, the command override). Registered in package.json. Documented
  in docs/realtime-agent.md incl. the half-duplex caveat (bd-ddc391). Full suite
  1028 green; npm run check green.

## Diff summary

- Code/content commit: pending final squash SHA.
- Summary artefact: intentionally omitted.
- Files: extensions/force-agent-speech.js (new), test/force-agent-speech.test.js
  (new, +8), package.json (registration), docs/realtime-agent.md (section).
- Behavioural delta: off by default; when enabled, speaks a short reply precis.

## Operator-takeaway

Enable PI_FORCE_AGENT_SPEECH=1 (or /force-speech on) and the assistant's replies are
spoken back as a short precis — pairing with /rt stt local-vad for a hands-free loop.
The half-duplex echo guard (bd-ddc391) is the remaining piece for using both at once.
