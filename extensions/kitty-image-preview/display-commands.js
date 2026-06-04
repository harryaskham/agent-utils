// Kitty escape-sequence command builders for the image preview, extracted from
// kitty-image-preview.js (bd-e1914a). Both are pure over their (state, …) inputs
// plus the kitty-graphics primitives; buildCurrentDisplayCommand memoizes the
// rendered command on state.currentCommand.rendered to avoid recomputing
// identical transmit/display sequences. In unicode-placeholder mode it also
// applies a transmit-once / placement-only-on-repaint guard so the PNG payload
// is uploaded only once per (image id + signature) and re-emitted only on a
// terminal reattach or content change (bd-d6fa1b).

import {
  buildPngDisplayCommand,
  buildPngVirtualPlacementCommand,
  buildScopedDeleteCommand as buildScopedDeleteCommandRaw,
} from "../kitty-graphics.js";

export function buildScopedDeleteCommand(state, { excludeIds = [] } = {}) {
  return buildScopedDeleteCommandRaw({
    ownedImageIds: state.ownedImageIds,
    placementId: state.config.placementId,
    passthrough: state.config.passthrough,
    excludeIds,
  });
}

// Transmit-once / placement-only-on-repaint guard for the unicode-placeholder
// path (bd-d6fa1b). In unicode mode the image is resolved by the placeholder
// cells that renderCurrentImageLines emits on every frame, so the base64 PNG
// payload only needs to reach the terminal once per (image id + render
// signature). Re-emitting the full a=T upload on every repaint wastes SSH
// bandwidth and, under tmux passthrough, re-sends data that a freshly attached
// kitty client may already hold. We therefore transmit the payload the first
// time a given signature is rendered and emit an empty command prefix on
// subsequent repaints; the placeholder cells carry the placement.
//
// Re-transmit triggers fall out of the signature key: a new image id, transport
// change, geometry change, or config change all produce a new signature. A
// terminal (re)attach or session_start restore must clear the guard explicitly
// via resetTransmissionGuard so the new terminal — which does not hold the
// image — receives a fresh upload.
function transmissionGuard(state) {
  state.transmittedSignatures ||= new Map();
  return state.transmittedSignatures;
}

export function resetTransmissionGuard(state) {
  if (!state) return;
  state.transmittedSignatures = new Map();
}

export function buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders = false) {
  const prepared = state.currentCommand;
  if (!prepared || prepared.itemId !== current.id) return "";
  const placementMode = useUnicodePlaceholders ? "unicode" : "cursor";
  const signature = `${columns}:${rows}:${prepared.zIndex}:${prepared.transport}:${prepared.passthrough}:${prepared.chunkSize}:${placementMode}:${state.config.placementId}`;
  if (prepared.rendered?.signature === signature) return prepared.rendered.command;

  // Unicode mode decouples transmission from placement: once the payload for a
  // signature has been transmitted, repaints emit nothing here because the
  // placeholder cells (emitted every frame elsewhere) re-create the placement.
  if (useUnicodePlaceholders) {
    const guard = transmissionGuard(state);
    const guardKey = `${current.id}:${signature}`;
    if (guard.get(current.id) === guardKey) {
      prepared.rendered = { signature, command: "" };
      return "";
    }
    const command = buildPngVirtualPlacementCommand({
      imageId: current.id,
      placementId: state.config.placementId,
      pngBase64: prepared.pngBase64,
      filePath: prepared.filePath,
      columns,
      rows,
      passthrough: prepared.passthrough,
      chunkSize: prepared.chunkSize,
    });
    guard.set(current.id, guardKey);
    // Do not memoize the upload itself: the very next repaint at this signature
    // must fall through to the guard hit above and emit an empty prefix so the
    // payload is transmitted exactly once. Leaving rendered unset keeps the
    // top-of-function memo from replaying the upload bytes.
    prepared.rendered = undefined;
    return command;
  }

  const command = buildPngDisplayCommand({
    imageId: current.id,
    placementId: state.config.placementId,
    pngBase64: prepared.pngBase64,
    filePath: prepared.filePath,
    columns,
    rows,
    zIndex: prepared.zIndex,
    passthrough: prepared.passthrough,
    chunkSize: prepared.chunkSize,
  });
  prepared.rendered = { signature, command };
  return command;
}
