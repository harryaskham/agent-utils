# Session summary — mcp-cli envelope round-trip + details-omission test coverage

## Goal

Continue overnight tooling progress under Harry's directive (perf/agent-tooling,
no clutter, board empty). Pin two unpinned contract guarantees of the shared
mcp-cli JsonEnvelope wire format that downstream CLI/MCP consumers depend on.
Disjoint from the peer agent's pi-graphics modularization.

## Bead(s)

- `bd-a23485` — Pin mcp-cli envelope round-trip deserialization and details-omission contracts
- (prior, same session: `bd-b08fa2`, `bd-723120` — both landed/closed)

## Before state

- Failing tests: none. mcp-cli had 7 tests (all in lib.rs); envelope.rs had no
  co-located tests.
- Gaps: envelope serialization was tested only by parsing into an untyped
  serde_json::Value, so typed round-trip deserialization (the JsonEnvelope<T> /
  JsonError Deserialize derives) was unpinned; and only the details-present case
  was tested, not the skip_serializing_if = "Option::is_none" omission contract.

## After state

- Failing tests: none. mcp-cli now 10 tests; clippy clean under `-D warnings`;
  skill-server (downstream) still 8/8; JS suite green at 459.
- Three new co-located tests in envelope.rs:
  success_envelope_round_trips_to_equal_typed_value,
  error_envelope_round_trips_to_equal_typed_value, and
  none_details_are_omitted_from_error_json.

## Diff summary

- Code/content commit: pending final squash SHA from reintegration receipt.
- Files touched: `crates/mcp-cli/src/envelope.rs` (+51 lines, tests only;
  adds the first `#[cfg(test)]` module to that file).
- Tests: +3.
- Behavioural delta: none — pure test additions pinning existing behavior.

## Operator-takeaway

The shared envelope contract that every mcp-cli-backed CLI/MCP surface relies on
(typed round-trip parse-back, and absent-not-null details on errors) is now
guarded. Pure test additions, zero behavior change.
