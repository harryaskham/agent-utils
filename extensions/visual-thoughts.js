// Pi entry for visual thoughts. The terminal's cell size comes from the running Pi's own pi-tui
// through the host bridge (lib/pi-host.js), whose static imports Pi's extension loader maps to
// Pi's modules (pi-client maps them to its own). The behaviour lives in
// lib/visual-thoughts-extension.js, which tests load without the host packages.
import { getCellDimensions } from "./lib/pi-host.js";
import { createVisualThoughtsExtension as createCore } from "./lib/visual-thoughts-extension.js";

export function createVisualThoughtsExtension(options = {}) {
  return createCore({ ...options, host: options.host || { cellSize: getCellDimensions } });
}

export default createVisualThoughtsExtension();
