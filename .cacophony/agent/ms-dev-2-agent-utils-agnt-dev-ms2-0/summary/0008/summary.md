# Session summary — self model and effort tools

## Goal

Add first-party, tool-callable Pi surfaces that let a managed agent change its own active model or reasoning effort only when the operator explicitly instructs it to do so. The goal was to expose the existing slash-command capabilities to agent tool calls without encouraging autonomous self-tuning.

## Bead(s)

- `bd-218718` — Add operator-gated self model and effort tools

## Before state

- Model switching existed as `/m <provider/model>` in `extensions/m.js`, resolving against the full model registry and delegating to `pi.setModel`.
- Effort switching existed as `/effort <level>` in `extensions/effort.js`, delegating to Pi's thinking-level API.
- There were no native Pi tools named `self_set_model` or `self_set_effort`, so agents could not use structured tool calls for operator-directed runtime changes.

## After state

- `extensions/m.js` registers `self_set_model`, reusing the same full-registry resolver and `pi.setModel` path as `/m`.
- `extensions/effort.js` registers `self_set_effort`, reusing the same thinking-level normalization and Pi runtime setter path as `/effort`.
- Both tool descriptions, prompt snippets, and parameter descriptions explicitly state that agents should use them only when instructed by the operator and not for autonomous self-tuning.
- Existing `/m`, `/effort`, and `/fast` behaviors are preserved.

## Diff summary

- Code/content commits: `ea38a96`
- Summary artefact commit: intentionally omitted; this file must not self-reference its own mutable SHA
- Files touched:
  - `README.md`
  - `extensions/m.js`
  - `extensions/effort.js`
  - `test/m-command.test.js`
  - `test/effort-command.test.js`
- Tests: added focused coverage for both new tools' registration, behavior, error paths, and operator-only wording.
- Validation: targeted `node --test test/m-command.test.js test/effort-command.test.js` passed 27/27; full `npm test` passed 573/573.
- Behavioural delta: agents now have structured `self_set_model` and `self_set_effort` tools, but their wording constrains use to explicit operator instruction.

## Operator-takeaway

The existing slash commands already supported runtime model and effort changes; this session made those changes available as structured agent tools while preserving the safety norm that agents should not autonomously tune their own model or effort.
