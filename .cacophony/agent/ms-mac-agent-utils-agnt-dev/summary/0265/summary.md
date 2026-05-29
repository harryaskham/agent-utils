# Session summary — Tendril share image/list defaults

## Goal

Change Tendril share/capture/stream defaults so model-facing messages include actual image content by default and include current `tendril list` context by default. Add opt-outs to restore path-only/no-list behavior.

## Bead(s)

- `bd-9ff006` — Make Tendril share messages include images and target list by default

## Work completed

- Updated `/tendril window|display` capture messages:
  - default message content is now text + PNG image content
  - text includes saved screenshot path and readable `tendril list` output by default
  - `--path-only` sends text/path context without image content
  - `--no-list` omits target-list context
- Updated `/tendril stream` first frame:
  - default first queued frame includes PNG image content and `tendril list` context
  - subsequent stream frames keep image content but avoid repeating list context
  - supports `--path-only` and `--no-list`
- Updated native tools:
  - `tendril_capture` defaults to text + image content + list context
  - `tendril_describe` defaults to text + image content + list context
  - `tendril_stream` supports `pathOnly` and `includeList`, with list context on the first frame by default
- Kept `pathOnly: true` / `--path-only` and `includeList: false` / `--no-list` opt-outs.
- Updated README, docs tool index, regenerated `docs/index.html`.
- Updated focused tests for defaults and opt-outs.

## Validation

- `node --check extensions/tendril-share.js`
- `node --test test/tendril-share.test.js` — 14/14 pass
- `npm run docs:build`
- `npm run docs:check`
- `git diff --check`

## Commit

- `6110ba2` before reintegration.
