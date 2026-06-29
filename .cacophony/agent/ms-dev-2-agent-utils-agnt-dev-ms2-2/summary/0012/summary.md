# bd-381522 — declarative registry for /rt k=v value settings

Adding a runtime /rt value setting used to need 5 coordinated edits in
realtime-agent.js; the two most error-prone (env alias map + coercion) are now
one data row, with a round-trip test preventing the bd-afb682 "energy= silently
dropped" class.

## Changes
- NEW `extensions/lib/realtime-settings.js`: `REALTIME_VALUE_SETTINGS` rows
  `{param, keys:[aliases], coerce}` for the value settings (baseUrl/backend/
  voice/trans/reasoning/speed/thresh/energy/summary/chime/fork/model + azure*),
  plus pure `realtimeValueParamFor`, `buildRealtimeValueParams(values)`, and
  `normalizeRealtimeValueParams(params, coercers)` (coercers supplied by caller
  so the lib stays dep-free).
- `realtime-agent.js`: `envArgsToRealtimeParams` + `normalizeRealtimeToolParams`
  now iterate the registry for value settings; lifecycle (action/start/mic/
  listen/stt/audio/widget/status) + pulse routing stay bespoke. Setters,
  snapshot, applyRealtimeParams dispatch unchanged. Behaviour preserved
  (unsupplied params omitted == prior undefined; coercion identical).
- NEW `test/realtime-settings.test.js`: 5 tests — every alias→param, no
  collisions, build omits unsupplied, param>alias precedence, coercers applied/
  null-skipped, baseUrl raw + directAzure bool.

## Validation
- Full suite 1089/1089 keyless (1084 + 5 new); `npm run check` OK.

## Landing
- Direct (pr_auto_merge fleet-blocked on daemon restart, msm-2 bd-721a38).
- Drained from the untriaged agent-utils draft pool per Harry's queue note.
