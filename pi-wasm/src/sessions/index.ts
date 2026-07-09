// pi-wasm S11 (bd-0dc0bc) — keyed multi-session management public surface.
export { SessionRegistry } from "./registry.js";
export type { SessionMeta, PersistedSession } from "./registry.js";
export { SessionManager } from "./session-manager.js";
export type { ActiveSession } from "./session-manager.js";
export { mountSwitcher } from "./switcher-ui.js";
export type { SwitcherHandle, MountSwitcherOptions } from "./switcher-ui.js";
export { idbAvailable } from "./idb.js";
