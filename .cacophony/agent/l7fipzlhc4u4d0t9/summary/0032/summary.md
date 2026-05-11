# Session summary — Tendril share image shape fix + kitty preview

## Goal
Fix /tendril so models actually receive the screenshot, and surface the captured frame to the user via the kitty graphics protocol.

## Bead(s)
- bd-4fd3cb — Tendril sharing: flat ImageContent + kitty preview

## Before
- /tendril window/display/stream/describe sent images using Anthropic shape `{ type: "image", source: { type: "base64", mediaType, data } }`. Pi's ImageContent is flat (`{ type: "image", data, mimeType }`), so the screenshot never reached the model. User reported "can you see this" returning empty.
- No kitty preview was emitted; the user only saw the saved path.

## After
- All sendUserMessage image content now uses `{ type: "image", data, mimeType }` matching Pi's `ImageContent`.
- Captures emit a kitty graphics sequence directly to stdout after sending the message, so the user sees the screenshot in the TUI. Off by default in non-TTY or with `TENDRIL_SHARE_PREVIEW=0`. Width via `TENDRIL_SHARE_PREVIEW_COLUMNS` (default 64).
- Tests updated for the new image shape; `npm test` 61 passing.

## Commits
- b3e1b2d
