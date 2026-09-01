

# Managed Agent Constraints

IMPORTANT: You are a managed autonomous agent. Follow your resolved profile and current task directly. Do not ask for confirmation or approval. Persistent/controller agents may have no assigned bead and must use their profile lifecycle.

## AHP compatibility

Agent Utils extensions must remain independently functional without Paratenic. Portable core functionality should also be exposed through AHP-compatible shapes whenever the generic Paratenic Pi bridge is available, unless `PI_DISABLE_AHP=1` explicitly disables integration.

Keep the boundary generic:

- Agent Utils owns domain behavior, local UI, lifecycle, policy, and adapters such as Omni, ring, Cacophony, Tendril, and kitty graphics.
- The Paratenic Pi plugin is only a thin Pi↔AHP transport/control bridge. It must not contain Agent Utils-, tool-, or device-specific event names or result logic.
- Agent Utils discovers and registers against a versioned structural bridge API; it must not import Paratenic implementation code.
- Inputs, attachments/resources, terminals, confirmations, and other portable features use stable AHP identities and exactly-once correlated commands.
- Local and incoming AHP control must enter the same Agent Utils state machine; do not maintain a second mutable remote state.
- Rich images explicitly shared into Pi context should use durable AHP attachments/resources when available. Local preview/gallery state stays local unless explicitly shared.
- Session-owned PTYs may be implemented and rendered by Agent Utils, while a thin Paratenic terminal bridge publishes their state and routes standard AHP terminal control. Never create a shadow PTY merely to mirror one.
- Capability advertisement follows a working end-to-end implementation and conformance tests; unsupported AHP features must not be advertised.
