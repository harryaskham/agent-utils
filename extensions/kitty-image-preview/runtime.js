// In-process bridge for extensions that already own an image file and want the
// fullscreen-aware kitty preview to present it. The WeakMap scopes ownership to
// one Pi runtime and avoids settings mutation or a second graphics lifecycle.

const previewHandlers = new WeakMap();

export function registerKittyImagePreviewRuntime(pi, handler) {
  if (!pi || typeof handler !== "function") return () => {};
  // Reload can briefly construct the replacement extension before the prior
  // generation's shutdown callback runs. Last registration wins, while the
  // identity-guarded disposer below cannot remove that newer owner.
  previewHandlers.set(pi, handler);
  return () => {
    if (previewHandlers.get(pi) === handler) previewHandlers.delete(pi);
  };
}

export async function showInKittyImagePreview(pi, request) {
  const handler = pi ? previewHandlers.get(pi) : undefined;
  if (!handler) return null;
  return handler(request || {});
}
