# Session summary — Associate tendril inference results with source machines

## Goal

Enable Tendril's model-inference pipeline to attribute remotely captured
application images to the machine that produced them. Before this change a
`--remote <host>` capture flowed through the describe/inference path with no
record of which machine the screenshot came from, so inference results could
not be associated with a source machine and concurrent remote captures of the
same target could collide on disk. This session threads source-machine
identity through capture, inference, share text, capture history, and the
native `tendril_*` tool results.

## Bead(s)

- `bd-668a82` — Enable model inference on remotely captured application images
- (sibling, owned by agnt-dev-0: `bd-a4f693` — Add native hooks for --remote flags in tendril)

## Before state

- Failing tests: none
- Relevant metrics: 484 suite tests; `test/tendril-share.test.js` had 21 tests
- Context: `extensions/tendril-share.js` already supported `--remote` capture and
  a VLM describe path, but `describeImageData` / `describeTarget` /
  `tendril_describe` did not surface the source machine, and capture filenames
  (`<ts>-<kind>-<id>.png`) were not namespaced by source host, risking
  collisions for concurrent multi-machine captures.

## After state

- Failing tests: none
- Relevant metrics: 488 suite tests (full `npm test` green);
  `test/tendril-share.test.js` now 25 tests
- Context: source-machine attribution is threaded end-to-end. Remote inference
  prompts carry a `Source machine: <host>` line, describe results return a
  `sourceMachine` descriptor, shared description text reads
  `... description from <model> (source machine <host>)` plus a
  `Source machine: <host>` line, capture-history metadata records the source,
  the `tendril_capture` / `tendril_describe` tool `data` includes
  `sourceMachine`, and capture filenames are namespaced by source label so
  concurrent remote captures of the same target never collide.

## Diff summary

- Code/content commits: pending final squash SHA from reintegration receipt
- Files touched: `extensions/tendril-share.js`, `test/tendril-share.test.js`, `README.md`
- Tests: +4 (`resolveSourceMachine` unit, `tendril_describe` source association,
  `/tendril describe` description tagging, concurrent-remote-capture
  disambiguation); 0 removed; 0 flipped
- Behavioural delta: remote captures now produce source-attributed inference
  results and collision-safe artifact filenames; local captures are unchanged
  (no `Source machine` line, filename gains a stable `-local-` segment).

## Embedded artefacts

- None this session.

## Operator-takeaway

The capture+inference plumbing already existed; the real gap was attribution.
Source-machine identity is now a first-class field on every capture result and
is woven through the describe/inference path and on-disk artifacts, which is
what makes multi-machine remote inference usable. Coordination note: this work
deliberately overlapped with agnt-dev-0's bd-a4f693; we agreed a clean split
where dev-0 owns the `tendril-command.js` command-hook layer
(`tendrilSourceMachine` helper) and this bead owns all describe/share/inference
attribution. A small dedup follow-up (collapse the inline `resolveSourceMachine`
here onto the shared `tendrilSourceMachine` helper) was filed as a draft by
dev-0 and can be picked up once both land.
