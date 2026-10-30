# Plugin-driven session UI over AHP: design audit

Status: proposal (2026-10-30). Nothing here is implemented yet.

## The problem

Our plugins draw their UI in one client at a time. Visual thoughts paints a backdrop in TUI Pi (kitty graphics) and in pi-client panes (`ctx.ui.backdrop()`). The editor chips, the speech indicator, the loops and git chips and the sidebar segments are the same: they are TUI code. The same sessions are also open in clients that see none of it:

- Culture on Android, macOS and iOS, over AHP;
- pi-client `/web` and the `ag` dash;
- anything else on `/chord` or `/ahp`.

"This session's backdrop is now this image" is about the smallest UI change there is. That makes it a good first case for a protocol-backed, client-agnostic way to say it. The aim is a pattern that other plugins can use later, not a special case for backdrops.

## Requirements

1. **State, not events.** A client that connects late, or reconnects, must see the current UI. So the UI is durable session state with a reducer, never a fire-and-forget event stream.
2. **Semantics in the protocol, presentation in the client.** The protocol says *what* (this image, as the backdrop, at about this opacity). Each client decides *how*:
   - TUI Pi keeps its 60 fps worker-rendered transitions;
   - SwiftUI uses `.transition(.opacity)`;
   - the web uses CSS.

   Transitions and effects are at most hints.
3. **Content by reference.** Images travel as portable resources (a URI, media type, size and digest), fetched and cached by digest. State never carries inline base64, local paths or kitty state; see decision 4 in the [AHP surface plan](../ahp-surface-integration-plan.md).
4. **Graceful degradation.** A client that does not understand a slot ignores it. A slot never blocks or breaks a session.
5. **Many producers.** Slots are namespaced and owned, so plugins do not overwrite each other.
6. **Bounded and cheap.** Durable state changes at human rates. A rotation through ten images is one state change listing the set, not ten frame updates. Per-frame or meter-level signals do not belong here.
7. **Demand-aware.** A producer whose output costs money can tell whether anyone renders it. Painting backdrops nobody sees is waste.
8. **Declarative and safe by default.** No arbitrary code. HTML views are opt-in and sandboxed.

## The landscape (checked 2026-10-30)

### AHP: Agent Host Protocol, our transport

- Spec 1.0.0 was released on 2026-10-02 and 1.1.0 is unreleased. pi-daemon still pins the 0.8.0 types.
- **Session `_meta`.** `SessionState._meta` and `SessionSummary._meta` are set through `session/metaChanged`, which replaces the whole value. The spec says clients MAY look for well-known keys in it to provide enhanced UI. pi-daemon already publishes `_meta["pi-daemon"].name` this way.
- **`x-` extensions (0.8).** The `x-` prefix is reserved for implementation-defined channel URI schemes, commands, notifications and actions, "by prior agreement between peers".
- **`InitializeResult._meta` (0.9).** Lets a host advertise extension capabilities.
- **Canvas channels (1.0, experimental).** A chat carries `canvases: CanvasReference[]`. Each `ahp-canvas:` channel holds `{ instanceId, extensionId, canvasId, title, status, url }`, where `url` is an HTTP(S) source the client renders, typically in a side panel. The full proposal, with provider callbacks and in-band content, is issue #297 and PR #298, both still open.
- **MCP Apps.** `McpServerCustomization.mcpApp` plus an `mcp://` side-channel and `_meta.ui.resourceUri` on tool calls render MCP App views.
- **Resources.** `resourceRead` serves session content. pi-daemon serves session media as `ahp-session:/<id>/content/<mediaId>`, which any AHP client can read without a direct route to the host.

### MCP Apps

- SEP-1865 is Final, and spec 2026-01-26 is stable (`io.modelcontextprotocol/ui`).
- Tools reference `ui://` HTML resources, which hosts render in sandboxed iframes.
- Theming flows host to view (`hostContext.theme` and CSS variables). There is nothing for view to host.
- This suits interactive tool UIs in web-capable clients. It cannot render in a TUI, and it is the wrong shape for host chrome such as a backdrop.

### A2UI

- v0.9.1 is in production and v1.0 is a candidate.
- It is a declarative, catalog-checked component language. A surface is managed with `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface`. Data binding means swapping an image is one `updateDataModel`.
- Every scope has namespaced `metadata.extensions` (for example `com_example_x`).
- 1.0 dropped theme properties so that native renderers style things themselves.
- Renderers:

  | Renderer | Status |
  |---|---|
  | React, Lit, Angular | stable |
  | SwiftUI (iOS and macOS) | alpha |
  | Jetpack Compose (Android) | alpha, in androidx |
  | Flutter | stable |

  These cover Culture's platforms. A TUI renderer would be ours.
