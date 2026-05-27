# Kitty graphics protocol audit — 2026-05-24

Bead: `bd-64cf76`.

Harry requested a protocol-focused pass over the Kitty graphics protocol and the `agent-utils` Kitty/Pi graphics implementation. Most of the implementation work from that audit had already landed through `ms-mac-agent-utils-agnt-dev-2`; this note records the consolidated findings and the one narrow remaining correction made in this follow-up.

## Scope checked

- Escape framing and tmux passthrough.
- Direct PNG transmission, chunking, quiet mode, and payload size limits.
- Image ids, placement ids, Unicode-placeholder ids, and truecolor placeholder encoding.
- Virtual Unicode placeholders and relative placements.
- Delete semantics and cleanup safety.
- Animation/APNG claims versus the live path that actually repaints in Pi/tmux.
- Rendering/cache efficiency and repeated upload avoidance.

## Findings

### Already good / already addressed

- **Escape framing and tmux passthrough:** `extensions/kitty-graphics.js` correctly emits APC `ESC_G...ESC\\` and wraps it for tmux as DCS `ESC Ptmux; ... ESC\\`, doubling inner ESC bytes. Existing tests cover this. No passthrough churn is recommended.
- **Chunking:** direct base64 payloads are capped to Kitty's 4096-byte chunk size, non-final chunks are multiples of four, and animation frame continuations keep `a=f` as the protocol requires.
- **Scoped cleanup:** the image-preview extension tracks owned image ids and avoids global delete-all (`d=A`), so it does not erase caco/Pi-owned graphics.
- **Unicode placeholders:** image ids use the 32-bit namespace with the high byte encoded as the third placeholder diacritic, while placeholder placement ids stay in the 24-bit underline-color namespace.
- **Relative placements:** Kitty `H`/`V` relative-placement offsets are terminal-cell offsets; positive values move right/down and negative values move left/up from the parent's top-left cell. Relative placements remain valid for box chrome, footer backgrounds, editor row backgrounds, previews, animated editor borders, and the best-effort live cursor halo. The live cursor now separates the proven anchor from the risky halo: it first renders a direct Unicode-placeholder PNG in the cursor cell (the same text-flow path as trailing workspace), then attaches an 11×5 relative halo with `H=-5,V=-2` below that direct cursor. If the relative halo drifts or fails in live Kitty/tmux, the cursor cell remains visible and correctly positioned. Raw relative-placement APC must still stay out of rendered editor text and be emitted through the side-channel writer.
- **Animation:** the docs and implementation now treat terminal-driven APNG/native loops as unreliable in the live Pi/tmux path and prefer explicit current-frame control (`a=a,c=<frame>`) where repainting is confirmed. Live manual animation timers are unref'd so they do not pin the process, stop on scoped graphics reset/session end, and self-stop on write failures; preview-series animation/cycle timers also guard against overlapping async frame prepares.
- **Efficiency:** dev2's follow-up cache work reduced repeated strip/placement rendering and clarified that z-index cleanup is only supplemental for real/relative placements; per-image deletes remain authoritative for placeholder graphics.

### Narrow correction made here

- **Cursor cleanup used the wrong delete selector:** Kitty's `d=p` means "delete placements intersecting a specific cell" and expects `x`/`y`; it is not placement-id deletion. To remove a known placement id for an image, the protocol uses `d=i` with `i=<image id>,p=<placement id>`. The editor cursor cleanup paths now use `deleteMode: "i"` with both the image id and placement id.

## Remaining tracked work

- `bd-bd4f05` — Keep interactive Kitty animation smoke out of default npm test logs. This is the only related open issue seen during this follow-up audit pass.

## Recommendation

Keep future Kitty graphics work narrow and evidence-driven. The passthrough path, Unicode-placeholder encoding, chunking, and scoped cleanup helpers are covered by tests and should not be rewritten without a concrete observed failure. Prefer small protocol-semantic fixes plus source guards over broad graphics rewrites.
