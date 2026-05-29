# Session summary — active one-line gradient rail fix

## Goal

User clarified the one-line left-to-right gradient was not stale, but an active Pi graphics draw, likely from old/misplaced editor fill or editor rail behavior.

## Bead(s)

- `bd-da275b` — Fix active one-line Pi graphics gradient artifact

## Findings

- The likely active draw path in the user's global settings is not trailing workspace or row background; both are configured false.
- The global settings use:
  - `editor.style: "unicode"`
  - `editor.unicodeMode: "topLeft"`
  - `editor.topBorderHeight: 2`
  - `editor.animation: true`
- In that combination, the previous implementation mounted an above-editor widget solely to host the top-left Unicode anchor for the taller top border. That can look like a detached one-line left-to-right gradient until editor typing causes repaint/occlusion.

## Work completed

- Changed `unicodeMode=topLeft` taller top editor borders to avoid the detached above-editor widget.
- For `edge === "top" && height > 1`, Pi graphics now uses the existing relative placement path anchored on the editor row and offset upward by `V=-(height-1)`.
- Single-row `topLeft` rails still use the top-left Unicode placeholder path.
- Bottom `topLeft` rails still use the bottom editor rail anchor and reserve blank rows below when needed.
- Added `editorBorderNeedsWidget(edge)` so the top widget is not mounted for top-left taller top borders.
- Updated docs to explain the fallback and source-invariant tests to cover it.

## Validation

- `node --check extensions/pi-graphics.js`
- `node --test test/pi-graphics.test.js` — 91/91 pass
- `npm run docs:check` — pass
- `git diff --check` — pass

## Commit

- `caca285` before reintegration.
