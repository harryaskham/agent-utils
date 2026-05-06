# Session summary — bd-81818a Firecracker VM controller

## Goal

Implement a Firecracker VM controller surface for Tendril-agent workloads in the agent-utils Pi package.

## Bead(s)

- `bd-81818a` — Implement Firecracker VM controller for Tendril agents

## Before state

- No Firecracker VM extension was packaged.
- Repo-local Pi tools covered web search, kitty image preview, and pi graphics only.
- Tendril-visible VM lifecycle and screen metadata had no first-class surface in this repo.

## After state

- Added `extensions/firecracker-vm.js` and registered it in `package.json`.
- New Pi tools:
  - `firecracker_vm_start`
  - `firecracker_vm_status`
  - `firecracker_vm_list`
  - `firecracker_vm_screen`
  - `firecracker_vm_stop`
- New TUI command: `/firecracker-vms`.
- `firecracker_vm_start` creates a VM workspace, writes `firecracker-config.json`, writes `tendril-firecracker-manifest.json`, and optionally spawns `firecracker --api-sock ... --config-file ...`.
- Supports dry-run config/manifest generation for hosts without KVM/Firecracker.
- Tracks lifecycle state, pid liveness, API socket path, serial console log, Firecracker log, optional metrics path, service endpoints, and autostop-on-session-shutdown.
- `services` metadata can declare browser/VNC/noVNC/control endpoints; `firecracker_vm_screen` returns graphical endpoints plus serial-console tail because Firecracker itself is headless.
- README and generated docs inventory updated.
- Regression test added for package registration and lifecycle/screen/Tendril-manifest controls.

## Validation

Direct foreground validation from checkout:

- `node --check extensions/firecracker-vm.js`
- `npm test`
- `npm run docs:check`

All passed. Final full test count: 29 passing.

## Commits

- `4272a99` — `bd-81818a: add Firecracker VM controller extension`
