// Classifiers for realtime `error` events that must NOT fail the pending Pi turn.
//
// The realtime server reports several benign/racy conditions through the same
// generic error channel it uses for fatal errors. Treating them as fatal is what
// used to kill an in-flight turn: failPending() ends the provider stream and
// nulls session.current, after which the still-streaming response's transcript
// deltas are dropped on the floor ("it responds but prints nothing") and the
// audio-turn latch never clears (VAD appears to stop working).
//
// Kept as pure predicates over the server message so they are unit-testable and
// so the (upstream-verbatim, occasionally reworded) strings live in one place.

function text(message) {
  return String(message ?? "");
}

// "Conversation already has an active response in progress: resp_..."
// Raised when a response.create lands while the previous response is still
// open — typically a barge-in where new mic audio committed before the old
// response finished, or a cancel that has not been applied yet.
export function isResponseBusyError(message) {
  const m = text(message);
  return /active response/i.test(m) && /(in progress|already|pending)/i.test(m);
}

// "Cancellation failed: no active response found" — a response.cancel that
// raced a response.done. Nothing to do but note the server is idle.
export function isNoActiveResponseError(message) {
  const m = text(message);
  if (/cancellation failed/i.test(m)) return true;
  return /no active response/i.test(m);
}

const REJECTION_HINT = /unknown parameter|unknown field|unrecognized|unsupported|not supported|invalid[_ ]?(value|parameter|type|request_error)?|unexpected/i;

// The endpoint does not accept response.reasoning / reasoning_effort (older
// realtime deployments and some proxies). Auto-retry without it.
export function isReasoningRejectionError(message) {
  const m = text(message);
  if (!/reasoning/i.test(m)) return false;
  return REJECTION_HINT.test(m);
}

// The endpoint does not accept response.speed.
export function isSpeedRejectionError(message) {
  const m = text(message);
  if (!/\bspeed\b/i.test(m)) return false;
  return REJECTION_HINT.test(m);
}
