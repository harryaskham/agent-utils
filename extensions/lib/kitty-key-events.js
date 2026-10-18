// Kitty keyboard protocol event-type predicates for raw terminal input.
//
// With the Kitty protocol's event-type flag enabled, repeats and releases are
// reported with an `:2` / `:3` event-type suffix on CSI-u, functional (`~`) and
// arrow/home/end sequences. These mirror `isKeyRepeat` / `isKeyRelease` from
// `@earendil-works/pi-tui` (a host peer dependency) so input handlers stay
// synchronous and the extension loads without the host package installed.
// test/kitty-key-events.test.js checks parity with pi-tui when it is available.

const BRACKETED_PASTE_START = "\x1b[200~";
const EVENT_TYPE_TERMINATORS = ["u", "~", "A", "B", "C", "D", "H", "F"];

function hasEventType(data, eventType) {
  const text = String(data ?? "");
  // Pasted text is never a key event, even if it contains a matching suffix.
  if (text.includes(BRACKETED_PASTE_START)) return false;
  return EVENT_TYPE_TERMINATORS.some((terminator) => text.includes(`:${eventType}${terminator}`));
}

export function isKeyRepeat(data) {
  return hasEventType(data, 2);
}

export function isKeyRelease(data) {
  return hasEventType(data, 3);
}
