// Public surface of the pi-wasm exec-backend seam (S13a, bd-4d085a).
export {
  NullExecBackend,
  SHELL_UNAVAILABLE_MESSAGE,
  type ExecBackend,
  type ExecBackendOptions,
  type ExecResult,
} from "./exec-backend";

// Remote tier (S15, bd-ef14af): offload heavy work off-device through a relay.
export {
  RelayExecBackend,
  HttpRelayTransport,
  createHttpRelayExecBackend,
  type RelayTransport,
  type RelayRunRequest,
  type RelayRunHooks,
  type RelayExecResponse,
  type RelayExecBackendOptions,
  type HttpRelayTransportOptions,
} from "./relay-backend";

// microVM tier (S14, bd-c6ffc3): a miniscule in-browser Linux guest (v86) as a
// real exec backend over a serial console. See ../../MICROVM-FEASIBILITY.md.
export {
  MicrovmExecBackend,
  createMicrovmExecBackend,
  frameCommand,
  parseSerialResult,
  BEGIN_RE,
  END_RE,
  type MicrovmMachine,
  type MicrovmExecBackendOptions,
} from "./microvm-backend";

// JS-shell reference tier (S10, bd-ef8f24): coreutils-in-JS over the shared VFS.
export {
  JsShellBackend,
  createJsShellBackend,
  type JsShellBackendOptions,
} from "./js-shell-backend";
