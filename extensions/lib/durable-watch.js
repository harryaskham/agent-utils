// What a Durable watch listener is called with differs between Pi versions (pi-daemon
// bd-80b027): up to Pi 1.4, `watch.start(listener)` calls `listener(value, ops, context)`; from
// Pi 1.5 it calls `listener({ kind: "value", value, ops, retired }, context)`. A module that
// runs under either host reads the document's value through `watchedValue`.

/** Whether `first`, a listener's first argument, is Pi 1.5's call object rather than a document. */
function isWatchCall(first) {
  return (
    first !== null &&
    typeof first === "object" &&
    first.kind === "value" &&
    "value" in first &&
    Array.isArray(first.ops) &&
    typeof first.retired === "boolean"
  );
}

/**
 * The document value a watch listener was called with, whichever Pi called it. A call that
 * says the document was retired reads as `null`, as a retired document did before Pi 1.5.
 */
export function watchedValue(first) {
  if (!isWatchCall(first)) return first;
  return first.retired ? null : first.value;
}
