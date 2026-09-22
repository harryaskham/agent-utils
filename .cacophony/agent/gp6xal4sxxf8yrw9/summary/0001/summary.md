# Durable explicit image shares

## Goal

Return selected Kitty images as durable Pi content. Original review-only restriction was superseded by Harry's explicit instruction: "yes, merge it".

## Bead(s)

- bd-ab4357 — Durable explicit image shares.
- bd-05ae08 — Draft lifecycle configuration reflection.

## Before state

Preview tools returned text/local state; no selected-image share tool returned durable bytes.

## After state

Explicit share-current returns one final inline-base64 image/png block. Bytes are frozen synchronously with an 8 MiB limit and PNG container/header/CRC checks, without pixel decoding. Preview/gallery/streams remain local; no AHP-specific events or duplicate publication.

## Diff summary

- Commit aea0c29d63ec5d5003846e73fbc6eef98b6b9592, rebased from 1a3b941 after completion rejected stale target without publishing.
- Files: README.md, extensions/kitty-image-preview.js, extensions/kitty-image-preview/share.js, test/kitty-image-preview-share.test.js.
- 19 focused tests passed before rebase; whitespace checks passed. JSONL round-trip, deletion/replacement, final-only output and disabled/absent bridge tested. Live full-stack consumer test not performed.
- PR #19 originally published for review. Configured completion resolves to direct; no mode/backend override used.

## Operator-takeaway

Explicit sharing now returns normal durable Pi image bytes. Harry authorized mainline merge after initial review handoff. First completion rejected stale target; first-party rebase succeeded without conflict, and completion is being retried on current main.
