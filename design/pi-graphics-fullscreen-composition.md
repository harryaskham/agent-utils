# Pi graphics fullscreen composition audit

Status: design contract for `bd-6342e4`, parent `bd-613db0`.

## Scope and baseline

Pi now owns a fullscreen differential-rendering surface. Graphics must compose
through current public TUI lifecycle and invalidation APIs; scrollback-era tricks
that overwrite singleton UI registrations or patch arbitrary component trees are
not a stable foundation.

The current extension is split between:

- `extensions/pi-graphics.js`: lifecycle, settings, TUI registration, caches,
  timers, and Kitty writes;
- `extensions/pi-graphics/box-chrome.js`: built-in component prototype wrapping;
- `extensions/pi-graphics/runtime.js`: scoped image/placement tracking;
- `extensions/pi-graphics/editor-render.js` and `affordances.js`: pure layout and
  pixels.

The opening comment in `pi-graphics.js` describes a minimal editor-only
extension, while `docs/pi-graphics.md` still documents many removed showcase
surfaces. Source is authoritative: this drift belongs in the migration slice,
not in the renderer.

## Current surface inventory

| Surface | Current mechanism | Ownership today | Fullscreen finding |
|---|---|---|---|
| Editor rails/content | Direct `setEditorComponent()` with a new `CustomEditor`; separate namespaced top/bottom widgets | Singleton replacement, no saved predecessor | **Unsafe composition.** It can replace editor chips/modal-editor wrappers and has no editor-specific uninstall path. |
| Generic extension editor/input/custom/overlay | Runtime monkey-patches of `ctx.ui` registration methods | Conditional restore when the patched function is still current | Better than unconditional restore, but wrapper ordering depends on extension load order and cannot remove only the graphics layer from an already-composed factory. |
| Built-in message/tool/dialog boxes | Process-global prototype patch | Restore callback plus null-runtime repair | Reload-aware, but global mutation remains brittle and must be isolated behind the lifecycle owner. |
| Footer | Direct `setFooter(factory)` | No lease/token; shutdown calls `setFooter(undefined)` | **Clobber risk.** Disable can erase a footer installed later by another extension. |
| Header | Wrapped only when another extension registers it | Conditional method restore | No owned header instance currently; wrapper order risk remains. |
| Widgets | Stable `pi-graphics-*` ids | Namespaced ids | Good basis. Teardown must clear every owned id, including debug and future rails, from one registry. |
| Working message/indicator | Direct startup setters plus patched setters | No captured predecessor/value | **Restore gap.** Teardown does not restore the prior working presentation. |
| Hardware cursor | Monkey-patched TUI setter with remembered boolean | Guard object on TUI | Policy restoration exists, but the patched method itself is not removed and ownership is not stacked. |
| Kitty virtual images | `state.ownedImageIds`, upload/content caches | Scoped image ids | Good basis; Unicode placements require image-id deletion. |
| Relative placements | Several independent placement records and reserved z-index band | Partly scoped by image/placement id | Replacement cleanup exists, but state is scattered across cursor, footer, editor border, and box runtimes. |
| Animation timers | Main map plus editor heat/context timers | Partial central cleanup | **Leak risk.** `patchDashRendersForTui()` owns a separate 500ms interval not held in the registry. Deferred zero-delay writes are also untracked. |
| Theme | `setTheme()` on startup/runtime | No previous-theme lease | `/gfx off` cannot independently disable graphics while preserving another extension's chosen theme policy. |
| Session teardown | `pi.on("session_end", ...)` | Single callback | **Critical mismatch.** Current Pi documents `session_shutdown`; the existing handler can miss reload/new/resume/fork/quit cleanup. |

## Current mode inventory

### Supported fullscreen-native candidates

- `editor.style=static`: text fallback/no Kitty placement. Keep as the quiet,
  predictable baseline.
- `editor.style=unicode`: in-flow Unicode placeholder rails. Keep, with `fill`
  and `topLeft` treated as placement strategies rather than separate editor
  owners.
- `editor.style=relative`: anchor-relative border placement. Keep as opt-in and
  require scoped placement replacement on every geometry change.
- `boxMode=unicode|relative`: keep only behind the same ownership registry and
  bounded width rules.
