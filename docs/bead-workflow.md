# Bead workflow notes

These notes capture Cacophony operating conventions that agent-utils agents rely on while filing or triaging work.

## Labeling drafts by owning-checkout and lane

The `agent-utils` bead project accumulates drafts from every agent that runs in this project, but those drafts do not all land here. Reflect-session and quick-file drafts mix three categories that determine whether an idle agent-utils worker can actually claim and land them:

1. **In-lane** — the fix lives in *this* `agent-utils` checkout (a Pi extension under `extensions/`, a crate under `crates/`, a skill, a doc, a theme, a prompt). Claimable and landable here.
2. **Out-of-checkout** — the fix lives in another repo reachable only from another checkout/scope: the `caco` CLI / cacophony daemon, Pi core, or the standalone Pi extension tree. Not landable from an agent-utils checkout even though the friction was observed while running here.
3. **Peer specialist lane** — in-lane by repo, but inside an active specialist surface (for example `pi-graphics` behavior work) that should not be force-claimed by a generic idle worker.

Without a label, an idle worker must hydrate each draft with `caco bd show` one at a time just to decide claimability. Adopt these labels at filing and triage time so the pool is server-side filterable:

- `owning-checkout:agent-utils` — category 1; the fix lands in this repo.
- `out-of-checkout` — category 2; the fix lands elsewhere. Where the target repo is known, pair it with a specific `owning-checkout:<repo>` label, e.g. `owning-checkout:caco-cli`, `owning-checkout:cacophony-daemon`, or `owning-checkout:pi-core`. A bead is either `owning-checkout:agent-utils` **or** `out-of-checkout`, never both.
- `lane:<surface>` *(optional)* — narrows an in-lane bead to a surface/specialist lane: `lane:kitty`, `lane:pi-graphics`, `lane:app-automation`, `lane:realtime`, `lane:web-search`, `lane:skill-server`, `lane:tendril`, `lane:tui`. A draft may carry both an `owning-checkout:*` and a `lane:*` label.

An idle agent-utils worker scanning for claimable-in-lane work then runs:

```bash
# claimable-in-lane drafts only
caco bd list --label owning-checkout:agent-utils --status draft

# everything that is NOT landable here (route to the owning repo/operator)
caco bd list --label out-of-checkout --status draft

# a specific specialist surface
caco bd list --label lane:pi-graphics --status draft
```

Apply the label as part of triage on existing drafts with `caco bd update --bead-id <id> --add-label owning-checkout:agent-utils` (or `--add-label out-of-checkout`), and include the appropriate `owning-checkout:*` label in `--labels` when filing new drafts. This complements `bd-fec29a` (filing-time path/project validation) from the consumer/filter side: filing-time validation keeps drafts in the right *project*, while these labels keep the right-project drafts filterable by *checkout*.

## Parent epics vs blocking dependencies

Use `dependencies` only for prerequisite work that must close before the current bead is ready. A dependency is a blocker: if a new task depends on an unresolved epic, controller/worker flows may correctly treat that task as not claimable yet.

When the intent is only to group work under an epic, do **not** put the epic id in `dependencies`. Instead:

- mention the parent epic in the description, e.g. `Parent epic: bd-XXXXXX`;
- add shared labels for the epic surface, e.g. `app-automation`, `realtime`, or `pi-extension`;
- if the project later grows a first-class parent/epic link field, prefer that field for hierarchy and reserve `dependencies` for blockers.

## Filing ready tasks under an open epic

A ready implementation slice under an open epic should be claimable immediately. Recommended create pattern:

```bash
caco bd create \
  --type task \
  --priority P2 \
  --labels app-automation,pi-extension \
  --title "Implement one concrete app automation action" \
  --description "Parent epic: bd-XXXXXX. This slice is ready; no blocking dependencies. ..."
```

Use `--dependencies <bead-id>` only when the slice genuinely cannot start until that bead lands. If you accidentally create a ready task with an epic in `dependencies`, update the dependency list before claiming so workers do not interpret the task as blocked.

## Recovering from `caco bd create` timeouts

A timeout or daemon backpressure error during `caco bd create` is ambiguous: the daemon may have created the bead but failed to return the response, or it may not have received the create at all. Do not immediately retry the same create blindly, because that can duplicate beads.

Recommended recovery flow:

1. Search for the intended title or a distinctive phrase from the description across all statuses:

   ```bash
   caco bd search --query "distinctive title or phrase"
   ```

2. If search is temporarily unavailable, list recent open/draft beads and inspect likely matches:

   ```bash
   caco bd list --status open --limit 50
   caco bd list --status draft --limit 50
   ```

3. If you find the bead, use that id and continue; do not retry creation.
4. If no matching bead exists after a bounded check, retry once with the same title and include a short note in the description that the previous create attempt timed out.
5. If repeated create calls time out, stop and surface the daemon/backpressure issue instead of continuing to generate possible duplicates.

Future improvement: a first-party create idempotency key or recent-create lookup by caller/title would make this manual recovery flow unnecessary.
