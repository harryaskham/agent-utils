// Bounded external-HTTP helpers for the web-search tool (bd-6cf0d6). The
// implementation now lives in the shared ./lib/bounded-exec.js so the timeout /
// AbortController pattern has ONE home across web-search, batch STT, and batch
// TTS (bd-29a134). This module re-exports it for backward compatibility so the
// web-search entrypoint and its tests keep importing from here.

export {
  DEFAULT_REQUEST_TIMEOUT_MS,
  resolveRequestTimeoutMs,
  combineTimeoutSignal,
} from "./lib/bounded-exec.js";
