// Pi entry for editor chips. CustomEditor comes from the host bridge, whose
// static import Pi's extension loader maps to the running Pi's own module (see
// lib/pi-host.js), so the chips always decorate the exact host editor class
// across Pi updates. The behaviour lives in lib/editor-chips-extension.js,
// which tests load without the host packages.
import { CustomEditor } from "./lib/pi-host.js";
import { createEditorChipsExtension as createCore } from "./lib/editor-chips-extension.js";

export function createEditorChipsExtension(options = {}) {
  return createCore({ ...options, host: options.host || { CustomEditor, source: "pi-host" } });
}

export default createEditorChipsExtension();