- It is transport-agnostic: A2A, AG-UI and MCP bindings exist.
- The basic catalog's `Image` has `url`, which can be bound to the data model, and `fit` (`cover`, `contain` and so on).

### AG-UI

- 1.0 was announced as frozen on 2026-09-18.
- It is an agent-to-frontend event stream. `STATE_SNAPSHOT` and `STATE_DELTA` (JSON Patch) share agent state, `CUSTOM` carries app events, and it often transports A2UI.
- It covers the same ground as AHP's state sync. Per the existing [AHP surface plan](../ahp-surface-integration-plan.md), AG-UI is at most a derived projection for clients that speak it, never an authority.

### Our own

- **Durable documents.** pi-daemon `/chord` has plugin-defined documents (`{ kind, version, scope }`, `session.document` and `session.watchDocument`). The MCP view's state already works this way. The catch: only `/chord` clients see them.
- **Pane backdrops.** pi-client's `ctx.ui.backdrop()` is a client-local render API, not shared state.

## The options for "this session has backdrop X"

| Option | Reach today | Renders natively (TUI too) | Standard | Fit |
|---|---|---|---|---|
| AHP session `_meta` well-known key | every AHP client already receives it | yes: the client maps a small JSON value | spec-sanctioned extension point | **good for small, coarse state** |
| AHP `x-pi-ui:` channel (own state and actions) | clients that opt in and subscribe | yes | implementation-defined | **good for rich or interactive surfaces** |
| AHP canvas (`ahp-canvas:`) | Culture once it renders canvases | no: URL or HTML side panel | experimental, upstream | wrong shape (URL, panel) |
| MCP Apps (`ui://`) | web-capable AHP clients | no: iframe | stable | wrong shape (tool-scoped HTML) |
| A2UI surface | needs a transport (rides on any of the above) | yes: native catalogs, TUI renderer to write | v1.0 candidate | **good as the content format** |
| AG-UI state | needs a second protocol or bridge | yes | 1.0 | redundant with AHP |
| `/chord` Durable document | pi-client, `/web`, our tools | yes | ours | **good as the source of truth**, not as the wire to Culture |

These are not exclusive. They answer three different questions:

- Where the state lives: a Durable document.
- How it reaches clients: AHP, through `_meta` now and an `x-` channel later.
- What format it is in: plain JSON for the simple slots, A2UI when a surface has components.

## Proposed design

### 1. Session UI slots: one semantic model

A session has named **UI slots**. Each slot is owned by one producer and holds a small, typed value, with a revision so clients can drop stale updates:

```jsonc
{
  "slots": {
    "backdrop": {
      "owner": "agent-utils/visual-thoughts",
      "rev": 42,
      "kind": "image-set",
      "images": [                                  // the current set, newest last
        { "uri": "ahp-session:/<sid>/content/<mediaId>",
          "mimeType": "image/png", "width": 1536, "height": 1024,
          "digest": "sha256:…", "alt": "a droplet on a midnight pond" }
      ],
      "current": 3,                                // index into images (producer's choice)
      "hints": {                                   // presentation suggestions only
        "placement": "backdrop",                  // behind the transcript
        "opacity": 0.3, "fit": "cover", "feather": 0.12,
        "cycleMs": 18000,                          // clients may rotate locally
        "transition": "crossfade"                 // "crossfade" | "cut" | "any"
      }
    }
  }
}
```

- **Placement vocabulary.** Clients map each placement to native UI and ignore any they do not know:
  - `backdrop`: behind the transcript;
  - `status`: a chip or status line;
  - `badge`: on the session list;
  - `panel`: a side panel;
  - `inline`: already AHP response parts, not a slot.
- **Rotation.** The slot carries the set and a cycle hint, so every client rotates locally. A rotation costs no messages. `current` changes only when the producer wants everyone on the same image, for example a new painting.
- **Effects stay local.** TUI Pi keeps its 60 fps ripple, wave and dissolve. Other clients do what suits them: SwiftUI crossfades, the web does a CSS opacity transition, and a phone may simply cut. `hints.transition` is a suggestion.

### 2. Source of truth: a Durable document per session

- The plugin's server-side part, a pi-daemon Durable module, owns the document `{ kind: "pi.ui", version: 1, scope: "session" }`.
- Plugins get a small producer API: `ui.set(slot, value)` and `ui.clear(slot)`. It is bounded (slot count, bytes, update rate) and checks ownership.
- In a TUI Pi session (not daemon-hosted), the agent-utils runtime keeps the same model in-process, and the pi-daemon bridge projects it the same way.
- **Painting moves to the server, once per session.** Today every client paints for itself: TUI Pi, and each pi-client pane through `ctx.ui.backdrop()`. With the move, TUI Pi, pi-client, `/web` and Culture become renderers of the same slot. The images are stored as session media, so they are portable through `resourceRead`.

