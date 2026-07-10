# Session summary — pi-wasm S14 (increment 4b): 9p bridge shares the browser VFS into the guest → S14 DONE

## Goal

Final S14 (bd-c6ffc3) piece: a minimal 9p2000.L server bridging the v86 guest's
virtio-9p to our IndexedDB `LightningFsVfs`, so the in-browser Linux guest and
the file tools share ONE filesystem tree. With 4b landed, S14 is complete →
bead closed.

## Bead(s)

- `bd-c6ffc3` — pi-wasm S14 microVM exec backend → **CLOSED** (all increments landed).

## Before / after

- Before: v86 booted + ran shell (4a), but the guest had no access to the tools' VFS.
- After: `Vfs9pServer` (`src/exec/ninep/server.ts`, codec `src/exec/ninep/marshall.ts`)
  answers full 9p2000.L request frames from a `Vfs`. `V86Machine` passes it as
  v86's `handle9p`. The Buildroot guest **auto-mounts** host9p at **`/mnt`** at
  boot (`cache=none`), so guest `/mnt/<f>` ⇄ VFS `/work/<f>`:
  a tool writing `/work/hello.txt` is `cat`-able at `/mnt/hello.txt` in the guest
  (incl. mid-session writes), and guest writes to `/mnt` appear in the VFS.

## Validation (all green)

- `test/vfs9p-server.test.ts`: codec round-trips + the full `cat` message
  sequence (version→attach→walk→getattr→lopen→read), write-back, and readdir,
  against a real LightningFsVfs. vitest suite **162 green**; `tsc` clean.
- `e2e/microvm.spec.ts` (opt-in `PIWASM_E2E_MICROVM=1`) **PASSES against real v86**:
  boot+serial exec AND the bidirectional `/mnt` 9p round-trip (host→guest,
  guest→host, mid-session write visibility). `nix build .#pi-wasm` ok.

## Key discoveries / decisions

- The guest **auto-mounts host9p at /mnt** (not a path we choose) — the earlier
  "empty /work" was because `/work` was a plain local dir; the 9p share is /mnt.
- v86's mount rejects `cache=none`/`access=any` options, but the auto-mount is
  already `cache=none`, so write-after-mount visibility works without them.
- Serial exec needed `stty -echo` + empty `PS1/PS2` at boot so captured stdout
  is the command's real output only (not the shell's echo/prompts) — a
  correctness fix for the exec backend (was masked by lenient 4a assertions).
- 9p message layouts ported 1:1 from copy/v86's `lib/9p.js` + `lib/marshall.js`
  to guarantee interop with v86's guest device.

## Diff summary

- New: `src/exec/ninep/marshall.ts` (codec), `src/exec/ninep/server.ts` (9p2000.L
  server), `test/vfs9p-server.test.ts`.
- Modified: `src/exec/v86-machine.ts` (stty/PS1 quiet step), `src/microvm-demo.ts`
  (wire Vfs9pServer as handle9p; /mnt), `e2e/microvm.spec.ts` (+9p round-trip),
  `src/exec/index.ts` (export V86Machine + Vfs9pServer), `src/exec/MICROVM.md`.

## Operator-takeaway

S14 is DONE. The in-browser agent has a REAL Linux microVM exec backend AND that
guest now shares the tools' filesystem: an agent tool writes a file, the guest's
`bash`/`cat` sees it, and vice-versa — the full "real client-side exec over the
shared VFS" capability Harry flagged as a must-have, proven end-to-end in a
headless-Chrome Playwright test. No interface change (plugs behind the landed
ExecBackend/MicrovmMachine seam). Coordinated with msm-1 (S8 harness + their
concurrent bd-c9f4d5 vite-config guard; no conflict).
