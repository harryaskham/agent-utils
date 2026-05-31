// Kitty escape-sequence command builders for the image preview, extracted from
// kitty-image-preview.js (bd-e1914a). Both are pure over their (state, …) inputs
// plus the kitty-graphics primitives; buildCurrentDisplayCommand memoizes the
// rendered command on state.currentCommand.rendered to avoid recomputing
// identical transmit/display sequences.

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

export function buildCurrentDisplayCommand(state, current, columns, rows, useUnicodePlaceholders = false) {
  const prepared = state.currentCommand;
  if (!prepared || prepared.itemId !== current.id) return "";
  const placementMode = useUnicodePlaceholders ? "unicode" : "cursor";
  const signature = `${columns}:${rows}:${prepared.zIndex}:${prepared.transport}:${prepared.passthrough}:${prepared.chunkSize}:${placementMode}:${state.config.placementId}`;
  if (prepared.rendered?.signature === signature) return prepared.rendered.command;
  const command = useUnicodePlaceholders
    ? buildPngVirtualPlacementCommand({
      imageId: current.id,
      placementId: state.config.placementId,
      pngBase64: prepared.pngBase64,
      filePath: prepared.filePath,
      columns,
      rows,
      passthrough: prepared.passthrough,
      chunkSize: prepared.chunkSize,
    })
    : buildPngDisplayCommand({
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
