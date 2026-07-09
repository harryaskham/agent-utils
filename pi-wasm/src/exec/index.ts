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
