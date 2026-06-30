# Session summary — clear npm audit: migrate deprecated @mariozechner/pi-* pin

## Goal

Clear the high-severity npm audit finding from the deprecated transitive pin
@mariozechner/pi-coding-agent (3 advisories) by migrating agent-utils off the
deprecated @mariozechner/pi-* packages to the renamed @earendil-works/pi-*
packages (operator report, Harry).

## Bead(s)

- `bd-b139d9` — Clear npm audit: migrate deprecated @mariozechner/pi-* pin to @earendil-works/pi-*

## Before state

- Failing tests: none (1113 green).
- package.json peerDependencies pinned @mariozechner/pi-ai + @mariozechner/pi-coding-agent; 3 extensions imported @mariozechner/pi-ai. npm audit: high severity (GHSA-7v5m-pr3q-6453 XSS, GHSA-jfgx-wxx8-mp94 LPE, GHSA-r95r-rj6r-c39x auth.json race) via the deprecated @mariozechner/pi-coding-agent.

## After state

- Failing tests: none. Suite 1113/1113. No @mariozechner references remain in extensions/test/package.json.
- package.json peerDependencies now @earendil-works/pi-ai + @earendil-works/pi-coding-agent; imports in kitty-image-preview.js, firecracker-vm.js, tendril-share.js use @earendil-works/pi-ai; stale comments updated.
- Verified at runtime: @earendil-works/pi-ai resolves and exports complete+StringEnum; @mariozechner/pi-ai was already ABSENT at runtime (the old pin was dead), so this is a strict fix. pi-graphics.js already used @earendil-works/pi-coding-agent successfully.

## Diff summary

- Code/content commits: pending final squash SHA from the reintegration receipt.
- Files touched: package.json, extensions/kitty-image-preview.js, extensions/firecracker-vm.js, extensions/tendril-share.js, extensions/kitty-image-preview/widget.js, extensions/lib/firecracker-vm-core.js, extensions/lib/realtime-event-stream.js.
- Tests: +0 (dependency/import rename; behavior unchanged). Suite 1113/1113.
- Behavioural delta: none functional; the deprecated @mariozechner/pi-* pin (carrying 3 advisories) is removed in favour of the maintained @earendil-works/pi-* packages.

## Operator-takeaway

The npm audit high-severity finding is cleared by removing the deprecated
@mariozechner/pi-* pin. Bonus discovery: the old @mariozechner/pi-ai import was
already unresolvable in the current Pi runtime (the package is gone), so three
extensions (kitty-image-preview, firecracker-vm, tendril-share) were importing a
dead module — now fixed to the live @earendil-works/pi-ai.
