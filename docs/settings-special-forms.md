# Agent Utils settings special forms

Agent Utils settings remain ordinary JSON and literal values continue to work unchanged. Opt in to recursive special-form resolution for the Agent Utils-owned subtree:

```json
{
  "agentUtils": {
    "globalShellExpansion": {
      "enabled": true
    }
  }
}
```

Only values below `agentUtils` are resolved. Pi core settings and third-party settings remain untouched. Resolution happens in memory at startup; `settings.json` is never rewritten.

A setting therefore accepts its normal literal type or an explicit special-form object. For example, all of these remain valid:

```json
{
  "agentUtils": {
    "narrate": {
      "enabled": true
    }
  }
}
```

```json
{
  "agentUtils": {
    "narrate": {
      "enabled": { "$envAbsent": "CACOPHONY_AGENT" }
    }
  }
}
```

## Boolean forms

### Environment presence

```json
{ "$envPresent": "CACO_AGENT_ID" }
{ "$envAbsent": "CACOPHONY_AGENT" }
```

Presence means the variable exists in the environment; an explicitly empty value is still present.

### Environment boolean

```json
{ "$envBool": "PI_NARRATE_ENABLED", "default": false }
```

Accepted true values are `1`, `true`, `yes`, and `on`. Accepted false values are `0`, `false`, `no`, and `off`, case-insensitively. Missing/empty input uses the optional boolean `default`, otherwise false. Invalid values fail closed.

### Environment/shell equality

```json
{ "$envEq": ["${XYZ}", "some-val"] }
{ "$envEq": ["${XYZ}", "$(echo 123)"] }
```

`$envEq` requires exactly two string operands. Each operand is evaluated by bounded Bash expansion, including `${VAR}` and explicit `$(command)` substitution, then the resulting strings are compared exactly.

### Boolean command

```json
{
  "$boolCommand": "[[ -z \"${CACO_AGENT_ID:-}\" && -z \"${CACOPHONY_AGENT:-}\" ]]"
}
```

The command runs through bounded `bash -lc` with stdin closed, stderr discarded, a 64 KiB stdout cap, and a one-second timeout.

Result precedence:

1. trimmed stdout `1`, `true`, `yes`, or `on` means true;
2. trimmed stdout `0`, `false`, `no`, or `off` means false;
3. any other stdout falls back to exit status: zero is true, nonzero is false;
4. timeout, spawn failure, malformed forms, and unavailable exit status fail closed.

Diagnostics contain only the settings path and failure class, never command stdout or environment values.

## Scope and trust

Shell execution is never inferred from an ordinary string. `$(...)` in a normal Agent Utils string remains literal unless that value is inside the explicit `$envEq` form; arbitrary commands require `$boolCommand` or `$envEq` plus the global opt-in.

Treat `settings.json` as trusted executable configuration when shell forms are enabled. Do not place untrusted content in either shell form. Environment values and child command output are used only to produce the resolved boolean and are not persisted.

Special-form objects must be exact. `$envPresent`, `$envAbsent`, and `$boolCommand` accept no sibling keys; `$envBool` accepts only `default`; `$envEq` accepts exactly two string operands. Mixed, ambiguous, or unknown `$...` objects produce false and one bounded path-aware warning.
