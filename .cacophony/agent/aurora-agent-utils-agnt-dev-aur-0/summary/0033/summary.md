# Session summary — extension-tool-schemas.md drift fix (bd-648043)

## Goal

Apply a doc-accuracy (verify-don't-assume) pass to the existing docs. The
extension-tool-schemas.md shim-vs-TypeBox table makes a concrete, code-checkable
claim (the doc itself says to regenerate it via grep if it drifts) — and it had
drifted.

## Bead(s)

- `bd-648043` — Fix extension-tool-schemas.md drift: add self-compact.js shim row
  + note plain-JSON extensions (bug; landed).

## Before state

- The table omitted self-compact.js (a shim user, added after the doc was written).
- The binary shim-vs-TypeBox framing omitted that plain JSON-schema is a third
  import-testable option (effort.js, m.js, tendril-share.js).

## After state

- self-compact.js row added to the shim section; a note documents plain-JSON
  parameter extensions as a third import-testable option, clarifying the real rule
  ('avoid a direct @sinclair/typebox import'). Table now matches `grep -l` reality
  (verified by diff). npm run check green. Doc-only, public-safe.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Summary artefact commit: intentionally omitted (no self-reference).
- Files touched: docs/extension-tool-schemas.md.
- Tests: +0 (doc-only); npm run check green.
- Behavioural delta: none — documentation accuracy only.

## Operator-takeaway

A doc that asserts a code-checkable fact (which extensions use which schema source)
had silently drifted as new extensions landed (self-compact). The verify step also
avoided a false positive: web-search-models.js only mentions @sinclair/typebox in a
comment and registers no tool, so it correctly stays out of the table. Doc-accuracy
auditing of code-derived claims is a genuine, concrete value source distinct from
test coverage.
