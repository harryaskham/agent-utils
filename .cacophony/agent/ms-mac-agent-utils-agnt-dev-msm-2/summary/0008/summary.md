# Session summary — Cascade speech sanitisation (Phase 2h)

## Goal

Make /cascade spoken output reliably clean: even when a model ignores the
"plain spoken sentences" instruction and emits markdown/emoji/links, the TTS
voice should never read "asterisk", "backtick", a URL, or an emoji aloud.

## Bead(s)

- `bd-7c6790` — Multi-participant group-chat for /rt + /cascade (epic; in_progress).

## Before state

- The system prompt asked for plain speech, but in a live probe a model still
  produced "**Claude**" and an emoji; those would be spoken literally. Suite: 995.

## After state

- `extensions/lib/realtime-cascade.js`: new pure `sanitizeForSpeech` — strips code
  fences/inline code, markdown links (keeping the text), bare URLs, bold/italic
  markers, headings, blockquotes, list markers, and emoji; collapses whitespace.
- `extensions/lib/realtime-cascade-session.js`: `makeCascadeSpeak` now sanitises
  the reply before synthesis (the textual conversation record stays faithful;
  only the audio is shaped).
- Tests: +4 (sanitiser cases + applied-in-speak); suite 999 passing, 0 failing.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files: extensions/lib/realtime-cascade.js, extensions/lib/realtime-cascade-session.js,
  test/realtime-cascade.test.js, test/realtime-cascade-session.test.js.
- Tests: +4, 0 flipped.

## Operator-takeaway

Cascade voices now stay clean to the ear regardless of model formatting quirks:
markdown, emoji, and URLs are stripped from speech while the transcript context
other agents hear remains faithful. Defence-in-depth alongside the in-prompt
"plain spoken sentences" instruction.
