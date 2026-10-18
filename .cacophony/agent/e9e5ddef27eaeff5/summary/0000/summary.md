# Session summary — Session-bound Pi visiting registration

## Goal

Make classic Pi visiting registration use the current conversation identity instead of inherited environment/cwd state, preserve isolation across logical sessions, and allow an explicit project without changing parent configuration. Inspect external Pi-Daemon provenance rather than substituting an unrelated identifier.

## Bead(s)

- `bd-1f9bfa` — Fix Pi visiting registration session identity, explicit project, and PD provenance.
- `bd-4c7429` — Draft follow-up: native Durable visiting-registration adapter with actual PD provenance.
- `bd-deeadc` — Draft reflection: infer the managed project before worker-scope validation in single-bead reads.
- Parent coordination: Cacophony `bd-58f55c`; registration CLI flags are source dependencies from PR #4505.

## Before state

- Visiting receipts matched only project, so forks could reuse a parent identity.
- Registration omitted the live session ID and used one module-global fallback for all logical sessions.
- The manual command rejected `project=<name>`.
- Supplied historical contract evidence reported one pass and four failures; that attachment was not executed in this session.
- The installed Caco CLI help lacks the new session/runtime registration flags.

## After state

- Registration explicitly passes `ctx.sessionManager.getSessionId()` and fails closed when it is unavailable.
- Version-2 receipts match the active branch's session, project and external provenance. Reload/restart restores matching receipts; parent/fork and unproven legacy receipts are ignored.
- Visitor identity and subscriptions are session-scoped. Runtime custody plus async guards fence predecessor completion, finalization and shutdown.
- `/caco-agent-register project=<name>` works with or without project environment defaults. Complete managed identities still take precedence; parent settings/environment are not modified.
- MCP, choice/decision, speech, quickfile and artifact identity consumers use their current scope.
- External provenance can be explicitly supplied through `PI_CACO_RUNTIME_AGENT_ID` and is forwarded as `--runtime-agent-id`, not converted into managed identity.
- Validation: 107 focused Node tests passed; final committed runtime/MCP/isolation subset passed 35/35. Workflow lint and generated-site checks passed through `npm run check`. No full Rust suite, live registration, installed-extension modification or Pocket4 acceptance was performed.
- Native automatic PD-ID discovery remains outside the classic extension contract. The inspected classic host keeps its logical ID private, while PD 1.x uses a separate Durable module API. Draft `bd-4c7429` records that adapter follow-up; deployment of a containing Caco build is also required for real integrated registration.

## Diff summary

- Code/content commit: `49afc1b5abcd77351f79c183b3c760a3e3bac464`.
- Final landed squash SHA will come from the reintegration receipt.
- Core files: `extensions/cacophony-runtime.js`, `extensions/lib/cacophony-runtime.js`, and `extensions/cacophony-mcp.js`.
- Consumer scope plumbing: choice/decision bridges, `choice.js`, force-agent speech, realtime quickfile, and artifact identity.
- Tests: 16 new hermetic isolation/provenance cases, including four concurrent async-local logical sessions in one checkout; existing runtime/MCP fixtures now provide real session-context shapes and mock registration CLI calls.
- Documentation: `docs/cacophony-runtime.md` and `README.md` describe session identity, project selection, explicit provenance and native-host limitations.
- Rebased through the first-party agent rebase surface. Completion preview resolves direct integration without PR publication, so there is no source PR URL for this configured lane.
- Reflection drafts were filed after draft/open dedup and narrated through an accepted speak event.

## Operator-takeaway

The classic extension no longer treats a checkout or inherited receipt as a session identity. Its source-level registration and consumer isolation are covered by hermetic tests, but that is not native Pi-Daemon/Pocket4 acceptance: automatic external PD provenance needs the separate Durable adapter, and actual registration needs the Caco build containing both CLI flags.
