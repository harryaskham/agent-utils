# Portable Pi sessions

The portable-session extension moves a **conversation branch** between Pi installations without assuming the same username, home directory, checkout root, model catalogue, or extension state exists on both hosts.

It provides two commands:

```text
/session-export <destination> [--redact] [--max-bytes N]
/session-import <bundle> [--cwd PATH] [--session-dir PATH] [--max-bytes N]
```

The bundle is transport-neutral JSON. Copy it using a transport you already trust; the extension does not upload, sync, or publish bundles.

## Export

Export the active branch to a new file:

```text
/session-export ~/handoff/feature.pi-session.json --redact
```

The command refuses to overwrite an existing destination. It writes via a same-directory temporary file and atomic link, with mode `0600`. The default maximum bundle size is 50 MiB; use `--max-bytes` to choose a different explicit bound.

The manifest records:

- bundle schema version and creation time;
- origin host, session id, `HOME`, and working directory;
- repository remote and commit when available;
- active provider/model;
- extension `customType` values encountered in the active branch;
- inline image count and base64 byte total.

Only the active branch is exported. Abandoned branches in the source JSONL tree are not copied.

### Redaction is helpful, not exhaustive

`--redact` masks common secret-bearing keys and recognizable bearer, GitHub, and `sk-...` token shapes. It reports the number of replacements. It is a conservative safety pass, **not proof that the transcript is secret-free**. Tool output, prose, screenshots, unusual credential formats, and encoded data can still contain sensitive material. Review a bundle before sending it off-host, and never commit private transcripts to a source repository merely because redaction was requested.

Inline images remain in the bundle. Exports that exceed the configured size bound fail clearly; content is never silently dropped to make a bundle smaller.

## Import

Copy the bundle to the target host, enter the target checkout, then run:

```text
/session-import ~/handoff/feature.pi-session.json
```

The current directory is the default target `cwd`. Override it explicitly when needed:

```text
/session-import ~/handoff/feature.pi-session.json --cwd /Users/harry/src/agent-utils
```

The target directory must already exist. Import validates the bundle and session tree, allocates a new session id, rewrites the header `cwd`, and writes a new `0600` JSONL session without modifying the bundle or origin session. By default it uses Pi's per-cwd session placement. `--session-dir` preserves installations that intentionally use a shared custom session directory.

After import, use normal Pi session discovery from the target cwd:

```bash
cd /Users/harry/src/agent-utils
pi -c
```

The imported header includes `portableImport` provenance naming the origin host, origin session id, bundle version, import timestamp, and new local session id. It deliberately does not put a remote identifier into Pi's `parentSession` field, because that field denotes a local session-file path.

## Path translation and compatibility report

Import applies only two declared prefix mappings:

1. origin checkout `cwd` to target `cwd`;
2. origin `HOME` to target `HOME`.

Rewrites are path-boundary checked. Longer prefixes win, so a checkout mapping is applied before the broader home mapping. Strings inside messages, tool arguments, bash execution records, and extension-owned payloads use the same policy. Absolute paths outside those mappings are preserved verbatim and listed as unresolved; import never silently erases or guesses them.

The compatibility report also warns when:

- the source provider/model is unavailable or cannot be verified locally;
- an extension `customType` cannot be verified on the target.

These are warnings rather than hard failures so conversation history remains recoverable. Selecting a usable local model after resume is an operator choice.

## Extension-owned payload contract

`custom` and `custom_message` entries survive round-trip structurally. Extension authors should treat their data as one of:

- **portable:** ordinary JSON whose absolute path strings may use the declared prefix translations;
- **host-specific:** device ids, Pulse routes, Tendril targets, kitty placements, daemon agent ids, process ids, sockets, state-root paths, or other values that require reinitialization on the target.

Unknown custom types are preserved and reported. The importer does not invoke extension-specific migrations or discard unfamiliar state. Extensions must validate restored state and ignore or rebuild values that are not meaningful on the target host.

## Deliberate exclusions

A portable session bundle contains conversation/session data only. It does **not** include or migrate:

- `auth.json`, API keys, cookies, or OAuth caches;
- `models.json`, `models-store.json`, provider registrations, or model credentials;
- MCP server configuration or authentication;
- installed extensions, skills, prompts, themes, or package dependencies;
- app-automation snapshots, browser profiles, Pulse devices, Tendril displays, or external state roots;
- working-tree changes or uncommitted repository files.

Install and authenticate required integrations separately on the target. Use the recorded repository commit to align source code before resuming when appropriate.

## Delivery map

The original feature `bd-24ed21` is delivered as four bounded slices:

| Bead | Responsibility | Parent acceptance covered |
|---|---|---|
| `bd-38421f` | Versioned manifest, conservative prefix translation, unresolved-path report, provenance primitives | Header/known-prefix rewrite; report dangling paths; preserve custom entries |
| `bd-d30dd1` | Active-branch export, optional redaction, image accounting and size bound | Self-contained export; optional secret pass; bounded image handling |
| `bd-23f673` | Validated import, new local identity, Pi-compatible placement and compatibility warnings | Different-HOME/cwd resume; origin provenance; model/custom degradation |
| `bd-fa3310` | This contract plus the cross-host end-to-end fixture | Documented extension payload contract; complete differing-host round trip |

Remote daemon transfer and Cacophony-native transport remain optional layers above this bundle format; they are not required for a correct local export/import foundation.

## Bundle schema

Version 1 has this top-level shape:

```json
{
  "manifest": {
    "bundleVersion": 1,
    "createdAt": "...",
    "origin": { "sessionId": "...", "host": "...", "home": "...", "cwd": "..." },
    "repository": { "remote": "...", "commit": "..." },
    "model": { "provider": "...", "id": "..." },
    "customTypes": []
  },
  "session": { "header": {}, "entries": [] },
  "images": { "count": 0, "base64Bytes": 0 }
}
```

Import rejects unsupported bundle versions, inconsistent origin/header identities, duplicate entry ids, dangling parents, invalid session versions, oversized input, destination collisions, and nonexistent target working directories.
