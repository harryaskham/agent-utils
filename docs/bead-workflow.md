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