- `boxRails`: keep as a less invasive alternative to full box chrome.
- `cursorStyle=cell|glow|off`: keep, but cursor visibility and halo placement
  must use explicit leases.

### Compatibility aliases to deprecate

The pure contract in `fullscreen-contract.js` records deterministic mappings:

- `joinedUnicode`, `joined-unicode`, `joined_unicode`, `joined` → `unicode` +
  `topLeft`;
- `placeholder`, `caco` → `unicode` + `fill`;
- `overlay` → `relative`;
- `animated` → `relative` + `animation=true`.

The migration slice should warn once for these names, serialize only canonical
values on explicit save, and leave runtime-only commands unable to rewrite
`settings.json` implicitly.

### Removed/stale documentation modes

Startup splash, heartbeat, terminal palette takeover, ambient scene, ANSI/
Braille/cockpit/lighthouse/photon proof surfaces, conversation frame, and other
showcase features are named in `docs/pi-graphics.md` but the current extension
header says they were removed and the source no longer implements them. They
must not be resurrected implicitly. The migration slice should remove stale
claims or label any retained external scripts as explicit offline diagnostics.

## Fullscreen ownership contract

The machine-readable contract is
`extensions/pi-graphics/fullscreen-contract.js`.

1. **One owner, one lease.** Singleton Pi surfaces (editor, footer, header,
   working message/indicator, hardware cursor) are composed through ordered
   leases. A graphics disable releases only the graphics lease; it never writes
   `undefined` over a later owner.
2. **Stable order.** Decorators sort by explicit priority and then registration
   order. Reloading the same owner replaces/reacquires its own lease rather than
   nesting another wrapper.
3. **Namespaced widgets.** Every graphics widget uses a registered
   `pi-graphics-*` id, and teardown clears exactly those ids.
4. **Scoped Kitty ownership.** Every image and placement is registered before
   emission. Replacement deletes the stale placement; final teardown deletes
   image data by owned id. Reserved z-index sweeping remains supplemental for
   real/relative hosted cleanup, never a substitute for Unicode image-id
   deletion.
5. **One timer registry.** Animation, heat/context redraw, delayed command, and
   bounded discovery timers all register with one owner and are cleared on
   disable and `session_shutdown`.
6. **Fullscreen invalidation only.** Decorative updates request a coalescible
   render and invalidate their own component. No cursor movement, scrollback
   writes, or forced full redraw is allowed outside an explicit diagnostic.
7. **Quiet means zero graphics ownership.** `/gfx off` must leave no graphics
   editor/footer/header/working/cursor lease, widget, timer, image, or placement.
   Independent editor chips and other extensions remain installed.
8. **Lifecycle event.** Teardown uses documented `session_shutdown`, covering
   quit, reload, new, resume, and fork. It is idempotent.

`createSurfaceLeaseStack()` provides the pure ordering/removal semantics for the
editor-composition implementation. `fullscreenQuietModeViolations()` defines the
zero-owned-resource invariant for `/gfx off` tests.

## Child implementation map

| Bead | Bounded implementation |
|---|---|
| `bd-5714b0` | Replace direct editor singleton ownership with the lease stack; compose graphics, editor chips, modal editors, and future decorators; add narrow/wide and repeated toggle tests. |
| `bd-a41350` | Move all timers and Kitty/UI resources under one lifecycle owner; switch to `session_shutdown`; make reload/switch/resize teardown idempotent in tmux and non-tmux modes. |
| `bd-73fb63` | Apply canonical mode migration, remove stale mode claims, and prove `/gfx off` owns nothing while unrelated extensions survive. |
| `bd-d23b45` | Add deterministic layout/snapshot matrix plus optional live Kitty smoke instructions for narrow/wide, resize, theme invalidation, overlays, reload/switch, and repeated toggles. |

## Sequencing

1. Land the lease-stack/editor composition slice.
2. Route all resources through lifecycle ownership and correct shutdown events.
3. Apply mode migration and quiet-off semantics on the new ownership model.
4. Lock the result with the visual/layout matrix and update the long-form guide.

This order avoids polishing snapshots of the current last-writer-wins behavior
or adding more cleanup branches before ownership is coherent.
