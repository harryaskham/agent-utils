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
import { clearOwnedImageIds } from "./state.js";

// Resolve a direct terminal writer from a Pi context, independent of whether a
// UI/widget surface is mounted. Mirrors pi-graphics' resolveGraphicsWriter so
// the preview can flush a kitty free (d=I) on a HEADLESS shutdown, where the
// widget-based flashDeleteWidget path early-returns without a UI and would
// otherwise leave the terminal's image data resident. Returns null when no
// writer is reachable (best-effort robustness, bd-ded98d element (e)).
export function resolveGraphicsWriter(ctx) {
  if (typeof ctx?.ui?.write === "function") return ctx.ui.write.bind(ctx.ui);
  if (typeof ctx?.ui?.terminal?.write === "function") return ctx.ui.terminal.write.bind(ctx.ui.terminal);
  if (typeof ctx?.terminal?.write === "function") return ctx.terminal.write.bind(ctx.terminal);
  return null;
}

// Free all owned preview image DATA (d=I) and emit the delete through a non-UI
// writer. Used by the headless branch of session_shutdown: flashDeleteWidget
// early-returns when there is no UI, so without this a no-UI preview session
// would forget the owned ids without telling the terminal to reclaim them.
// Mirrors the hasUI teardown (releaseOwnedImageData -> clearOwnedImageIds ->
// emit), but routes the emit through resolveGraphicsWriter instead of a widget.
// Returns the emitted command ("" when nothing was owned). Soft-fails when no
// writer is reachable -- robustness-only, since the restart-overwrite reclaim
// already bounds the realistic UI case (bd-ded98d element (e)).
export function runHeadlessOwnedFree(ctx, state) {
  const command = releaseOwnedImageData(state, { keepIds: [] });
  clearOwnedImageIds(state);
  if (command) {
    try { resolveGraphicsWriter(ctx)?.(command); } catch {}
  }
  return command;
}

export function buildScopedDeleteCommand(state, { excludeIds = [], freeData = false } = {}) {
  return buildScopedDeleteCommandRaw({
    ownedImageIds: state.ownedImageIds,
    placementId: state.config.placementId,
    passthrough: state.config.passthrough,
    excludeIds,
    // freeData=true frees each owned image's stored data (d=I) instead of only
    // deleting its placement (d=i) — used by the cross-generation startup
    // reclaim and teardown paths (bd-b94fa1 / bd-b257e8).
    freeData,
  });
}

// Free the terminal's stored image DATA (uppercase kitty delete d=I) for owned
// preview images that are no longer needed, then stop tracking them. Unlike the
// placement-only lowercase delete used for transient hide / in-session
// navigation (where the image may be shown again and a cheap placement-only
// delete avoids a re-upload), this reclaims the IOSurface/GPU memory the
// terminal holds per image. It fixes the unbounded growth where
// state.ownedImageIds accrues every image id ever shown (replaceItems keeps old
// ids on purpose) and the terminal image store therefore grows without bound on
// long-running/backgrounded sessions (bd-b94fa1).
//
// Images whose id is in keepIds are retained; every other owned id is freed
// (d=I removes its placement AND frees its data), removed from
// state.ownedImageIds, and has its transmit-once guard entry cleared so a later
// re-add re-uploads the bytes. The upload-cache (transmittedSignatures)
// invalidation is REQUIRED: d=I also drops the data, so without it the next show
// would emit only a placement against freed data and render nothing (tofu).
// Callers that free data for the CURRENT image must also invalidate
// state.currentCommand so the next prepare re-uploads.
export function releaseOwnedImageData(state, { keepIds = [] } = {}) {
  const owned = state?.ownedImageIds;
  if (!owned || typeof owned[Symbol.iterator] !== "function") return "";
  const keep = new Set(keepIds);
  const freed = [];
  for (const id of owned) if (!keep.has(id)) freed.push(id);
  if (freed.length === 0) return "";
  const command = buildScopedDeleteCommandRaw({
    ownedImageIds: freed,
    placementId: state.config?.placementId,
    passthrough: state.config?.passthrough,
    freeData: true,
  });
  const guard = state.transmittedSignatures;
  for (const id of freed) {
    owned.delete?.(id);
    guard?.delete?.(id);
  }
  return command;
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

// `prepared` is the prepared payload for `current`; it defaults to the single
// state.currentCommand (the legacy single-image path) but the multi-image side
// panel passes a per-entry payload so each packed-page image transmits from its
// own prepared bytes while sharing the id-keyed transmit-once guard (bd-502d6a
// C-wire). All existing call sites omit the argument and keep the prior
// behaviour exactly.
export function buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders = false, prepared = state.currentCommand) {
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
