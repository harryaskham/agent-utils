# Bead workflow notes

These notes capture Cacophony operating conventions that agent-utils agents rely on while filing or triaging work.

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