### 3. On the wire: AHP, in two steps

**Now: no spec change.**
- Project the slots into `SessionState._meta["pi-daemon/ui"]` through `session/metaChanged`.
- Merge on write, because the action replaces the whole `_meta`. Throttle to human rates.
- Images are session media URIs that every AHP client can `resourceRead`, cached by digest.
- Put a tiny badge subset (for example the current backdrop's URI) in `SessionSummary._meta` so session lists can show a thumbnail without subscribing.

**Later: rich or interactive surfaces.**
- An `x-pi-ui:/<sessionId>` channel: a state tree of slots or surfaces with its own actions, such as `x-pi-ui/slotSet`, `x-pi-ui/slotRemoved`, and client-to-host `x-pi-ui/action` for interaction.
- It is discovered through a reference in `_meta["pi-daemon/ui"].channel`, and capabilities are advertised in `InitializeResult._meta`.
- Clients that subscribe pay; others see nothing.

### 4. Content format: plain values first, A2UI for components

- Simple slots (`backdrop`, `status`, `badge`) stay plain JSON, as above. Every client can render them with no new dependency, and a TUI maps them directly.
- Slots with real components (a gallery panel, a form, a dashboard) carry an **A2UI surface** instead:
  - `{ "kind": "a2ui", "messages": [createSurface …, updateComponents …], "dataModel": {…} }`;
  - placement and opacity go in surface `metadata.extensions.com_harryaskham_pi_ui`;
  - Culture uses the SwiftUI and Compose renderers, `/web` uses Lit or React, and pi-client needs a small TUI renderer for the basic catalog.
- Even the backdrop maps cleanly onto A2UI: a basic-catalog `Image` (`fit: "cover"`, `url` bound to `/image/url`) on a surface with `placement: "backdrop"`, swapped with `updateDataModel`. That is the migration path if slots become A2UI-first.
- MCP Apps stay where they belong: interactive tool views in web-capable clients. Canvas stays where it belongs: URL-backed side panels.

### 5. Demand: is anyone rendering?

- Clients that render slots say so: AHP `InitializeParams._meta` or the client's entry in `SessionState.activeClients`, and on `/chord` the document watch itself.
- The host exposes `consumers: { backdrop: n }` in the document.
- Visual thoughts paints only while someone renders backdrops: TUI Pi in fullscreen, a pi-client pane, a Culture view. A headless session or a phone in someone's pocket costs nothing.

### 6. Upstream

Once this works end to end, propose to AHP a standard form of what we built under `x-`: **session presentation slots**. That generalizes the canvas proposal (#297) beyond URLs:

```
content: { kind: "image", resource } | { kind: "a2ui", … } | { kind: "url", url }
placement: hint
```

Until then, `_meta["pi-daemon/ui"]` and `x-pi-ui:` stay ours, as the spec allows.

## Plugins that would move to slots

| Plugin | Today | Slot |
|---|---|---|
| visual thoughts | TUI kitty and the pi-client pane backdrop | `backdrop` (image set) |
| speech indicator (`/ptt`, `/stt`, `/rt`) | editor chip | `status` (coarse phase only; the meter stays local) |
| loops chip | editor chip (pi-daemon `/loop`) | `status` / `badge` |
| git chip (pi-git) | editor chip, sidebar segment | `badge` (branch, ±diff) |
| sidebar segments | pi-client only | `badge` in `SessionSummary._meta` |
| gallery and audio reel | `/chord` media, then widgets | already session media; a `panel` slot as an A2UI list |
| choices | AHP `inputNeeded` | already standard; nothing to do |
| editor chips (model, effort, cost) | derived from session state | nothing: clients derive them from AHP state |

The rule: durable, coarse, shared state goes in slots. High-frequency signals (meters, typing heat, frames) stay local to the client that produces them.

## Open questions

- **`_meta` size and churn.** It is replaced whole and mirrored into catalogs. Keep the projected slots small and move rich content to the `x-` channel early.
- **Per-chat slots.** AHP has chats; does a backdrop belong to the session or to the chat in view? Probably session first, with an optional `chat` field.
- **Producer authority.** Only host-side modules write slots, or may AHP clients set them too, for example a user-chosen backdrop?
- **Privacy.** Slot content is shared with every client of the session. Incognito sessions publish none.
- **A2UI version.** Pin v0.9.1 or wait for v1.0? Write the TUI renderer only when a slot first needs components.
